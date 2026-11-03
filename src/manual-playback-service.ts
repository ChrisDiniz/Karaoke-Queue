import crypto from 'node:crypto'
import {
  MusicCatalogError,
  normalizeCatalogCodeForVideoMatch
} from './music-catalog'
import {
  PlayerPlaybackError,
  type PlayerPlaybackEvent,
  type PlayerPlaybackState
} from './player-playback-contracts'

export type ManualPlaybackOperation = 'play' | 'pause' | 'resume' | 'restart' | 'stop' | 'next' | 'previous'

export type ManualPlaybackResult =
  | { outcome: 'started' | 'accepted' | 'queued'; operation: ManualPlaybackOperation | 'add' | 'remove' | 'remove-current' | 'reorder' | 'clear'; state: PlayerPlaybackState; itemId?: string }
  | { outcome: 'unavailable'; operation: ManualPlaybackOperation | 'add' | 'remove' | 'remove-current' | 'reorder' | 'clear'; reason: string; state: PlayerPlaybackState }
  | { outcome: 'boundary'; operation: 'next' | 'previous'; reason: 'SEQUENCE_BOUNDARY'; state: PlayerPlaybackState }
  | { outcome: 'uncertain'; operation: ManualPlaybackOperation; reason: string; state: PlayerPlaybackState }
  | { outcome: 'failed'; operation: ManualPlaybackOperation | 'add' | 'remove' | 'remove-current' | 'reorder' | 'clear'; reason: string; state: PlayerPlaybackState }

export interface ManualBatchEntryIssue {
  readonly index: number
  readonly value: string
  readonly reason: string
}

export type ManualBatchPlaybackResult =
  | { outcome: 'started' | 'queued'; operation: 'add-batch'; state: PlayerPlaybackState; sequence: ManualSequenceSnapshot; acceptedCodes: readonly string[] }
  | { outcome: 'unavailable' | 'uncertain'; operation: 'add-batch'; reason: string; state: PlayerPlaybackState; sequence: ManualSequenceSnapshot }
  | { outcome: 'failed'; operation: 'add-batch'; reason: string; state: PlayerPlaybackState; sequence: ManualSequenceSnapshot; invalidEntries?: readonly ManualBatchEntryIssue[]; acceptedCodes?: readonly string[] }

export interface ManualSequenceItem {
  readonly id: string
  readonly musicCode: string
}

export interface ManualSequenceSnapshot {
  readonly current: ManualSequenceItem | null
  readonly pending: readonly ManualSequenceItem[]
  readonly previous: readonly ManualSequenceItem[]
}

export interface ManualPlaybackEngine {
  getState(): PlayerPlaybackState
  playImmediately(canonicalCode: string, validateBeforeCommit?: () => void, recoveryAttemptId?: string): Promise<PlayerPlaybackState>
  clearCompletedMedia?(expectedAttemptId: string): Promise<boolean>
  clearStoppedMedia?(expectedAttemptId: string): Promise<boolean>
  assertPlaybackAllowed?(): void
  pause(): Promise<PlayerPlaybackState>
  resume(): Promise<PlayerPlaybackState>
  restart(): Promise<PlayerPlaybackState>
  stop(expectedAttemptId?: string): Promise<PlayerPlaybackState>
  validateMusicCode?(canonicalCode: string): Promise<void>
  subscribe?(listener: (event: PlayerPlaybackEvent) => void): () => void
}

export interface ManualPlaybackOptions {
  /** Enabled only for local Player mode, never for Combined or future remote commands. */
  autoAdvanceOnNaturalEnd?: boolean
}

function errorCode(error: unknown): string {
  if (error instanceof PlayerPlaybackError || error instanceof MusicCatalogError) return error.code
  return 'PLAYBACK_FAILED'
}

/** Main-side local sequence and controls. It never owns Controller queue or history state. */
export class ManualPlaybackService {
  private currentSequenceItem: ManualSequenceItem | null = null
  private pendingSequence: ManualSequenceItem[] = []
  private previousSequence: ManualSequenceItem[] = []
  private legacyNavigationContext = false
  private disposed = false
  private commandRevision = 0
  private sequenceMutationRevision = 0
  private sequenceAddTail: Promise<void> = Promise.resolve()
  private readonly batchRequests = new Map<string, { readonly payload: string; readonly promise: Promise<ManualBatchPlaybackResult>; settled: boolean }>()
  private activeAttemptId: string | undefined
  private readonly handledNaturalEnds = new Set<string>()
  private readonly earlyNaturalEnds = new Map<string, Extract<PlayerPlaybackEvent, { type: 'natural-end-candidate' }>>()
  private readonly unsubscribePlayback: (() => void) | undefined
  private autoAdvanceTask: Promise<void> | undefined
  private automaticItemId: string | undefined
  private sequenceItemStartingId: string | undefined
  private currentRemoval: { readonly itemId: string | null; readonly attemptId: string } | undefined
  private readonly listeners = new Set<() => void>()

