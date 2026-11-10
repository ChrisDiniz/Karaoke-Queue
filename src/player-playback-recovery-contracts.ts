import type { PlayerPlaybackState } from './player-playback-contracts'

export type PlayerRecoverySnapshot =
  | { status: 'none' }
  | { status: 'pending'; attemptId: string; musicCode: string; playbackStatus: PlayerPlaybackState['status']; lastTransition: string; updatedAt: string }
  | { status: 'resolved'; outcome: 'completed' | 'stopped' | 'failed' | 'dismissed'; attemptId?: string; musicCode?: string; updatedAt: string }
  | { status: 'unreadable'; reason: 'INVALID_RECORD' | 'UNREADABLE' | 'UNSUPPORTED_VERSION' }
  | { status: 'unavailable'; reason: 'WRITE_FAILED' }

export interface PlayerRecoveryDiagnosticSummary {
  readonly code: 'INVALID_RECORD' | 'UNREADABLE' | 'UNSUPPORTED_VERSION' | 'WRITE_FAILED'
  readonly message: string
}

export type PlayerShutdownRequest =
  | { outcome: 'allowed' }
  | { outcome: 'confirmation-required'; attemptId: string; musicCode?: string; playbackStatus: PlayerPlaybackState['status'] }

export type PlayerShutdownResult =
  | { outcome: 'cancelled'; attemptId: string }
  | { outcome: 'stopped'; attemptId: string; recovery: PlayerRecoverySnapshot }
  | { outcome: 'completed'; attemptId: string; recovery: PlayerRecoverySnapshot }
  | { outcome: 'uncertain'; attemptId: string; recovery: PlayerRecoverySnapshot }
