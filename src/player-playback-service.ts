import crypto from 'node:crypto'
import { isCanonicalVideoCode } from './video-library'
import type { VideoLibraryService } from './video-library-service'
import {
  PlayerPlaybackError,
  type PlayerMediaSourceProvider,
  type PlayerPlaybackEvent,
  type PlayerPlaybackErrorCode,
  type PlayerPlaybackHost,
  type PlayerPlaybackHostCommand,
  type PlayerPlaybackHostEvent,
  type PlayerPlaybackListener,
  type PlayerPlaybackPersistence,
  type PlayerPlaybackPersistenceTransition,
  type PlayerPlaybackProgress,
  type PlayerPlaybackState
} from './player-playback-contracts'

interface ActiveAttempt {
  attemptId: string
  hostEpoch: string
  musicCode: string
  inventoryRevision: string
  mediaGrant?: ReturnType<PlayerMediaSourceProvider['grant']>
  lastSequence: number
  sawPlaying: boolean
  pauseRequested: boolean
  terminal: boolean
}

interface ReservedAttempt {
  attempt: ActiveAttempt
  host: PlayerPlaybackHost
}

interface PreparedMedia {
  snapshot: ReturnType<VideoLibraryService['getSnapshot']>
  opened: Extract<Awaited<ReturnType<VideoLibraryService['openForPlayback']>>, { status: 'available' }>
}

interface ReservationIntent {
  generation: number
  host: PlayerPlaybackHost
  inventoryRevision?: string
  validateBeforeCommit?: () => void
  recoveryAttemptId?: string
}

function unavailableError(status: string): PlayerPlaybackError {
  if (status === 'missing' || status === 'unreadable' || status === 'invalid-code') {
    return new PlayerPlaybackError('MEDIA_UNAVAILABLE', 'A mídia local não está disponível para reprodução.')
  }
  if (status === 'ambiguous') return new PlayerPlaybackError('MEDIA_AMBIGUOUS', 'Há mais de um vídeo indexado para este código.')
  return new PlayerPlaybackError('MEDIA_UNKNOWN', 'A disponibilidade do vídeo não pôde ser confirmada.')
}

/** Main-owned orchestration. It never mutates Controller queue, presentation, history, or SQLite state. */
export class PlayerPlaybackService {
  private state: PlayerPlaybackState = { status: 'idle' }
  private active: ActiveAttempt | undefined
  private host: PlayerPlaybackHost | undefined
  private unsubscribeHost: (() => void) | undefined
  private readonly listeners = new Set<PlayerPlaybackListener>()
  private operationTail: Promise<void> = Promise.resolve()
  private disposed = false
  private disposeRequested = false
  private disposePromise: Promise<void> | undefined
  private commandGeneration = 0
  private lastSelectedCode: string | undefined
  private latestRequestedCode: string | undefined
  private stopOperation: Promise<PlayerPlaybackState> | undefined
  private stopOperationAttemptId: string | undefined
  private progress: PlayerPlaybackProgress | undefined

  constructor(
    private readonly library: VideoLibraryService,
    private readonly mediaSources: PlayerMediaSourceProvider,
    private readonly persistence?: PlayerPlaybackPersistence
  ) {}

  attachHost(host: PlayerPlaybackHost): void {
    if (this.disposeRequested || this.disposed) throw new PlayerPlaybackError('DISPOSED', 'O serviço de reprodução já foi encerrado.')
    if (this.host === host) return
    if (this.host) throw new PlayerPlaybackError('INVALID_STATE', 'Já existe um host de reprodução conectado.')
    this.host = host
    this.unsubscribeHost = host.subscribe(event => this.handleHostEvent(event))
    void host.ready.catch(() => undefined)
  }

  /** Waits until this host's termination is reflected by the serialized service state. */
  async releaseHost(hostEpoch: string): Promise<void> {
    await this.enqueue(() => {
      if (this.host?.hostEpoch === hostEpoch) this.detachHost('host-terminated')
    })
  }

  getState(): PlayerPlaybackState {
    return { ...this.state }
  }

  assertPlaybackAllowed(): void {
    this.persistence?.assertPlaybackAllowed?.()
    if (this.state.status === 'uncertain' || this.state.status === 'disposed') {
      throw new PlayerPlaybackError(this.state.errorCode === 'RECOVERY_PERSISTENCE_FAILED'
        ? 'RECOVERY_PERSISTENCE_FAILED' : 'RECOVERY_PENDING',
      'A reprodução está bloqueada até que o estado anterior seja resolvido.')
    }
  }

  getProgress(): PlayerPlaybackProgress | null {
    if (!this.progress || this.progress.attemptId !== this.state.attemptId) return null
    return { ...this.progress }
  }