  constructor(private readonly playback: ManualPlaybackEngine, private readonly options: ManualPlaybackOptions = {}) {
    this.unsubscribePlayback = playback.subscribe?.(event => this.handlePlaybackEvent(event))
    const state = playback.getState()
    if (['loading', 'ready', 'starting', 'playing', 'paused'].includes(state.status)) {
      this.activeAttemptId = state.attemptId
    }
  }

  getStatus(): PlayerPlaybackState { return this.playback.getState() }

  subscribe(listener: () => void): () => void {
    this.ensureOpen()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSequence(): ManualSequenceSnapshot {
    return {
      current: this.currentSequenceItem ? { ...this.currentSequenceItem } : null,
      pending: this.pendingSequence.map(item => ({ ...item })),
      previous: this.previousSequence.map(item => ({ ...item }))
    }
  }

  /** Installs a volatile explicit order while preserving the Phase 5D navigation contract. */
  setNavigationSequence(codes: readonly unknown[], currentPosition: number): void {
    this.ensureOpen()
    if (!Array.isArray(codes) || codes.length === 0 || !Number.isInteger(currentPosition) ||
        currentPosition < 0 || currentPosition >= codes.length) {
      throw new PlayerPlaybackError('INVALID_STATE', 'A sequência de navegação ou a posição atual é inválida.')
    }
    let normalized: string[]
    try { normalized = codes.map(code => normalizeCatalogCodeForVideoMatch(code)) }
    catch { throw new PlayerPlaybackError('INVALID_MUSIC_CODE', 'A sequência contém um código de música inválido.') }
    const state = this.playback.getState()
    if (!['loading', 'ready', 'starting', 'playing', 'paused'].includes(state.status)) {
      throw new PlayerPlaybackError('INVALID_STATE', 'Não há uma reprodução selecionada para associar à sequência.')
    }
    if (state.musicCode !== normalized[currentPosition]) {
      throw new PlayerPlaybackError('INVALID_STATE', 'A posição atual da sequência não corresponde à música selecionada.')
    }
    const items = normalized.map(musicCode => ({ id: crypto.randomUUID(), musicCode }))
    this.currentSequenceItem = items[currentPosition]
    this.previousSequence = items.slice(0, currentPosition)
    this.pendingSequence = items.slice(currentPosition + 1)
    this.legacyNavigationContext = true
    this.activeAttemptId = state.attemptId
    this.notifyChanged()
  }

  /** Adds a locally resolved code. Validation opens and revalidates the indexed media, then closes it. */
  addToSequence(value: unknown): Promise<ManualPlaybackResult> {
    this.ensureOpen()
    let musicCode: string
    try { musicCode = normalizeCatalogCodeForVideoMatch(value) }
    catch (error) { return Promise.resolve(this.failure('add', error)) }
    const mutationRevision = this.sequenceMutationRevision
    const addition = this.sequenceAddTail.then(async (): Promise<ManualPlaybackResult> => {
      try {
        this.ensureOpen()
        if (mutationRevision !== this.sequenceMutationRevision) {
          return { outcome: 'unavailable', operation: 'add', reason: 'SEQUENCE_CHANGED', state: this.getStatus() }
        }
        await this.playback.validateMusicCode?.(musicCode)
        this.ensureOpen()
        if (mutationRevision !== this.sequenceMutationRevision) {
          return { outcome: 'unavailable', operation: 'add', reason: 'SEQUENCE_CHANGED', state: this.getStatus() }
        }
        const item = { id: crypto.randomUUID(), musicCode }
        this.pendingSequence.push(item)
        this.legacyNavigationContext = false
        this.notifyChanged()
        return { outcome: 'queued', operation: 'add', state: this.getStatus(), itemId: item.id }
      } catch (error) { return this.failure('add', error) }
    })
    this.sequenceAddTail = addition.then(() => undefined, () => undefined)
    return addition
  }

  /** Validates and commits one explicit batch. Request identities make IPC retries idempotent. */
  addBatchToSequence(rawText: unknown, requestId: unknown): Promise<ManualBatchPlaybackResult> {
    this.ensureOpen()
    if (typeof rawText !== 'string' || rawText.length > 4096) {
      return Promise.resolve(this.batchFailure('failed', 'INVALID_BATCH_INPUT'))
    }
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) {
      return Promise.resolve(this.batchFailure('failed', 'INVALID_REQUEST_ID'))
    }
    const payload = crypto.createHash('sha256').update(rawText, 'utf8').digest('hex')
    const existing = this.batchRequests.get(requestId)
    if (existing) {
      if (existing.payload !== payload) return Promise.resolve(this.batchFailure('failed', 'REQUEST_ID_CONFLICT'))
      return existing.promise
    }
    this.trimBatchRequestCache()
    if (this.batchRequests.size >= 128) return Promise.resolve(this.batchFailure('unavailable', 'BATCH_BUSY'))

    const promise = this.enqueueBatch(rawText)
    const entry = { payload, promise, settled: false }
    this.batchRequests.set(requestId, entry)
    void promise.finally(() => { entry.settled = true; this.trimBatchRequestCache() }).catch(() => undefined)
    return promise
  }

