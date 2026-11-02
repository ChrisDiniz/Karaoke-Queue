export type PlayerPlaybackStatus =
  | 'idle'
  | 'loading'
  | 'starting'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'failed'
  | 'uncertain'
  | 'disposed'

export interface PlayerPlaybackState {
  status: PlayerPlaybackStatus
  attemptId?: string
  musicCode?: string
  errorCode?: PlayerPlaybackErrorCode
  /** Result of bounded cleanup after an uncertain command; it does not resolve the song outcome. */
  containmentStatus?: 'pending' | 'stop-acknowledged' | 'host-terminated' | 'unavailable' | 'unconfirmed'
}

export interface PlayerPlaybackProgress {
  readonly attemptId: string
  readonly currentTime: number
  readonly duration: number | null
}

export type PlayerPlaybackErrorCode =
  | 'INVALID_MUSIC_CODE'
  | 'HOST_UNAVAILABLE'
  | 'HOST_NOT_READY'
  | 'HOST_TERMINATED'
  | 'MEDIA_UNAVAILABLE'
  | 'MEDIA_AMBIGUOUS'
  | 'MEDIA_UNKNOWN'
  | 'MEDIA_LOAD_FAILED'
  | 'INVALID_STATE'
  | 'COMMAND_TIMEOUT'
  | 'SUPERSEDED'
  | 'PLAYBACK_FAILED'
  | 'DISPOSED'
  | 'HOST_CONTAINMENT_FAILED'
  | 'RECOVERY_UNAVAILABLE'
  | 'RECOVERY_PENDING'
  | 'RECOVERY_PERSISTENCE_FAILED'

export class PlayerPlaybackError extends Error {
  constructor(readonly code: PlayerPlaybackErrorCode, message: string) {
    super(message)
    this.name = 'PlayerPlaybackError'
  }
}

export type PlayerPlaybackHostCommand =
  | { type: 'load'; commandId: string; attemptId: string; musicCode: string; mediaUrl: string }
  | { type: 'play' | 'pause' | 'stop'; commandId: string; attemptId: string }

export interface PlayerPlaybackMediaObservation {
  type: 'loadedmetadata' | 'timeupdate' | 'playing' | 'pause' | 'ended' | 'error' | 'emptied' | 'waiting' | 'stalled'
  currentTime?: number
  duration?: number
  videoWidth?: number
  videoHeight?: number
  mediaErrorCode?: number
}

export type PlayerPlaybackHostEvent =
  | { type: 'media'; hostEpoch: string; attemptId: string; sequenceNumber: number; observation: PlayerPlaybackMediaObservation }
  | { type: 'terminated'; hostEpoch: string }

export interface PlayerPlaybackHost {
  readonly hostEpoch: string
  readonly ready: Promise<void>
  send(command: PlayerPlaybackHostCommand): Promise<void>
  subscribe(listener: (event: PlayerPlaybackHostEvent) => void): () => void
  /** Terminates only this playback host and confirms WebContents destruction when true. */
  terminate(): Promise<boolean>
  dispose(): void
}

export interface PlayerMediaGrant {
  readonly url: string
  revoke(): void
}

export interface PlayerMediaSourceProvider {
  grant(musicCode: string, inventoryRevision: string): PlayerMediaGrant
}

export type PlayerPlaybackEvent =
  | { type: 'state-changed'; state: PlayerPlaybackState }
  | { type: 'progress'; attemptId: string; currentTime: number; duration: number | null }
  | { type: 'natural-end-candidate'; attemptId: string; musicCode: string; duration: number; endedAt: string }
  | { type: 'interrupted'; attemptId: string; musicCode: string; reason: 'stop' | 'replace' | 'restart' | 'host-terminated' }
  | { type: 'uncertain'; attemptId: string; musicCode: string; reason: 'invalid-ended-evidence' | 'host-terminated' | 'command-outcome-unknown' }
  | { type: 'error'; attemptId?: string; musicCode?: string; errorCode: PlayerPlaybackErrorCode }

export type PlayerPlaybackListener = (event: PlayerPlaybackEvent) => void

export type PlayerPlaybackPersistenceTransition =
  | 'load-intent'
  | 'media-ready'
  | 'play-intent'
  | 'playback-started'
  | 'pause-intent'
  | 'playback-paused'
  | 'resume-intent'
  | 'stop-intent'
  | 'stop-confirmed'
  | 'replacement-stop-intent'
  | 'replacement-interrupted'
  | 'natural-end-confirmed'
  | 'playback-failed'
  | 'playback-uncertain'
  | 'host-terminated'
  | 'containment-updated'
  | 'shutdown-stop-intent'
  | 'shutdown-confirmed'
  | 'recovery-dismissed'
  | 'invalid-recovery-resolved'

/** Synchronous durable boundary called before a state or side effect is published. */
export interface PlayerPlaybackPersistence {
  /** Rejects new attempts while an unresolved recovery record exists. */
  assertPlaybackAllowed?(recoveryAttemptId?: string): void
  persistTransition(
    nextState: PlayerPlaybackState,
    previousState: PlayerPlaybackState,
    transition: PlayerPlaybackPersistenceTransition
  ): void
}