  /** Clears only the media element associated with a durably confirmed natural EOF. */
  async clearCompletedMedia(expectedAttemptId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(expectedAttemptId)) return false
    return this.enqueue(async () => {
      this.ensureNotDisposed()
      if (this.active || this.state.status !== 'completed' || this.state.attemptId !== expectedAttemptId) return false
      const host = this.host
      if (!host) return false
      try {
        await host.send({ type: 'clear', commandId: crypto.randomUUID(), attemptId: expectedAttemptId })
      } catch (error) {
        // EOF remains durably confirmed. If the Renderer cannot acknowledge
        // clearing its last frame, destroy only this owned surface so a frozen
        // image cannot remain on screen or be mistaken for active playback.
        if (this.host !== host) return true
        let terminated = false
        try { terminated = await host.terminate() } catch { /* An unconfirmed host termination is a containment failure. */ }
        if (terminated) {
          if (this.host === host && this.state.status === 'completed' && this.state.attemptId === expectedAttemptId) {
            this.detachHost('host-terminated')
          }
          return true
        }
        if (this.host === host && this.state.status === 'completed' && this.state.attemptId === expectedAttemptId) {
          this.emit({ type: 'surface-cleanup-failed', attemptId: expectedAttemptId,
            musicCode: this.state.musicCode!, errorCode: 'HOST_CONTAINMENT_FAILED' })
        }
        throw new PlayerPlaybackError('HOST_CONTAINMENT_FAILED',
          error instanceof Error ? `The completed video could not be cleared or its host closed: ${error.message}`
            : 'The completed video could not be cleared or its host closed.')
      }
      if (this.active || this.state.status !== 'completed' || this.state.attemptId !== expectedAttemptId || this.host !== host) return false
      this.progress = undefined
      this.latestRequestedCode = undefined
      this.lastSelectedCode = undefined
      this.setState({ status: 'idle' })
      return true
    })
  }

  /** Revalidates indexed local availability without selecting or starting media. */
  async validateMusicCode(value: unknown): Promise<void> {
    if (!isCanonicalVideoCode(value)) {
      throw new PlayerPlaybackError('INVALID_MUSIC_CODE', 'O código de vídeo precisa conter exatamente cinco dígitos.')
    }
    const snapshot = this.library.getSnapshot()
    if (snapshot.scanStatus !== 'ready') throw unavailableError('unknown')
    const opened = await this.library.openForPlayback(value, snapshot.revision)
    if (opened.status !== 'available') throw unavailableError(opened.status)
    try {
      const current = this.library.getSnapshot()
      if (current.scanStatus !== 'ready' || current.revision !== snapshot.revision || opened.revision !== snapshot.revision) {
        throw unavailableError('unknown')
      }
    } finally {
      await opened.handle.close().catch(() => undefined)
    }
  }

  subscribe(listener: PlayerPlaybackListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Loads an already canonical five-digit library code; it does not start playback. */
  async load(value: unknown): Promise<PlayerPlaybackState> {
    if (!isCanonicalVideoCode(value)) {
      throw new PlayerPlaybackError('INVALID_MUSIC_CODE', 'O código de vídeo precisa conter exatamente cinco dígitos.')
    }
    this.ensureNotDisposed()
    this.persistence?.assertPlaybackAllowed?.()
    const generation = ++this.commandGeneration
    this.latestRequestedCode = value
    const host = this.host
    if (!host) throw new PlayerPlaybackError('HOST_UNAVAILABLE', 'Não há uma janela de reprodução conectada.')
    try { await host.ready } catch { throw new PlayerPlaybackError('HOST_UNAVAILABLE', 'A janela de reprodução não ficou disponível.') }
    let prepared: PreparedMedia
    try { prepared = await this.prepareMedia(value) } catch (error) {
      this.clearFailedSelectionIntent(value, generation)
      throw error
    }
    try {
      const reservation = await this.reserveAttempt(value, 'replace', {
        generation, host, inventoryRevision: prepared.snapshot.revision
      })
      return await this.loadPrepared(value, reservation, prepared)
    } catch (error) {
      await prepared.opened.handle.close().catch(() => undefined)
      throw error
    }
  }

  private async loadPrepared(value: string, reservation: ReservedAttempt, prepared?: PreparedMedia): Promise<PlayerPlaybackState> {
    let grant: ReturnType<PlayerMediaSourceProvider['grant']> | undefined
    try {
      const media = prepared ?? await this.prepareMedia(value)
      try {
        if (media.opened.revision !== reservation.attempt.inventoryRevision ||
            this.library.getSnapshot().revision !== media.snapshot.revision) throw unavailableError('unknown')
      } finally {
        await media.opened.handle.close().catch(() => undefined)
      }
      const mediaGrant = this.mediaSources.grant(value, media.snapshot.revision)
      grant = mediaGrant
      const send = await this.enqueue(() => {
        this.ensureCurrent(reservation)
        reservation.attempt.mediaGrant = mediaGrant
        return { promise: reservation.host.send({
          type: 'load', commandId: crypto.randomUUID(), attemptId: reservation.attempt.attemptId,
          musicCode: value, mediaUrl: mediaGrant.url
        }) }
      })
      await send.promise
      const state = this.getState()
      if (state.attemptId !== reservation.attempt.attemptId) {
        throw new PlayerPlaybackError('SUPERSEDED', 'A seleção foi substituída antes da confirmação do carregamento.')
      }
      return state
    } catch (error) {
      grant?.revoke()
      await this.failAttempt(reservation, error)
      throw error
    }
  }

  /** Resolves and starts one canonical video as a single correlated operation. */
  async playImmediately(
    value: unknown,
    validateBeforeCommit?: () => void,
    recoveryAttemptId?: string
  ): Promise<PlayerPlaybackState> {
    if (!isCanonicalVideoCode(value)) {
      throw new PlayerPlaybackError('INVALID_MUSIC_CODE', 'O código de vídeo precisa conter exatamente cinco dígitos.')
    }
    this.ensureNotDisposed()
    this.persistence?.assertPlaybackAllowed?.(recoveryAttemptId)
    const generation = ++this.commandGeneration
    this.latestRequestedCode = value
    const host = this.host
    if (!host) throw new PlayerPlaybackError('HOST_UNAVAILABLE', 'Não há uma janela de reprodução conectada.')
    try { await host.ready } catch { throw new PlayerPlaybackError('HOST_UNAVAILABLE', 'A janela de reprodução não ficou disponível.') }
    let prepared: PreparedMedia
    try { prepared = await this.prepareMedia(value) } catch (error) {
      this.clearFailedSelectionIntent(value, generation)
      throw error
    }
    let reservation: ReservedAttempt | undefined
    let attemptId: string | undefined
    try {
      reservation = await this.reserveAttempt(value, 'replace', {
        generation, host, inventoryRevision: prepared.snapshot.revision, validateBeforeCommit, recoveryAttemptId
      })
      const loaded = await this.loadPrepared(value, reservation, prepared)
      attemptId = loaded.attemptId
      if (!attemptId) throw new PlayerPlaybackError('PLAYBACK_FAILED', 'A tentativa de reprodução não foi criada.')
      await this.waitForAttemptState(attemptId, 'ready', 30000)
      const starting = await this.sendCurrentCommand('play', ['ready'], attemptId)
      if (starting.attemptId !== attemptId) throw new PlayerPlaybackError('SUPERSEDED', 'A tentativa foi substituída antes do início.')
      return await this.waitForAttemptState(attemptId, 'playing', 15000)
    } catch (error) {
      await prepared.opened.handle.close().catch(() => undefined)
      if (attemptId && error instanceof PlayerPlaybackError && error.code === 'COMMAND_TIMEOUT') {
        const containment = await this.enqueue(() => {
          const active = this.active
          return active && active.attemptId === attemptId
            ? this.markUncertain(active, 'command-outcome-unknown', true, error.code)
            : undefined
        })
        if (containment) await this.containUncertainAttempt(containment.attempt, containment.host, true)
      } else if (attemptId && error instanceof PlayerPlaybackError && error.code === 'MEDIA_LOAD_FAILED') {
        await this.enqueue(() => {
          const active = this.active
          if (!active || active.attemptId !== attemptId) return
          active.terminal = true
          active.mediaGrant?.revoke()
          this.active = undefined
          this.setState({ status: 'failed', attemptId, musicCode: active.musicCode, errorCode: 'MEDIA_LOAD_FAILED' })
          this.emit({ type: 'error', attemptId, musicCode: active.musicCode, errorCode: 'MEDIA_LOAD_FAILED' })
        })
      } else if (reservation) {
        await this.failAttempt(reservation, error)
      }
      throw error
    }
  }

  async play(): Promise<PlayerPlaybackState> {
    return this.sendCurrentCommand('play', ['ready'])
  }

  async pause(): Promise<PlayerPlaybackState> {
    const send = await this.enqueue(() => {
      this.ensureNotDisposed()
      if (this.state.status === 'paused') return { attempt: undefined, previousState: this.getState(), promise: Promise.resolve() }
      const attempt = this.active
      const host = this.host
      if (!attempt || !host || !['starting', 'playing'].includes(this.state.status)) {
        throw new PlayerPlaybackError('INVALID_STATE', 'O comando pause não é válido no estado atual.')
      }
      const previousState = this.getState()
      this.recordTransition('pause-intent')
      attempt.pauseRequested = true
      return { attempt, previousState, promise: host.send({ type: 'pause', commandId: crypto.randomUUID(), attemptId: attempt.attemptId }) }
    })
    try { await send.promise } catch (error) {
      const containment = await this.enqueue(() => {
        if (!send.attempt || this.active !== send.attempt) return undefined
        if (this.isUncertainCommandFailure(error)) return this.markUncertain(send.attempt, 'command-outcome-unknown', true,
          error instanceof PlayerPlaybackError ? error.code : 'COMMAND_TIMEOUT')
        send.attempt.pauseRequested = false
        if (this.state.status === 'starting') this.setState(send.previousState)
        return undefined
      })
      if (containment) await this.containUncertainAttempt(containment.attempt, containment.host, true)
      throw error
    }
    return this.getState()
  }

  async resume(): Promise<PlayerPlaybackState> {
    return this.sendCurrentCommand('play', ['paused'])
  }

  async restart(): Promise<PlayerPlaybackState> {
    this.ensureNotDisposed()
    this.persistence?.assertPlaybackAllowed?.()
    const generation = ++this.commandGeneration
    const musicCode = this.latestRequestedCode ?? this.active?.musicCode ?? this.lastSelectedCode
    if (!musicCode) throw new PlayerPlaybackError('INVALID_STATE', 'Não há uma música selecionada para reiniciar.')
    const host = this.host
    if (!host) throw new PlayerPlaybackError('HOST_UNAVAILABLE', 'Não há uma janela de reprodução conectada.')
    try { await host.ready } catch { throw new PlayerPlaybackError('HOST_UNAVAILABLE', 'A janela de reprodução não ficou disponível.') }
    let prepared: PreparedMedia
    try { prepared = await this.prepareMedia(musicCode) } catch (error) {
      this.clearFailedSelectionIntent(musicCode, generation)
      throw error
    }
    let reservation: ReservedAttempt | undefined
    try {
      reservation = await this.reserveAttempt(musicCode, 'restart', {
        generation, host, inventoryRevision: prepared.snapshot.revision
      })
      const loaded = await this.loadPrepared(musicCode, reservation, prepared)
      const attemptId = loaded.attemptId
      if (!attemptId) throw new PlayerPlaybackError('PLAYBACK_FAILED', 'A tentativa de reinício não foi criada.')
      await this.waitForAttemptState(attemptId, 'ready', 30000)
      const starting = await this.sendCurrentCommand('play', ['ready'], attemptId)
      if (starting.attemptId !== attemptId) throw new PlayerPlaybackError('SUPERSEDED', 'O reinício foi substituído antes do início.')
      return await this.waitForAttemptState(attemptId, 'playing', 15000)
    } catch (error) {
      await prepared.opened.handle.close().catch(() => undefined)
      if (reservation && error instanceof PlayerPlaybackError && error.code === 'COMMAND_TIMEOUT') {
        const containment = await this.enqueue(() => {
          const active = this.active
          return active && active.attemptId === reservation?.attempt.attemptId
            ? this.markUncertain(active, 'command-outcome-unknown', true, error.code)
            : undefined
        })
        if (containment) await this.containUncertainAttempt(containment.attempt, containment.host, true)
      } else if (reservation) await this.failAttempt(reservation, error)
      throw error
    }
  }

  stop(expectedAttemptId?: string): Promise<PlayerPlaybackState> {
    if (this.stopOperation) {
      if (expectedAttemptId && this.stopOperationAttemptId !== expectedAttemptId) {
        return Promise.reject(new PlayerPlaybackError('SUPERSEDED', 'A reprodução mudou antes da confirmação de parada.'))
      }
      return this.stopOperation
    }
    this.commandGeneration++
    const operation = this.performStop(expectedAttemptId)
    this.stopOperation = operation
    this.stopOperationAttemptId = expectedAttemptId ?? this.active?.attemptId
    void operation.then(
      () => { if (this.stopOperation === operation) { this.stopOperation = undefined; this.stopOperationAttemptId = undefined } },
      () => { if (this.stopOperation === operation) { this.stopOperation = undefined; this.stopOperationAttemptId = undefined } }
    )
    return operation
  }

  /** Clears a manually removed song only after its Stop ACK has been recorded. */
  async clearStoppedMedia(expectedAttemptId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(expectedAttemptId)) return false
    return this.enqueue(async () => {
      this.ensureNotDisposed()
      if (this.active || this.state.status !== 'stopped' || this.state.attemptId !== expectedAttemptId ||
          this.state.containmentStatus !== 'stop-acknowledged') return false
      const host = this.host
      if (host) {
        try {
          await host.send({ type: 'clear', commandId: crypto.randomUUID(), attemptId: expectedAttemptId })
        } catch {
          if (this.host === host) return false
        }
      }
      if (this.active || this.state.status !== 'stopped' || this.state.attemptId !== expectedAttemptId) return false
      this.progress = undefined
      this.latestRequestedCode = undefined
      this.lastSelectedCode = undefined
      this.setState({ status: 'idle' })
      return true
    })
  }

  /** Resolves an explicitly dismissed prior attempt without treating it as completion. */
  resolveRecoveryAsStopped(expectedAttemptId: string, musicCode: string): Promise<PlayerPlaybackState> {
    return this.enqueue(() => {
      this.ensureNotDisposed()
      const current = this.getState()
      if (this.active || (current.attemptId && current.attemptId !== expectedAttemptId)) {
        throw new PlayerPlaybackError('SUPERSEDED', 'A reprodução mudou desde que a recuperação foi apresentada.')
      }
      if (current.status === 'uncertain' && current.attemptId === expectedAttemptId &&
          !['stop-acknowledged', 'host-terminated'].includes(current.containmentStatus ?? '')) {
        throw new PlayerPlaybackError('INVALID_STATE', 'A reprodução ainda não tem contenção confirmada para ser deixada parada.')
      }
      if (current.status !== 'idle' && current.status !== 'uncertain' && current.status !== 'stopped') {
        throw new PlayerPlaybackError('SUPERSEDED', 'O estado atual não corresponde à recuperação pendente.')
      }
      this.setDurableState({ status: 'stopped', attemptId: expectedAttemptId, musicCode,
        containmentStatus: current.status === 'uncertain' ? current.containmentStatus : undefined }, 'recovery-dismissed')
      return this.getState()
    })
  }

  private async performStop(expectedAttemptId?: string): Promise<PlayerPlaybackState> {
    const command = await this.enqueue(() => {
      this.ensureNotDisposed()
      const attempt = this.active
      if (expectedAttemptId && (!attempt || attempt.attemptId !== expectedAttemptId ||
          this.state.attemptId !== expectedAttemptId ||
          !['loading', 'ready', 'starting', 'playing', 'paused'].includes(this.state.status))) {
        throw new PlayerPlaybackError('SUPERSEDED', 'A reprodução mudou desde que a confirmação foi aberta.')
      }
      if (!attempt) {
        if (!['completed', 'failed', 'uncertain', 'disposed'].includes(this.state.status) && this.state.status !== 'stopped') {
          this.setState({ status: 'stopped', musicCode: this.state.musicCode, attemptId: this.state.attemptId })
        }
        return undefined
      }
      this.setDurableState({ status: 'stopping', attemptId: attempt.attemptId, musicCode: attempt.musicCode }, 'stop-intent')
      this.active = undefined
      attempt.terminal = true
      attempt.mediaGrant?.revoke()
      this.emit({ type: 'interrupted', attemptId: attempt.attemptId, musicCode: attempt.musicCode, reason: 'stop' })
      const host = this.host
      if (!host || host.hostEpoch !== attempt.hostEpoch) {
        this.setDurableState({ status: 'uncertain', attemptId: attempt.attemptId, musicCode: attempt.musicCode,
          errorCode: 'HOST_UNAVAILABLE', containmentStatus: 'unavailable' }, 'playback-uncertain')
        this.emit({ type: 'uncertain', attemptId: attempt.attemptId,
          musicCode: attempt.musicCode, reason: 'command-outcome-unknown' })
        return undefined
      }
      return { attempt, host, promise: host.send({ type: 'stop', commandId: crypto.randomUUID(), attemptId: attempt.attemptId }) }
    })
    if (command) {
      try {
        await command.promise
        await this.enqueue(() => {
          if (!this.disposed && this.state.status === 'stopping' && this.state.attemptId === command.attempt.attemptId) {
            this.setDurableState({ status: 'stopped', attemptId: command.attempt.attemptId,
              musicCode: command.attempt.musicCode, containmentStatus: 'stop-acknowledged' }, 'stop-confirmed')
          }
        })
      } catch (error) {
        const host = await this.enqueue(() => {
          if (this.disposed || this.state.status !== 'stopping' || this.state.attemptId !== command.attempt.attemptId) return undefined
          try { this.setDurableState({ status: 'uncertain', attemptId: command.attempt.attemptId,
            musicCode: command.attempt.musicCode, errorCode: error instanceof PlayerPlaybackError ? error.code : 'COMMAND_TIMEOUT',
            containmentStatus: 'pending' }, 'playback-uncertain') }
          catch { this.setState({ status: 'uncertain', attemptId: command.attempt.attemptId,
            musicCode: command.attempt.musicCode, errorCode: 'RECOVERY_PERSISTENCE_FAILED', containmentStatus: 'pending' }) }
          this.emit({ type: 'uncertain', attemptId: command.attempt.attemptId,
            musicCode: command.attempt.musicCode, reason: 'command-outcome-unknown' })
          return this.host?.hostEpoch === command.attempt.hostEpoch ? this.host : undefined
        })
        await this.containUncertainAttempt(command.attempt, host ?? command.host, false)
        throw error
      }
    }
    return this.getState()
  }


  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposeRequested = true
    this.commandGeneration++
    this.disposePromise = this.finishDispose()
    return this.disposePromise
  }

  private async finishDispose(): Promise<void> {
    const pendingStop = this.stopOperation
    if (pendingStop) {
      try { await pendingStop } catch { /* Stop already ran bounded containment before rejecting. */ }
    }
    const shutdown = await this.enqueue(() => {
      if (this.disposed) return undefined
      const attempt = this.active
      const host = this.host?.hostEpoch === attempt?.hostEpoch ? this.host : undefined
      if (!attempt) {
        const current = this.getState()
        if (current.status === 'uncertain' && current.attemptId && this.host) {
          return { attempt: undefined, host: this.host, attemptId: current.attemptId,
            musicCode: current.musicCode, intentPersisted: true }
        }
        this.disposed = true
        this.setState({ ...current, status: 'disposed' })
        return undefined
      }
      let intentPersisted = true
      try {
        this.setDurableState({ status: 'stopping', attemptId: attempt.attemptId, musicCode: attempt.musicCode }, 'shutdown-stop-intent')
      } catch {
        intentPersisted = false
      }
      this.active = undefined
      attempt.terminal = true
      attempt.mediaGrant?.revoke()
      this.emit({ type: 'interrupted', attemptId: attempt.attemptId, musicCode: attempt.musicCode, reason: 'stop' })
      if (!intentPersisted) {
        this.setState({ status: 'uncertain', attemptId: attempt.attemptId, musicCode: attempt.musicCode,
          errorCode: 'RECOVERY_PERSISTENCE_FAILED', containmentStatus: host ? 'pending' : 'unavailable' })
      } else {
        // The service stops accepting work immediately; the durable recovery record remains
        // at stop-intent until the host ACK or bounded termination resolves the outcome.
        this.setState({ status: 'disposed', attemptId: attempt.attemptId, musicCode: attempt.musicCode })
      }
      return { attempt, host, attemptId: attempt.attemptId, musicCode: attempt.musicCode, intentPersisted }
    })
    if (shutdown) {
      let containmentStatus: NonNullable<PlayerPlaybackState['containmentStatus']> = 'unavailable'
      if (shutdown.host && shutdown.intentPersisted && shutdown.attempt) {
        try {
          await shutdown.host.send({ type: 'stop', commandId: crypto.randomUUID(), attemptId: shutdown.attemptId! })
          containmentStatus = 'stop-acknowledged'
          await this.enqueue(() => this.setDurableState({ status: 'stopped', attemptId: shutdown.attemptId!,
            musicCode: shutdown.musicCode!, containmentStatus }, 'shutdown-confirmed'))
        } catch (error) {
          containmentStatus = await this.terminateHost(shutdown.host)
          await this.enqueue(() => {
            try {
              this.setDurableState({ status: 'uncertain', attemptId: shutdown.attemptId!,
                musicCode: shutdown.musicCode!, errorCode: error instanceof PlayerPlaybackError ? error.code : 'PLAYBACK_FAILED',
                containmentStatus }, containmentStatus === 'host-terminated' ? 'host-terminated' : 'playback-uncertain')
            } catch {
              this.setState({ status: 'uncertain', attemptId: shutdown.attemptId!, musicCode: shutdown.musicCode!,
                errorCode: 'RECOVERY_PERSISTENCE_FAILED', containmentStatus })
            }
          })
        }
      } else if (shutdown.host) {
        containmentStatus = await this.terminateHost(shutdown.host)
        if (shutdown.attemptId) {
          await this.enqueue(() => {
            if (this.state.status !== 'uncertain' || this.state.attemptId !== shutdown.attemptId) return
            try { this.setDurableState({ ...this.state, containmentStatus }, 'containment-updated') }
            catch { this.setState({ ...this.state, errorCode: 'RECOVERY_PERSISTENCE_FAILED', containmentStatus }) }
          })
        }
      }
      if (shutdown.attempt && !shutdown.intentPersisted && shutdown.host) {
        await this.enqueue(() => this.setState({ status: 'uncertain', attemptId: shutdown.attemptId,
          musicCode: shutdown.musicCode, errorCode: 'RECOVERY_PERSISTENCE_FAILED', containmentStatus }))
      }
    }
    await this.enqueue(() => {
      this.disposed = true
      this.setState({ ...this.getState(), status: 'disposed' })
    })
    this.unsubscribeHost?.()
    this.unsubscribeHost = undefined
    this.host?.dispose()
    this.host = undefined
    this.listeners.clear()
  }

  private async sendCurrentCommand(
    type: 'play' | 'pause',
    allowed: PlayerPlaybackState['status'][],
    expectedAttemptId?: string
  ): Promise<PlayerPlaybackState> {
    const send = await this.enqueue(() => {
      this.ensureNotDisposed()
      const attempt = this.active
      const host = this.host
      if (!attempt || !host || (expectedAttemptId && attempt.attemptId !== expectedAttemptId) || !allowed.includes(this.state.status)) {
        throw new PlayerPlaybackError('INVALID_STATE', `O comando ${type} não é válido no estado atual.`)
      }
      const previousState = this.getState()
      if (type === 'play') {
        const transition = previousState.status === 'paused' ? 'resume-intent' : 'play-intent'
        this.persistTransition(transition, { status: 'starting', attemptId: attempt.attemptId, musicCode: attempt.musicCode })
        attempt.pauseRequested = false
        this.setState({ status: 'starting', attemptId: attempt.attemptId, musicCode: attempt.musicCode })
      } else {
        this.recordTransition('pause-intent')
        attempt.pauseRequested = true
      }
      return { attempt, previousState, promise: host.send({ type, commandId: crypto.randomUUID(), attemptId: attempt.attemptId }) }
    })
    try {
      await send.promise
    } catch (error) {
      const containment = await this.enqueue(() => {
        if (this.active !== send.attempt) return
        if (this.isUncertainCommandFailure(error)) return this.markUncertain(send.attempt, 'command-outcome-unknown', true,
          error instanceof PlayerPlaybackError ? error.code : 'COMMAND_TIMEOUT')
        if (type === 'pause') send.attempt.pauseRequested = false
        if (this.state.status === 'starting') this.setState(send.previousState)
        return undefined
      })
      if (containment) await this.containUncertainAttempt(containment.attempt, containment.host, true)
      throw error
    }
    return this.getState()
  }

  private waitForAttemptState(
    attemptId: string,
    expected: 'ready' | 'playing',
    timeoutMs: number
  ): Promise<PlayerPlaybackState> {
    const current = this.getState()
    if (current.attemptId !== attemptId) {
      return Promise.reject(new PlayerPlaybackError('SUPERSEDED', 'A tentativa foi substituída.'))
    }
    if (current.status === expected) return Promise.resolve(current)
    if (expected === 'playing' && current.status === 'completed') return Promise.resolve(current)
    const terminalError = (state: PlayerPlaybackState): PlayerPlaybackError | undefined => {
      if (state.attemptId !== attemptId) return new PlayerPlaybackError('SUPERSEDED', 'A tentativa foi substituída.')
      if (state.status === 'failed') return new PlayerPlaybackError(state.errorCode ?? 'PLAYBACK_FAILED', 'A reprodução falhou.')
      if (state.status === 'uncertain') return new PlayerPlaybackError(state.errorCode ?? 'COMMAND_TIMEOUT', 'O resultado da reprodução é incerto.')
      if (state.status === 'paused' || state.status === 'stopping' || state.status === 'stopped' ||
          state.status === 'disposed' || state.status === 'completed') {
        return new PlayerPlaybackError('SUPERSEDED', 'A reprodução foi interrompida antes de atingir o estado esperado.')
      }
      return undefined
    }
    const terminal = terminalError(current)
    if (terminal) return Promise.reject(terminal)

    return new Promise<PlayerPlaybackState>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new PlayerPlaybackError(expected === 'ready' ? 'MEDIA_LOAD_FAILED' : 'COMMAND_TIMEOUT',
          expected === 'ready' ? 'A mídia não ficou pronta no tempo esperado.' : 'O início da reprodução não foi observado no tempo esperado.'))
      }, timeoutMs)
      const unsubscribe = this.subscribe(event => {
        if (event.type !== 'state-changed') return
        const state = event.state
        if (state.attemptId === attemptId && state.status === expected) {
          clearTimeout(timer)
          unsubscribe()
          resolve(state)
          return
        }
        if (expected === 'playing' && state.attemptId === attemptId && state.status === 'completed') {
          clearTimeout(timer)
          unsubscribe()
          resolve(state)
          return
        }
        const error = terminalError(state)
        if (error) {
          clearTimeout(timer)
          unsubscribe()
          reject(error)
        }
      })
    })
  }

  private async prepareMedia(value: string): Promise<PreparedMedia> {
    const snapshot = this.library.getSnapshot()
    if (snapshot.scanStatus !== 'ready') throw unavailableError('unknown')
    const opened = await this.library.openForPlayback(value, snapshot.revision)
    if (opened.status !== 'available') throw unavailableError(opened.status)
    const current = this.library.getSnapshot()
    if (opened.revision !== snapshot.revision || current.scanStatus !== 'ready' || current.revision !== snapshot.revision) {
      await opened.handle.close().catch(() => undefined)
      throw unavailableError('unknown')
    }
    return { snapshot, opened }
  }

  private clearFailedSelectionIntent(value: string, generation: number): void {
    if (this.commandGeneration !== generation || this.latestRequestedCode !== value) return
    this.latestRequestedCode = this.active?.musicCode ?? this.lastSelectedCode
  }

  private async reserveAttempt(
    requestedMusicCode: string | undefined,
    reason: 'replace' | 'restart',
    intent?: ReservationIntent
  ): Promise<ReservedAttempt> {
    this.ensureNotDisposed()
    this.persistence?.assertPlaybackAllowed?.(intent?.recoveryAttemptId)
    const generation = intent?.generation ?? ++this.commandGeneration
    const pendingStop = this.stopOperation
    if (pendingStop) {
      try { await pendingStop } catch (error) {
        throw error instanceof PlayerPlaybackError
          ? error
          : new PlayerPlaybackError('COMMAND_TIMEOUT', 'Uma parada anterior permanece sem confirmação.')
      }
      if (this.state.status === 'uncertain') {
        throw new PlayerPlaybackError(this.state.errorCode ?? 'COMMAND_TIMEOUT',
          'Não é possível iniciar outra música enquanto a parada anterior permanece incerta.')
      }
    }
    const host = intent?.host ?? this.host
    if (!host) throw new PlayerPlaybackError('HOST_UNAVAILABLE', 'Não há uma janela de reprodução conectada.')
    try { await host.ready } catch { throw new PlayerPlaybackError('HOST_UNAVAILABLE', 'A janela de reprodução não ficou disponível.') }
    const result = await this.enqueue(async () => {
      this.ensureNotDisposed()
      if (generation !== this.commandGeneration) throw new PlayerPlaybackError('SUPERSEDED', 'O comando foi cancelado por uma operação posterior.')
      if (this.host !== host) throw new PlayerPlaybackError('HOST_UNAVAILABLE', 'A janela de reprodução foi substituída.')
      const musicCode = reason === 'restart'
        ? requestedMusicCode ?? this.latestRequestedCode ?? this.active?.musicCode ?? this.lastSelectedCode
        : requestedMusicCode
      if (!musicCode) throw new PlayerPlaybackError('INVALID_STATE', 'Não há uma música selecionada para reiniciar.')
      const snapshot = this.library.getSnapshot()
      if (intent?.inventoryRevision && (snapshot.scanStatus !== 'ready' || snapshot.revision !== intent.inventoryRevision)) {
        throw unavailableError('unknown')
      }
      intent?.validateBeforeCommit?.()
      const previous = this.active
      if (previous) {
        const stopIntent = { status: 'stopping' as const, attemptId: previous.attemptId, musicCode: previous.musicCode }
        this.setDurableState(stopIntent, 'replacement-stop-intent')
        try {
          await host.send({ type: 'stop', commandId: crypto.randomUUID(), attemptId: previous.attemptId })
        } catch (error) {
          const containment = this.markUncertain(previous, 'command-outcome-unknown', false,
            error instanceof PlayerPlaybackError ? error.code : 'COMMAND_TIMEOUT')
          this.emit({ type: 'interrupted', attemptId: previous.attemptId, musicCode: previous.musicCode, reason })
          return { failure: error, containment }
        }
        previous.terminal = true
        previous.mediaGrant?.revoke()
        this.active = undefined
        try {
          this.setDurableState({ status: 'stopped', attemptId: previous.attemptId, musicCode: previous.musicCode,
            containmentStatus: 'stop-acknowledged' }, 'replacement-interrupted')
        } catch (error) {
          this.setState({ status: 'uncertain', attemptId: previous.attemptId, musicCode: previous.musicCode,
            errorCode: 'RECOVERY_PERSISTENCE_FAILED', containmentStatus: 'stop-acknowledged' })
          this.emit({ type: 'uncertain', attemptId: previous.attemptId, musicCode: previous.musicCode,
            reason: 'command-outcome-unknown' })
          return { failure: error }
        }
        this.emit({ type: 'interrupted', attemptId: previous.attemptId, musicCode: previous.musicCode, reason })
      }
      if (generation !== this.commandGeneration) return { failure: new PlayerPlaybackError('SUPERSEDED', 'O comando foi cancelado por uma operação posterior.') }
      intent?.validateBeforeCommit?.()
      const attempt: ActiveAttempt = {
        attemptId: crypto.randomUUID(), hostEpoch: host.hostEpoch, musicCode,
        inventoryRevision: snapshot.revision, lastSequence: 0, sawPlaying: false,
        pauseRequested: false, terminal: false
      }
      this.active = attempt
      try {
        this.setDurableState({ status: 'loading', attemptId: attempt.attemptId, musicCode }, 'load-intent')
      } catch (error) {
        this.active = undefined
        throw error
      }
      this.lastSelectedCode = musicCode
      return { reservation: { attempt, host } }
    })
    if ('containment' in result && result.containment) {
      await this.containUncertainAttempt(result.containment.attempt, result.containment.host, false)
    }
    if ('failure' in result && result.failure) throw result.failure
    if (!('reservation' in result) || !result.reservation) throw new PlayerPlaybackError('PLAYBACK_FAILED', 'A tentativa não pôde ser reservada.')
    return result.reservation
  }

  private async failAttempt(reservation: ReservedAttempt, error: unknown): Promise<void> {
    const code = error instanceof PlayerPlaybackError ? error.code : 'MEDIA_LOAD_FAILED'
    const containment = await this.enqueue(() => {
      reservation.attempt.mediaGrant?.revoke()
      if (this.active !== reservation.attempt) return undefined
      if (this.isUncertainCommandFailure(error)) {
        return this.markUncertain(reservation.attempt, 'command-outcome-unknown', true,
          error instanceof PlayerPlaybackError ? error.code : 'COMMAND_TIMEOUT')
      }
      let persistenceFailed = false
      try {
        this.setDurableState({ status: 'failed', attemptId: reservation.attempt.attemptId,
          musicCode: reservation.attempt.musicCode, errorCode: code }, 'playback-failed')
      } catch {
        persistenceFailed = true
        this.setState({ status: 'uncertain', attemptId: reservation.attempt.attemptId,
          musicCode: reservation.attempt.musicCode, errorCode: 'RECOVERY_PERSISTENCE_FAILED', containmentStatus: 'pending' })
      }
      reservation.attempt.terminal = true
      this.active = undefined
      if (persistenceFailed) {
        this.emit({ type: 'uncertain', attemptId: reservation.attempt.attemptId,
          musicCode: reservation.attempt.musicCode, reason: 'command-outcome-unknown' })
        return { attempt: reservation.attempt, host: this.host }
      }
      this.emit({ type: 'error', attemptId: reservation.attempt.attemptId, musicCode: reservation.attempt.musicCode, errorCode: code })
      return undefined
    })
    if (containment) await this.containUncertainAttempt(containment.attempt, containment.host, true)
  }

  private handleHostEvent(event: PlayerPlaybackHostEvent): void {
    void this.enqueue(() => this.applyHostEvent(event)).catch(error => {
      this.handleTransitionPersistenceFailure(event, error)
    })
  }

  private applyHostEvent(event: PlayerPlaybackHostEvent): void {
    if (this.disposed) return
    if (event.type === 'terminated') {
      if (this.host?.hostEpoch === event.hostEpoch) this.detachHost('host-terminated')
      return
    }
    const attempt = this.active
    if (!attempt || event.hostEpoch !== attempt.hostEpoch || event.attemptId !== attempt.attemptId ||
        event.sequenceNumber <= attempt.lastSequence || attempt.terminal) return
    attempt.lastSequence = event.sequenceNumber
    const observation = event.observation
    switch (observation.type) {
      case 'loadedmetadata':
        if (this.state.status === 'loading') this.setDurableState({ status: 'ready', attemptId: attempt.attemptId,
          musicCode: attempt.musicCode }, 'media-ready')
        break
      case 'playing':
        if (attempt.pauseRequested) break
        attempt.sawPlaying = true
        this.setDurableState({ status: 'playing', attemptId: attempt.attemptId, musicCode: attempt.musicCode }, 'playback-started')
        break
      case 'timeupdate':
        if ((this.state.status === 'playing' || this.state.status === 'paused') &&
            Number.isFinite(observation.currentTime) && (observation.currentTime as number) >= 0) {
          const duration = Number.isFinite(observation.duration) && (observation.duration as number) > 0
            ? observation.duration as number
            : null
          this.progress = { attemptId: attempt.attemptId, currentTime: observation.currentTime as number, duration }
          this.emit({ type: 'progress', ...this.progress })
        }
        break
      case 'pause':
        if (attempt.pauseRequested && (this.state.status === 'playing' || this.state.status === 'starting')) {
          this.setDurableState({ status: 'paused', attemptId: attempt.attemptId, musicCode: attempt.musicCode }, 'playback-paused')
        }
        break
      case 'ended': this.handleEnded(attempt, observation.currentTime, observation.duration); break
      case 'error': this.handleMediaFailure(attempt); break
      default: break
    }
  }

  private handleEnded(attempt: ActiveAttempt, currentTime: number | undefined, duration: number | undefined): void {
    if (this.active !== attempt || !attempt.sawPlaying || this.state.status !== 'playing' ||
        !Number.isFinite(duration) || (duration as number) <= 0 || !Number.isFinite(currentTime) ||
        (currentTime as number) < (duration as number)) {
      try {
        this.setDurableState({ status: 'uncertain', attemptId: attempt.attemptId, musicCode: attempt.musicCode }, 'playback-uncertain')
      } catch {
        this.setState({ status: 'uncertain', attemptId: attempt.attemptId, musicCode: attempt.musicCode,
          errorCode: 'RECOVERY_PERSISTENCE_FAILED', containmentStatus: 'pending' })
      }
      attempt.terminal = true
      this.active = undefined
      attempt.mediaGrant?.revoke()
      this.emit({ type: 'uncertain', attemptId: attempt.attemptId, musicCode: attempt.musicCode,
        reason: 'invalid-ended-evidence' })
      return
    }
    const completed = { status: 'completed' as const, attemptId: attempt.attemptId, musicCode: attempt.musicCode }
    this.persistTransition('natural-end-confirmed', completed)
    this.progress = undefined
    this.setState(completed)
    attempt.terminal = true
    this.active = undefined
    attempt.mediaGrant?.revoke()
    this.emit({ type: 'natural-end-candidate', attemptId: attempt.attemptId, musicCode: attempt.musicCode,
      duration: duration as number, endedAt: new Date().toISOString() })
  }

  private handleMediaFailure(attempt: ActiveAttempt): void {
    if (this.active !== attempt || attempt.terminal) return
    this.setDurableState({ status: 'failed', attemptId: attempt.attemptId, musicCode: attempt.musicCode,
      errorCode: 'PLAYBACK_FAILED' }, 'playback-failed')
    attempt.terminal = true
    attempt.mediaGrant?.revoke()
    this.active = undefined
    this.emit({ type: 'error', attemptId: attempt.attemptId, musicCode: attempt.musicCode, errorCode: 'PLAYBACK_FAILED' })
  }

  private detachHost(reason: 'host-terminated'): void {
    const host = this.host
    if (!host) return
    this.unsubscribeHost?.()
    this.unsubscribeHost = undefined
    this.host = undefined
    const attempt = this.active
    if (attempt && attempt.hostEpoch === host.hostEpoch) {
      try {
        this.setDurableState({ status: 'uncertain', attemptId: attempt.attemptId, musicCode: attempt.musicCode,
          errorCode: 'HOST_TERMINATED', containmentStatus: 'host-terminated' }, 'host-terminated')
      } catch {
        this.setState({ status: 'uncertain', attemptId: attempt.attemptId, musicCode: attempt.musicCode,
          errorCode: 'RECOVERY_PERSISTENCE_FAILED', containmentStatus: 'host-terminated' })
      }
      attempt.terminal = true
      attempt.mediaGrant?.revoke()
      this.active = undefined
      this.emit({ type: 'interrupted', attemptId: attempt.attemptId, musicCode: attempt.musicCode, reason })
      this.emit({ type: 'uncertain', attemptId: attempt.attemptId, musicCode: attempt.musicCode, reason })
    }
    host.dispose()
  }

  private ensureCurrent(reservation: ReservedAttempt): void {
    this.ensureNotDisposed()
    if (this.active !== reservation.attempt || this.host !== reservation.host) {
      throw new PlayerPlaybackError('SUPERSEDED', 'A tentativa de reprodução foi substituída.')
    }
  }

  private ensureNotDisposed(): void {
    if (this.disposeRequested || this.disposed) throw new PlayerPlaybackError('DISPOSED', 'O serviço de reprodução já foi encerrado.')
  }

  private isUncertainCommandFailure(error: unknown): boolean {
    return error instanceof PlayerPlaybackError &&
      (error.code === 'COMMAND_TIMEOUT' || error.code === 'HOST_TERMINATED')
  }

  private markUncertain(
    attempt: ActiveAttempt,
    reason: 'command-outcome-unknown',
    requestStop: boolean,
    failureCode: PlayerPlaybackErrorCode = 'COMMAND_TIMEOUT'
  ): { attempt: ActiveAttempt; host: PlayerPlaybackHost | undefined } | undefined {
    if (this.active !== attempt) return undefined
    attempt.terminal = true
    this.active = undefined
    attempt.mediaGrant?.revoke()
    const host = this.host?.hostEpoch === attempt.hostEpoch ? this.host : undefined
    const nextState = { status: 'uncertain' as const, attemptId: attempt.attemptId, musicCode: attempt.musicCode,
      errorCode: failureCode, containmentStatus: requestStop && host ? 'pending' as const : 'unavailable' as const }
    try { this.setDurableState(nextState, 'playback-uncertain') }
    catch { this.setState({ ...nextState, errorCode: 'RECOVERY_PERSISTENCE_FAILED' }) }
    attempt.terminal = true
    this.active = undefined
    attempt.mediaGrant?.revoke()
    this.emit({ type: 'uncertain', attemptId: attempt.attemptId, musicCode: attempt.musicCode, reason })
    return { attempt, host }
  }

  private async containUncertainAttempt(
    attempt: ActiveAttempt,
    host: PlayerPlaybackHost | undefined,
    requestStop: boolean
  ): Promise<void> {
    let containmentStatus: NonNullable<PlayerPlaybackState['containmentStatus']> = 'unavailable'
    if (host?.hostEpoch === attempt.hostEpoch) {
      if (requestStop) {
        try {
          await host.send({ type: 'stop', commandId: crypto.randomUUID(), attemptId: attempt.attemptId })
          containmentStatus = 'stop-acknowledged'
        } catch {
          containmentStatus = await this.terminateHost(host)
        }
      } else {
        containmentStatus = await this.terminateHost(host)
      }
    }
    await this.enqueue(() => {
      if (this.state.status !== 'uncertain' || this.state.attemptId !== attempt.attemptId) return
      try { this.setDurableState({ ...this.state, containmentStatus }, 'containment-updated') }
      catch { this.setState({ ...this.state, errorCode: 'RECOVERY_PERSISTENCE_FAILED', containmentStatus }) }
    })
  }

  private async terminateHost(host: PlayerPlaybackHost): Promise<NonNullable<PlayerPlaybackState['containmentStatus']>> {
    try {
      return await host.terminate() ? 'host-terminated' : 'unconfirmed'
    } catch {
      return 'unconfirmed'
    }
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private setState(state: PlayerPlaybackState): void {
    this.state = { ...state }
    this.emit({ type: 'state-changed', state: this.getState() })
  }

  private setDurableState(state: PlayerPlaybackState, transition: PlayerPlaybackPersistenceTransition): void {
    this.persistTransition(transition, state)
    this.setState(state)
  }

  private recordTransition(transition: PlayerPlaybackPersistenceTransition): void {
    this.persistTransition(transition, this.getState())
  }

  private persistTransition(transition: PlayerPlaybackPersistenceTransition, next: PlayerPlaybackState): void {
    try {
      this.persistence?.persistTransition(next, this.getState(), transition)
    } catch (error) {
      if (error instanceof PlayerPlaybackError) throw error
      throw new PlayerPlaybackError('RECOVERY_PERSISTENCE_FAILED',
        error instanceof Error ? error.message : 'A gravação de recuperação falhou.')
    }
  }

  private handleTransitionPersistenceFailure(event: PlayerPlaybackHostEvent, _error: unknown): void {
    const attempt = this.active
    if (!attempt || (event.type === 'media' && event.attemptId !== attempt.attemptId) ||
        (event.type === 'terminated' && event.hostEpoch !== attempt.hostEpoch)) return
    const host = this.host?.hostEpoch === attempt.hostEpoch ? this.host : undefined
    attempt.terminal = true
    attempt.mediaGrant?.revoke()
    this.active = undefined
    this.setState({ status: 'uncertain', attemptId: attempt.attemptId, musicCode: attempt.musicCode,
      errorCode: 'RECOVERY_PERSISTENCE_FAILED', containmentStatus: host ? 'pending' : 'unavailable' })
    this.emit({ type: 'uncertain', attemptId: attempt.attemptId, musicCode: attempt.musicCode,
      reason: 'command-outcome-unknown' })
    if (host) void this.containUncertainAttempt(attempt, host, true).catch(() => undefined)
  }

  private emit(event: PlayerPlaybackEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* Observers cannot interrupt playback coordination. */ }
    }
  }
}