  private enqueueBatch(rawText: string): Promise<ManualBatchPlaybackResult> {
    const addition = this.sequenceAddTail.then(async (): Promise<ManualBatchPlaybackResult> => {
      try {
        this.ensureOpen()
        if (this.currentRemoval) return this.batchFailure('unavailable', 'CURRENT_REMOVAL_IN_PROGRESS')
        this.playback.assertPlaybackAllowed?.()
        const initialState = this.playback.getState()
        if (initialState.status === 'uncertain' || initialState.status === 'disposed' || initialState.status === 'stopping') {
          return this.batchFailure(initialState.status === 'uncertain' ? 'uncertain' : 'unavailable',
            initialState.errorCode ?? 'PLAYBACK_BUSY')
        }
        if (initialState.status === 'failed') return this.batchFailure('unavailable', 'PLAYBACK_FAILED_REQUIRES_DECISION')
        const commandRevision = this.commandRevision
        const mutationRevision = this.sequenceMutationRevision
        const tokens = rawText.trim().split(/[\s,]+/).filter(Boolean)
        if (tokens.length === 0) return this.batchFailure('failed', 'EMPTY_BATCH')
        if (tokens.length > 100) return this.batchFailure('failed', 'BATCH_LIMIT_EXCEEDED')

        const normalized: Array<{ index: number; value: string; code?: string }> = tokens.map((value, index) => {
          try { return { index: index + 1, value, code: normalizeCatalogCodeForVideoMatch(value) } }
          catch { return { index: index + 1, value } }
        })
        const issues: ManualBatchEntryIssue[] = []
        for (const item of normalized) {
          if (!item.code) {
            issues.push({ index: item.index, value: item.value, reason: 'INVALID_MUSIC_CODE' })
            continue
          }
          try { await this.playback.validateMusicCode?.(item.code) }
          catch (error) { issues.push({ index: item.index, value: item.value, reason: errorCode(error) }) }
        }
        this.ensureOpen()
        this.playback.assertPlaybackAllowed?.()
        if (commandRevision !== this.commandRevision || mutationRevision !== this.sequenceMutationRevision) {
          return this.batchFailure('unavailable', commandRevision !== this.commandRevision
            ? 'PLAYBACK_CHANGED_DURING_BATCH' : 'SEQUENCE_CHANGED_DURING_BATCH')
        }
        if (issues.length > 0) {
          return {
            outcome: 'failed', operation: 'add-batch', reason: 'BATCH_VALIDATION_FAILED',
            state: this.getStatus(), sequence: this.getSequence(), invalidEntries: issues
          }
        }

        const state = this.playback.getState()
        if (state.status === 'uncertain' || state.status === 'disposed' || state.status === 'stopping') {
          const outcome = state.status === 'uncertain' ? 'uncertain' : 'unavailable'
          return this.batchFailure(outcome, state.errorCode ?? 'PLAYBACK_BUSY')
        }
        if (state.status === 'failed') return this.batchFailure('unavailable', 'PLAYBACK_FAILED_REQUIRES_DECISION')

        const items = normalized.map(({ code }) => ({ id: crypto.randomUUID(), musicCode: code! }))
        this.pendingSequence.push(...items)
        this.legacyNavigationContext = false
        const shouldStart = !this.automaticItemId && ['idle', 'stopped', 'completed'].includes(state.status)
        this.notifyChanged()
        if (!shouldStart) {
          return { outcome: 'queued', operation: 'add-batch', state: this.getStatus(),
            sequence: this.getSequence(), acceptedCodes: items.map(item => item.musicCode) }
        }

        const next = this.pendingSequence[0]
        if (!next) return this.batchFailure('failed', 'BATCH_COMMIT_FAILED')
        const started = await this.playSequenceItem('next', next)
        if (started.outcome === 'started') {
          return { outcome: 'started', operation: 'add-batch', state: started.state,
            sequence: this.getSequence(), acceptedCodes: items.map(item => item.musicCode) }
        }
        const reason = 'reason' in started ? started.reason : started.state.errorCode ?? 'PLAYBACK_FAILED'
        if (started.outcome === 'uncertain') return this.batchFailure('uncertain', reason)
        return this.batchFailure('failed', reason)
      } catch (error) {
        const result = this.batchFailure(error instanceof PlayerPlaybackError && error.code === 'RECOVERY_PENDING'
          ? 'unavailable' : error instanceof PlayerPlaybackError && ['COMMAND_TIMEOUT', 'HOST_TERMINATED'].includes(error.code)
            ? 'uncertain' : 'failed', errorCode(error))
        return result
      }
    })
    this.sequenceAddTail = addition.then(() => undefined, () => undefined)
    return addition
  }

