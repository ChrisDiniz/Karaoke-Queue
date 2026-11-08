import type { FileLogger } from './logging'
import type { StandalonePlayerMainIpcBridge } from './standalone-player-ipc'
import type { StandalonePlayerSequence } from './standalone-player-sequence'
import type { PlayerPlaybackService } from './player-playback-service'
import type { PlayerPlaybackRecoveryCoordinator } from './player-playback-recovery'
import type { PlayerVideoWindow } from './player-video-window'

export interface MainStandaloneShutdownDependencies {
  getBridge(): StandalonePlayerMainIpcBridge | undefined
  getSequence(): StandalonePlayerSequence | undefined
  getRecovery(): PlayerPlaybackRecoveryCoordinator | undefined
  getPlayback(): PlayerPlaybackService | undefined
  getVideoWindow(): PlayerVideoWindow | undefined
  logger: Pick<FileLogger, 'info' | 'error'>
  quit(): void
  setQuitAuthorized(value: boolean): void
  setPlayerQuitAllowed(value: boolean): void
  setShutdownFailed(value: boolean): void
  setTerminalFailure(value: boolean): void
  showShutdownFailure(options: Electron.MessageBoxOptions): Promise<unknown>
}

export function canFinishStandaloneShutdown(
  recovery: ReturnType<PlayerPlaybackRecoveryCoordinator['verifyPersistedState']>,
  playback: ReturnType<PlayerPlaybackService['getState']> | undefined
): boolean {
  if (recovery.status === 'unreadable' || recovery.status === 'unavailable') return false
  if (!playback) return recovery.status === 'none' || recovery.status === 'pending' || recovery.status === 'resolved'
  const hasAttempt = Boolean(playback.attemptId)
  const confirmedContainment = ['stop-acknowledged', 'host-terminated'].includes(playback.containmentStatus ?? '')

  if (['loading', 'starting', 'ready', 'playing', 'paused', 'stopping'].includes(playback.status)) return false
  if (playback.status === 'uncertain') {
    return confirmedContainment && playback.errorCode !== 'RECOVERY_PERSISTENCE_FAILED' &&
      recovery.status === 'pending' && recovery.attemptId === playback.attemptId &&
      ['host-terminated', 'containment-updated'].includes(recovery.lastTransition)
  }
  if (playback.status === 'disposed' && hasAttempt) {
    if (recovery.status === 'resolved') {
      return recovery.attemptId === playback.attemptId &&
        (recovery.outcome === 'stopped' || recovery.outcome === 'completed' || recovery.outcome === 'failed')
    }
    return confirmedContainment && playback.errorCode !== 'RECOVERY_PERSISTENCE_FAILED' &&
      recovery.status === 'pending' && recovery.attemptId === playback.attemptId &&
      ['host-terminated', 'containment-updated'].includes(recovery.lastTransition)
  }
  if (playback.status === 'stopped' && hasAttempt) {
    return confirmedContainment && recovery.status === 'resolved' && recovery.outcome === 'stopped' &&
      recovery.attemptId === playback.attemptId
  }
  if (playback.status === 'completed' && hasAttempt) {
    return recovery.status === 'resolved' && recovery.outcome === 'completed' && recovery.attemptId === playback.attemptId
  }
  if (playback.status === 'failed' && hasAttempt) {
    return recovery.status === 'resolved' && recovery.outcome === 'failed' && recovery.attemptId === playback.attemptId
  }
  if (!hasAttempt) return recovery.status === 'none' || recovery.status === 'pending' || recovery.status === 'resolved'
  return playback.status === 'disposed' && recovery.status === 'resolved' && recovery.attemptId === playback.attemptId
}

export function withShutdownDeadline<T>(promise: Promise<T>, deadline: number, code: string): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.reject(new Error(code))
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(code)), remaining)
    })
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

/** Coordinates the existing shutdown protocol without owning playback or sequence resources. */
export class MainStandaloneShutdownCoordinator {
  private shutdownPromise: Promise<void> | undefined
  private terminalFailure = false