  private batchFailure(outcome: 'failed' | 'unavailable' | 'uncertain', reason: string): ManualBatchPlaybackResult {
    return { outcome, operation: 'add-batch', reason, state: this.getStatus(), sequence: this.getSequence() }
  }

  private trimBatchRequestCache(): void {
    while (this.batchRequests.size > 127) {
      const oldestSettled = [...this.batchRequests].find(([, request]) => request.settled)
      if (!oldestSettled) return
      this.batchRequests.delete(oldestSettled[0])
    }
  }

  removeFromSequence(itemId: unknown): ManualPlaybackResult {
    this.ensureOpen()
    if (typeof itemId !== 'string') return this.failure('remove', new PlayerPlaybackError('INVALID_STATE', 'O item da sequência é inválido.'))
    if (itemId === this.automaticItemId || itemId === this.sequenceItemStartingId) {
      return { outcome: 'unavailable', operation: 'remove', reason: 'SEQUENCE_ITEM_STARTING', state: this.getStatus() }
    }
    const index = this.pendingSequence.findIndex(item => item.id === itemId)
    if (index < 0) return { outcome: 'unavailable', operation: 'remove', reason: 'SEQUENCE_ITEM_UNAVAILABLE', state: this.getStatus() }
    this.pendingSequence.splice(index, 1)
    this.sequenceMutationRevision++
    this.notifyChanged()
    return { outcome: 'accepted', operation: 'remove', state: this.getStatus(), itemId }
  }

  reorderSequence(itemIds: readonly unknown[]): ManualPlaybackResult {
    this.ensureOpen()
    if (this.sequenceItemStartingId) {
      return { outcome: 'unavailable', operation: 'reorder', reason: 'SEQUENCE_ITEM_STARTING', state: this.getStatus() }
    }
    const ids = this.pendingSequence.map(item => item.id)
    if (!Array.isArray(itemIds) || itemIds.length !== ids.length ||
        itemIds.some(id => typeof id !== 'string') || new Set(itemIds).size !== ids.length ||
        ids.some(id => !itemIds.includes(id))) {
      return this.failure('reorder', new PlayerPlaybackError('INVALID_STATE', 'A nova ordem precisa conter cada item pendente exatamente uma vez.'))
    }
    if (this.automaticItemId && itemIds[0] !== this.automaticItemId) {
      return { outcome: 'unavailable', operation: 'reorder', reason: 'SEQUENCE_ITEM_STARTING', state: this.getStatus() }
    }
    const byId = new Map(this.pendingSequence.map(item => [item.id, item]))
    this.pendingSequence = itemIds.map(id => byId.get(id as string)!)
    this.sequenceMutationRevision++
    this.notifyChanged()
    return { outcome: 'accepted', operation: 'reorder', state: this.getStatus() }
  }

  clearSequence(): ManualPlaybackResult {
    this.ensureOpen()
    if (this.automaticItemId || this.sequenceItemStartingId) {
      return { outcome: 'unavailable', operation: 'clear', reason: 'SEQUENCE_ITEM_STARTING', state: this.getStatus() }
    }
    this.pendingSequence = []
    this.sequenceMutationRevision++
    this.notifyChanged()
    return { outcome: 'accepted', operation: 'clear', state: this.getStatus() }
  }

  async playByMusicCode(value: unknown, validateBeforeCommit?: () => void, recoveryAttemptId?: string): Promise<ManualPlaybackResult> {
    this.ensureOpen()
    if (this.currentRemoval) return this.unavailable('play', 'CURRENT_REMOVAL_IN_PROGRESS')
    let code: string
    try { code = normalizeCatalogCodeForVideoMatch(value) }
    catch (error) { return this.failure('play', error) }
    const previousState = this.playback.getState()
    const legacyContext = this.legacyNavigationContext
    const legacyCode = this.currentSequenceItem?.musicCode
    const revision = ++this.commandRevision
    this.activeAttemptId = undefined
    const result = await this.run('play', () => this.playback.playImmediately(code, validateBeforeCommit, recoveryAttemptId))
    if (revision === this.commandRevision && result.outcome === 'started') {
      this.activeAttemptId = result.state.attemptId
      if (legacyContext && legacyCode !== code) this.clearSequenceState()
      else {
        if (this.currentSequenceItem) this.previousSequence.push(this.currentSequenceItem)
        const queuedIndex = this.pendingSequence.findIndex(item => item.musicCode === code)
        this.currentSequenceItem = queuedIndex >= 0 ? this.pendingSequence.splice(queuedIndex, 1)[0] : null
      }
      this.reconcileNaturalEndAfterCommand(result.state)
    } else if (revision === this.commandRevision && result.outcome === 'uncertain') {
      this.activeAttemptId = undefined
    } else if (revision === this.commandRevision) {
      const state = this.playback.getState()
      if (state.attemptId && ['loading', 'ready', 'starting', 'playing', 'paused'].includes(state.status)) {
        this.activeAttemptId = state.attemptId
      } else if (state.status === 'completed') {
        this.activeAttemptId = state.attemptId
        this.reconcileNaturalEndAfterCommand(state, true)
      } else if (legacyContext && (state.attemptId !== previousState.attemptId || state.musicCode !== previousState.musicCode)) {
        this.clearSequenceState()
      }
    } else if (legacyContext) this.reconcileLegacyNavigationContext(result.state)
    if (revision === this.commandRevision) this.notifyChanged()
    return result
  }

  pause(): Promise<ManualPlaybackResult> {
    this.ensureOpen()
    if (this.currentRemoval) return Promise.resolve(this.unavailable('pause', 'CURRENT_REMOVAL_IN_PROGRESS'))
    return this.run('pause', () => this.playback.pause())
  }
  resume(): Promise<ManualPlaybackResult> {
    this.ensureOpen()
    if (this.currentRemoval) return Promise.resolve(this.unavailable('resume', 'CURRENT_REMOVAL_IN_PROGRESS'))
    return this.run('resume', () => this.playback.resume())
  }

  async restart(): Promise<ManualPlaybackResult> {
    this.ensureOpen()
    if (this.currentRemoval) return this.unavailable('restart', 'CURRENT_REMOVAL_IN_PROGRESS')
    const revision = ++this.commandRevision
    this.activeAttemptId = undefined
    const result = await this.run('restart', () => this.playback.restart())
    if (revision === this.commandRevision && result.outcome === 'accepted') {
      this.activeAttemptId = result.state.attemptId
      this.reconcileNaturalEndAfterCommand(result.state)
    } else if (revision === this.commandRevision && this.playback.getState().status === 'completed') {
      const state = this.playback.getState()
      this.activeAttemptId = state.attemptId
      this.reconcileNaturalEndAfterCommand(state, true)
    }
    return result
  }

  async stop(): Promise<ManualPlaybackResult> {
    this.ensureOpen()
    if (this.currentRemoval) return this.unavailable('stop', 'CURRENT_REMOVAL_IN_PROGRESS')
    ++this.commandRevision
    this.activeAttemptId = undefined
    return this.run('stop', () => this.playback.stop())
  }

  /** Closes command admission before an explicit shutdown stop is sent. */
  async stopAndClose(): Promise<ManualPlaybackResult> {
    this.ensureOpen()
    this.disposed = true
    this.activeAttemptId = undefined
    this.unsubscribePlayback?.()
    this.batchRequests.clear()
    return this.run('stop', () => this.playback.stop())
  }