  constructor(private readonly deps: MainStandaloneShutdownDependencies) {}

  get hasTerminalFailure(): boolean { return this.terminalFailure }

  begin(): Promise<void> {
    if (this.terminalFailure) return Promise.resolve()
    if (this.shutdownPromise) return this.shutdownPromise
    const bridge = this.deps.getBridge()
    const sequence = this.deps.getSequence()
    if (!bridge || !sequence) return Promise.reject(new Error('STANDALONE_SHUTDOWN_UNAVAILABLE'))

    this.deps.setShutdownFailed(false)
    const deadline = Date.now() + 30_000
    let irreversibleDisposalStarted = false
    let shutdownStopStarted = false
    let sequenceShutdownStarted = false
    let sequenceShutdownCompleted = false
    this.shutdownPromise = (async () => {
      const recoveryBeforeShutdown = this.deps.getRecovery()?.verifyPersistedState() ?? { status: 'none' as const }
      if (recoveryBeforeShutdown.status === 'unreadable' || recoveryBeforeShutdown.status === 'unavailable') {
        throw new Error(`RECOVERY_PRESERVATION_UNVERIFIED:${recoveryBeforeShutdown.status}`)
      }
      await withShutdownDeadline(bridge.beginCloseAdmission(), deadline, 'IPC_DRAIN_TIMEOUT')
      sequenceShutdownStarted = true
      await withShutdownDeadline(sequence.beginShutdown(), deadline, 'SEQUENCE_DRAIN_TIMEOUT')
      sequenceShutdownCompleted = true

      const playbackService = this.deps.getPlayback()
      const currentPlayback = playbackService?.getState()
      if (currentPlayback?.attemptId &&
          ['loading', 'starting', 'ready', 'playing', 'paused', 'stopping'].includes(currentPlayback.status)) {
        shutdownStopStarted = true
        try {
          await withShutdownDeadline(playbackService!.stopForShutdown(currentPlayback.attemptId), deadline,
            'PLAYBACK_STOP_TIMEOUT')
        } catch (error) {
          const afterStopFailure = playbackService!.getState()
          if (afterStopFailure.status === 'uncertain' &&
              !['stop-acknowledged', 'host-terminated'].includes(afterStopFailure.containmentStatus ?? '')) {
            await withShutdownDeadline(playbackService!.retryShutdownContainment(), deadline,
              'PLAYBACK_CONTAINMENT_RETRY_TIMEOUT').catch(() => undefined)
          } else if (!['uncertain', 'completed', 'stopped', 'failed'].includes(afterStopFailure.status)) {
            throw error
          }
        }
      } else if (currentPlayback?.status === 'uncertain' &&
          !['stop-acknowledged', 'host-terminated'].includes(currentPlayback.containmentStatus ?? '')) {
        shutdownStopStarted = true
        await withShutdownDeadline(playbackService!.retryShutdownContainment(), deadline,
          'PLAYBACK_CONTAINMENT_RETRY_TIMEOUT')
      }

      const recoveryService = this.deps.getRecovery()
      const verifiedRecovery = recoveryService?.verifyPersistedState() ?? { status: 'none' as const }
      const verifiedPlayback = this.deps.getPlayback()?.getState()
      if (!canFinishStandaloneShutdown(verifiedRecovery, verifiedPlayback)) {
        const recoveryStatus = verifiedRecovery.status
        const playbackStatus = verifiedPlayback?.status ?? 'unavailable'
        const containment = verifiedPlayback?.containmentStatus ?? 'unavailable'
        throw new Error(`RECOVERY_OR_CONTAINMENT_UNVERIFIED:${recoveryStatus}:${playbackStatus}:${containment}`)
      }

      irreversibleDisposalStarted = true
      await withShutdownDeadline(sequence.dispose(), deadline, 'SEQUENCE_DISPOSE_TIMEOUT')
      await withShutdownDeadline(this.deps.getVideoWindow()?.dispose() ?? Promise.resolve(), deadline, 'VIDEO_HOST_DISPOSE_TIMEOUT')

      const recovery = this.deps.getRecovery()?.verifyPersistedState() ?? { status: 'none' as const }
      const playback = this.deps.getPlayback()?.getState()
      if (!canFinishStandaloneShutdown(recovery, playback)) {
        throw new Error(`RECOVERY_OR_CONTAINMENT_UNVERIFIED_AFTER_DISPOSE:${recovery.status}:${playback?.status ?? 'unavailable'}`)
      }

      this.deps.setQuitAuthorized(true)
      this.deps.setShutdownFailed(false)
      this.deps.setPlayerQuitAllowed(true)
      this.deps.getVideoWindow()?.allowWindowClose()
      this.deps.logger.info('player', 'STANDALONE_SHUTDOWN_CONFIRMED', 'A sequência, a reprodução e o estado de recuperação foram coordenados para saída.', {
        recoveryStatus: recovery.status,
        playbackStatus: playback?.status ?? 'unavailable'
      })
      this.deps.quit()
    })().catch(async error => {
      this.deps.setShutdownFailed(true)
      if (irreversibleDisposalStarted) {
        this.terminalFailure = true
        this.deps.setTerminalFailure(true)
      }
      else this.shutdownPromise = undefined

      let sequenceAdmissionRestored = false
      if (!irreversibleDisposalStarted && sequenceShutdownCompleted && !shutdownStopStarted) {
        let playbackKnownIdle = this.deps.getPlayback() === undefined
        try {
          const playback = this.deps.getPlayback()?.getState()
          playbackKnownIdle = playback !== undefined && playback.status === 'idle' && !playback.attemptId
        } catch { /* Keep the sequence fenced when the playback owner cannot confirm idle. */ }
        if (playbackKnownIdle) {
          try {
            await withShutdownDeadline(sequence.resumeAfterFailedShutdown(), Date.now() + 5_000, 'SEQUENCE_RESUME_TIMEOUT')
            bridge.resumeAdmissionAfterFailedShutdown()
            sequenceAdmissionRestored = true
          } catch (resumeError) {
            this.deps.logger.error('player', 'STANDALONE_SHUTDOWN_RESUME_FAILED',
              'A sequência permaneceu protegida porque não foi possível restaurá-la após a falha de saída.', resumeError)
          }
        }
      }
      if (!irreversibleDisposalStarted && !sequenceShutdownStarted) {
        try { bridge.resumeAdmissionAfterFailedShutdown() } catch { /* Preserve the confirmed close state if transport teardown already started. */ }
      }
      this.deps.logger.error('player', 'STANDALONE_SHUTDOWN_FAILED', 'O Reprodutor permaneceu aberto porque o encerramento seguro não foi confirmado.', error)
      if (!irreversibleDisposalStarted) {
        try { bridge.resetExitConfirmationAfterFailedShutdown() } catch { /* Keep the process alive if a decision is still in flight. */ }
      }
      const detail = error instanceof Error ? error.message : String(error)
      const retryGuidance = irreversibleDisposalStarted
        ? 'O descarte de recursos já começou. O aplicativo não foi considerado encerrado com segurança e não fará nova tentativa automática. Mantenha o processo aberto e trate esta falha antes de encerrar o Windows.'
        : sequenceAdmissionRestored
          ? 'A reprodução estava ociosa, então a sequência e suas admissões foram restauradas. Feche esta mensagem e solicite a saída novamente para repetir a coordenação.'
          : 'O aplicativo permanece protegido. Se a causa for recuperável, solicite a saída novamente para repetir a coordenação.'
      await this.deps.showShutdownFailure({
        type: 'error', title: 'Não foi possível encerrar com segurança',
        message: 'O aplicativo permanecerá aberto. O estado de recuperação foi preservado ou não pôde ser confirmado.',
        detail: `${detail}\n\n${retryGuidance}`,
        buttons: ['Voltar ao Player'], defaultId: 0
      }).catch(() => undefined)
    })
    return this.shutdownPromise
  }
}