  next(): Promise<ManualPlaybackResult> {
    this.ensureOpen()
    if (this.currentRemoval) return Promise.resolve(this.unavailable('next', 'CURRENT_REMOVAL_IN_PROGRESS'))
    if (this.sequenceItemStartingId) return Promise.resolve(this.unavailable('next', 'SEQUENCE_ITEM_STARTING'))
    if (this.automaticItemId) {
      return Promise.resolve({ outcome: 'unavailable', operation: 'next', reason: 'AUTOMATIC_ADVANCE_IN_PROGRESS', state: this.getStatus() })
    }
    if (this.pendingSequence.length === 0) {
      return Promise.resolve(this.currentSequenceItem
        ? { outcome: 'boundary', operation: 'next', reason: 'SEQUENCE_BOUNDARY', state: this.getStatus() }
        : { outcome: 'unavailable', operation: 'next', reason: 'NO_SEQUENCE', state: this.getStatus() })
    }
    return this.playSequenceItem('next', this.pendingSequence[0])
  }

  previous(): Promise<ManualPlaybackResult> {
    this.ensureOpen()
    if (this.currentRemoval) return Promise.resolve(this.unavailable('previous', 'CURRENT_REMOVAL_IN_PROGRESS'))
    if (this.sequenceItemStartingId) return Promise.resolve(this.unavailable('previous', 'SEQUENCE_ITEM_STARTING'))
    if (this.automaticItemId) {
      return Promise.resolve({ outcome: 'unavailable', operation: 'previous', reason: 'AUTOMATIC_ADVANCE_IN_PROGRESS', state: this.getStatus() })
    }
    const previous = this.previousSequence.at(-1)
    if (!previous) {
      return Promise.resolve(this.currentSequenceItem
        ? { outcome: 'boundary', operation: 'previous', reason: 'SEQUENCE_BOUNDARY', state: this.getStatus() }
        : { outcome: 'unavailable', operation: 'previous', reason: 'NO_SEQUENCE', state: this.getStatus() })
    }
    return this.playSequenceItem('previous', previous)
  }

  /** Stops and removes only the selected active item; pending items remain stopped in their existing order. */
  async removeCurrent(itemId: unknown, attemptId: unknown): Promise<ManualPlaybackResult> {
    this.ensureOpen()
    if ((itemId !== null && (typeof itemId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(itemId))) ||
        typeof attemptId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(attemptId)) {
      return this.unavailable('remove-current', 'INVALID_CURRENT_SELECTION')
    }
    const current = this.currentSequenceItem
    const state = this.playback.getState()
    if ((current ? current.id !== itemId : itemId !== null) || state.attemptId !== attemptId ||
        !['loading', 'ready', 'starting', 'playing', 'paused'].includes(state.status)) {
      return this.unavailable('remove-current', 'STALE_CURRENT_SELECTION')
    }
    if (this.currentRemoval) return this.unavailable('remove-current', 'CURRENT_REMOVAL_IN_PROGRESS')
    this.currentRemoval = { itemId, attemptId }
    this.notifyChanged()
    try {
      const stopped = await this.run('stop', () => this.playback.stop(attemptId))
      if (stopped.outcome !== 'accepted' || stopped.state.status !== 'stopped' || stopped.state.attemptId !== attemptId ||
          stopped.state.containmentStatus !== 'stop-acknowledged') {
        return { ...stopped, operation: 'remove-current' } as ManualPlaybackResult
      }
      if (!this.playback.clearStoppedMedia || !await this.playback.clearStoppedMedia(attemptId)) {
        return this.unavailable('remove-current', 'MEDIA_CLEAR_UNCONFIRMED')
      }
      const afterClear = this.playback.getState()
      const selectionStillCurrent = itemId === null
        ? this.currentSequenceItem === null
        : this.currentSequenceItem?.id === itemId
      if (!selectionStillCurrent || afterClear.status !== 'idle') {
        return this.unavailable('remove-current', 'STALE_CURRENT_SELECTION')
      }
      this.activeAttemptId = undefined
      if (itemId !== null) this.currentSequenceItem = null
      this.legacyNavigationContext = false
      this.sequenceMutationRevision++
      this.notifyChanged()
      return { outcome: 'accepted', operation: 'remove-current', state: afterClear, ...(itemId ? { itemId } : {}) }
    } catch (error) {
      const result = this.failure('remove-current', error)
      if (result.outcome === 'failed' && result.reason === 'SUPERSEDED') {
        return this.unavailable('remove-current', 'STALE_CURRENT_SELECTION')
      }
      return result
    } finally {
      if (this.currentRemoval?.itemId === itemId && this.currentRemoval.attemptId === attemptId) {
        this.currentRemoval = undefined
        this.notifyChanged()
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.activeAttemptId = undefined
    this.automaticItemId = undefined
    this.sequenceItemStartingId = undefined
    this.currentRemoval = undefined
    this.unsubscribePlayback?.()
    this.batchRequests.clear()
    this.pendingSequence = []
    this.previousSequence = []
    this.currentSequenceItem = null
    this.legacyNavigationContext = false
    this.listeners.clear()
  }

  private async playSequenceItem(operation: 'next' | 'previous', item: ManualSequenceItem): Promise<ManualPlaybackResult> {
    const commandRevision = this.commandRevision
    this.sequenceItemStartingId = item.id
    this.activeAttemptId = undefined
    try {
      const result = await this.run(operation, () => this.playback.playImmediately(item.musicCode, () => {
        if (this.disposed || commandRevision !== this.commandRevision ||
            this.sequenceItemStartingId !== item.id || !this.isSequenceItemAtExpectedPosition(operation, item)) {
          throw new PlayerPlaybackError('SUPERSEDED', 'A ordem da sequência mudou antes de iniciar a música.')
        }
      }))
      if (commandRevision !== this.commandRevision || this.disposed ||
          !this.isSequenceItemAtExpectedPosition(operation, item)) {
        if (result.outcome === 'started' && this.playback.getState().attemptId === result.state.attemptId) {
          this.activeAttemptId = result.state.attemptId
        }
        this.reconcileLegacyNavigationContext(result.state)
        return result
      }
      if (result.outcome === 'started') {
        if (operation === 'next') {
          if (this.pendingSequence[0]?.id === item.id) this.pendingSequence.shift()
          if (this.currentSequenceItem && this.currentSequenceItem.id !== item.id) this.previousSequence.push(this.currentSequenceItem)
        } else {
          if (this.previousSequence.at(-1)?.id === item.id) this.previousSequence.pop()
          if (this.currentSequenceItem && this.currentSequenceItem.id !== item.id) this.pendingSequence.unshift(this.currentSequenceItem)
        }
        this.currentSequenceItem = item
        this.legacyNavigationContext = false
        this.activeAttemptId = result.state.attemptId
        this.reconcileNaturalEndAfterCommand(result.state)
        this.notifyChanged()
      } else if (result.outcome === 'uncertain') this.activeAttemptId = undefined
      else {
        const state = this.playback.getState()
        this.activeAttemptId = state.attemptId
        if (state.status === 'completed') this.reconcileNaturalEndAfterCommand(state, true)
      }
      return result
    } finally {
      if (this.sequenceItemStartingId === item.id) {
        this.sequenceItemStartingId = undefined
        this.notifyChanged()
      }
    }
  }

  private isSequenceItemAtExpectedPosition(operation: 'next' | 'previous', item: ManualSequenceItem): boolean {
    return operation === 'next'
      ? this.pendingSequence[0]?.id === item.id
      : this.previousSequence.at(-1)?.id === item.id
  }

  private handlePlaybackEvent(event: PlayerPlaybackEvent): void {
    if (event.type !== 'natural-end-candidate' || !this.options.autoAdvanceOnNaturalEnd || !event.attemptId) return
    if (event.attemptId !== this.activeAttemptId) {
      if (!this.activeAttemptId) {
        this.earlyNaturalEnds.set(event.attemptId, event)
        while (this.earlyNaturalEnds.size > 64) this.earlyNaturalEnds.delete(this.earlyNaturalEnds.keys().next().value!)
      }
      return
    }
    this.acceptNaturalEnd(event, this.currentRemoval?.attemptId === event.attemptId)
  }

  private acceptNaturalEnd(event: Extract<PlayerPlaybackEvent, { type: 'natural-end-candidate' }>, suppressAutoAdvance = false): void {
    if (this.handledNaturalEnds.has(event.attemptId)) return
    const state = this.playback.getState()
    if (state.status !== 'completed' || state.attemptId !== event.attemptId || state.musicCode !== event.musicCode) return
    this.handledNaturalEnds.add(event.attemptId)
    while (this.handledNaturalEnds.size > 128) this.handledNaturalEnds.delete(this.handledNaturalEnds.values().next().value!)
    this.activeAttemptId = undefined
    if (this.currentSequenceItem) this.previousSequence.push(this.currentSequenceItem)
    this.currentSequenceItem = null
    this.legacyNavigationContext = false
    this.notifyChanged()
    const revision = this.commandRevision
    if (this.pendingSequence.length === 0 || suppressAutoAdvance) {
      if (this.playback.clearCompletedMedia) {
        // The playback service publishes a correlated surface-cleanup-failed event if
        // clearing and bounded host termination both fail; the confirmed EOF stays intact.
        void this.playback.clearCompletedMedia(event.attemptId).catch(() => undefined)
      }
      return
    }
    const next = this.pendingSequence[0]
    this.automaticItemId = next.id
    const task = this.advanceAfterNaturalEnd(event.attemptId, next, revision)
    this.autoAdvanceTask = task
    void task.finally(() => {
      if (this.autoAdvanceTask === task) {
        this.autoAdvanceTask = undefined
        this.automaticItemId = undefined
      }
    })
  }

  private async advanceAfterNaturalEnd(attemptId: string, item: ManualSequenceItem, revision: number): Promise<void> {
    if (revision !== this.commandRevision || this.disposed || this.pendingSequence[0]?.id !== item.id) return
    try {
      const state = await this.playback.playImmediately(item.musicCode, () => {
        const current = this.playback.getState()
        if (revision !== this.commandRevision || this.disposed || this.automaticItemId !== item.id ||
            this.pendingSequence[0]?.id !== item.id || current.status !== 'completed' || current.attemptId !== attemptId) {
          throw new PlayerPlaybackError('SUPERSEDED', 'A sequência mudou antes de iniciar o próximo item.')
        }
      })
      if (revision !== this.commandRevision || this.disposed || this.pendingSequence[0]?.id !== item.id ||
          state.status === 'failed' || state.status === 'uncertain' || !state.attemptId) return
      this.pendingSequence.shift()
      if (this.currentSequenceItem) this.previousSequence.push(this.currentSequenceItem)
      this.currentSequenceItem = item
      this.activeAttemptId = state.attemptId
      this.reconcileNaturalEndAfterCommand(state)
      this.notifyChanged()
    } catch {
      // Keep the failed item at the head. Errors never skip or auto-advance the local sequence.
    }
  }

  private reconcileNaturalEndAfterCommand(state: PlayerPlaybackState, suppressAutoAdvance = false): void {
    if (state.status !== 'completed' || !state.attemptId || !this.options.autoAdvanceOnNaturalEnd) return
    const candidate = this.earlyNaturalEnds.get(state.attemptId)
    if (!candidate) return
    this.earlyNaturalEnds.delete(state.attemptId)
    this.acceptNaturalEnd(candidate, suppressAutoAdvance)
  }

  private reconcileLegacyNavigationContext(state: PlayerPlaybackState = this.playback.getState()): void {
    if (!this.legacyNavigationContext) return
    if (!this.currentSequenceItem || state.musicCode !== this.currentSequenceItem.musicCode) this.clearSequenceState()
  }

  private clearSequenceState(): void {
    this.currentSequenceItem = null
    this.pendingSequence = []
    this.previousSequence = []
    this.legacyNavigationContext = false
  }

  private notifyChanged(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* UI observers cannot affect sequence coordination. */ }
    }
  }

  private async run(operation: ManualPlaybackOperation,
    command: () => Promise<PlayerPlaybackState>): Promise<ManualPlaybackResult> {
    try {
      const state = await command()
      if (state.status === 'uncertain') return { outcome: 'uncertain', operation, reason: state.errorCode ?? 'COMMAND_OUTCOME_UNKNOWN', state }
      if (state.status === 'failed') return { outcome: 'failed', operation, reason: state.errorCode ?? 'PLAYBACK_FAILED', state }
      return { outcome: operation === 'play' || operation === 'next' || operation === 'previous' ? 'started' : 'accepted', operation, state }
    } catch (error) { return this.failure(operation, error) }
  }

  private failure(operation: ManualPlaybackResult['operation'], error: unknown): ManualPlaybackResult {
    const reason = errorCode(error)
    const state = this.getStatus()
    if (state.status === 'uncertain' || reason === 'COMMAND_TIMEOUT' || reason === 'HOST_TERMINATED') {
      return { outcome: 'uncertain', operation: operation as ManualPlaybackOperation, reason, state }
    }
    if (['HOST_UNAVAILABLE', 'HOST_NOT_READY', 'MEDIA_UNAVAILABLE', 'MEDIA_AMBIGUOUS', 'MEDIA_UNKNOWN', 'RECOVERY_UNAVAILABLE', 'RECOVERY_PENDING'].includes(reason)) {
      return { outcome: 'unavailable', operation, reason, state }
    }
    return { outcome: 'failed', operation, reason, state }
  }

  private unavailable(operation: ManualPlaybackResult['operation'], reason: string): ManualPlaybackResult {
    return { outcome: 'unavailable', operation, reason, state: this.getStatus() }
  }

  private ensureOpen(): void {
    if (this.disposed) throw new PlayerPlaybackError('DISPOSED', 'O serviço manual de reprodução foi encerrado.')
  }
}
