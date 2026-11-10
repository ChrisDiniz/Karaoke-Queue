import type {
  PlayerPlaybackErrorCode,
  PlayerPlaybackEvent,
  PlayerPlaybackListener,
  PlayerPlaybackPersistence,
  PlayerPlaybackRecoveryTarget,
  PlayerPlaybackState
} from './player-playback-contracts'
import type { PlayerRecoverySnapshot } from './player-playback-recovery-contracts'
import type { MusicCatalogService } from './music-catalog-service'

/** The three user-facing operational states defined by the Standalone V1. */
export type StandaloneOperationalState = 'idle' | 'playing' | 'paused'

/** Owner-approved copy options for the natural-EOF celebration screen. */
export const STANDALONE_CELEBRATION_MESSAGES = Object.freeze([
  'O palco foi todo seu!',
  'Você brilhou até a última nota!',
  'Aplausos para você!',
  'Que apresentação!',
  'Você fez bonito do início ao fim!',
  'Que energia no palco!',
  'Você fechou com chave de ouro!',
  'Parabéns pelo show!',
  'Que voz, que presença!',
  'Você arrasou!',
  'Essa música ganhou vida com você!',
  'Uma salva de palmas para essa interpretação!',
  'O microfone agradece!',
  'Essa foi para cantar junto!',
  'A última nota foi especial!',
  'Você deu vida a essa canção!',
  'Que final de arrepiar!',
  'Uma apresentação para guardar!',
  'O palco ainda está vibrando!',
  'Mais uma música, mais um grande momento!',
  'A música acabou, o brilho continua!',
  'Seu momento no palco foi demais!',
  'Você levou essa até o fim em grande estilo!',
  'Mais um sucesso no karaokê!',
  'Pode soltar o aplauso!',
  'O show foi seu — parabéns!',
  'Que jeito bom de terminar a música!',
  'Você merece esse aplauso!',
  'Mais um momento inesquecível!',
  'A fila espera; este aplauso é seu!',
  'A música acabou, mas o microfone já está pedindo bis.',
  'Última nota entregue. O microfone vai tirar uma folga.',
  'O refrão terminou; agora ele pode sair da sua cabeça… talvez.',
  'O palco está aplaudindo. O microfone também, mas ele é suspeito.',
  'Canção concluída! Confetes virtuais ativados na imaginação.',
  'Essa terminou tão bem que até o botão de avançar bateu palmas.',
  'O microfone já está contando essa história para a caixa de som.',
  'Fim da música: todo mundo pode respirar — inclusive o microfone.',
  'O show acabou por enquanto. O microfone já está escolhendo o próximo sucesso.',
  'Música concluída. A fila está pronta para o próximo capítulo musical.'
] as const)

export type StandaloneCelebrationMessage = typeof STANDALONE_CELEBRATION_MESSAGES[number]

/** Engine condition is separate from the V1 operational state. */
export type StandalonePlaybackCondition = 'ready' | 'blocked' | 'uncertain'

/** One occurrence in the volatile Standalone sequence; repeated codes remain distinct entries. */
export interface StandaloneQueueEntry {
  readonly entryId: string
  /** Canonical five-digit code resolved by Main before the entry is admitted. */
  readonly musicCode: string
}

/** A queue occurrence reserved for a technical start/restart, possibly before attemptId is known. */
export interface StandalonePlaybackReservation extends StandaloneQueueEntry {
  readonly attemptId?: string
}

/** Current entry correlates a queue occurrence with a confirmed shared playback attempt. */
export interface StandaloneCurrentEntry extends StandalonePlaybackReservation {
  readonly attemptId: string
}

/** Current playback plus a separately reserved entry whose start has not committed yet. */
export interface StandalonePlaybackCorrelation {
  readonly current: StandaloneCurrentEntry | null
  readonly reservation: StandalonePlaybackReservation | null
}

/** Stable snapshots enforce the V1 invariant that idle has no current or pending entries. */
export type StandaloneStableState =
  | {
      readonly operationalState: 'idle'
      readonly current: null
      readonly pending: readonly []
    }
  | {
      readonly operationalState: 'playing' | 'paused'
      readonly current: StandaloneCurrentEntry
      readonly pending: readonly StandaloneQueueEntry[]
    }

export interface StandaloneReadySnapshot {
  readonly playbackCondition: 'ready'
  readonly state: StandaloneStableState
}

/** A technical transition is in flight; it is deliberately not exposed as a V1 operational state. */
interface StandaloneTransitioningSnapshotBase {
  readonly playbackCondition: 'transitioning'
  readonly lastConfirmedState: StandaloneStableState
  /** Includes a reserved head until its start is confirmed. */
  readonly pending: readonly StandaloneQueueEntry[]
}

export type StandaloneTransitioningSnapshot = StandaloneTransitioningSnapshotBase & (
  | { readonly phase: 'operation' }
  | { readonly phase: 'resuming' }
  | {
      readonly phase: 'countdown'
      readonly target: StandaloneQueueEntry
      readonly remainingMs: number
      readonly paused: boolean
    }
  | { readonly phase: 'loading'; readonly target: StandaloneQueueEntry }
  | {
      readonly phase: 'celebration'
      readonly remainingMs: number
      readonly paused: boolean
      readonly message: StandaloneCelebrationMessage
    }
)

/**
 * A blocked/uncertain snapshot is not an operational V1 state. It preserves
 * the last stable state and every pending entry without claiming playback is idle.
 */
interface StandaloneUnavailableSnapshotData {
  readonly lastConfirmedState: StandaloneStableState
  /** Current authoritative pending sequence; it may differ after a confirmed EOF/Stop. */
  readonly pending: readonly StandaloneQueueEntry[]
  readonly error: StandalonePlayerError
}

export type StandaloneUnavailableSnapshot = StandaloneUnavailableSnapshotData &
  ({ readonly playbackCondition: 'blocked' } | { readonly playbackCondition: 'uncertain' })

export type StandaloneUncertainSnapshot = Extract<StandaloneUnavailableSnapshot, { playbackCondition: 'uncertain' }>
export type StandaloneBlockedSnapshot = Extract<StandaloneUnavailableSnapshot, { playbackCondition: 'blocked' }>

/** Main-owned sequence snapshot; it contains no Controller, session, or visual input state. */
export type StandalonePlayerSnapshot = StandaloneReadySnapshot | StandaloneTransitioningSnapshot | StandaloneUnavailableSnapshot

/** Only completed UI submissions cross the orchestration boundary; digit buffering stays in the UI. */
export const STANDALONE_PLAYER_COMMAND_TYPES = Object.freeze([
  'submit-code',
  'toggle-pause',
  'next',
  'restart',
  'stop-all'
] as const)

export type StandalonePlayerCommand =
  | { readonly type: 'submit-code'; readonly enteredCode: string; readonly priority: 'normal' | 'priority' }
  | { readonly type: 'toggle-pause' }
  | { readonly type: 'next' }
  | { readonly type: 'restart' }
  | { readonly type: 'stop-all' }

/** A retry of one logical action reuses this ID and payload; a new operator action gets a new ID. */
export interface StandalonePlayerCommandRequest {
  readonly operationId: string
  readonly command: StandalonePlayerCommand
}

export type StandalonePlayerErrorCode = PlayerPlaybackErrorCode | 'OPERATION_ID_CONFLICT' | 'QUEUE_LIMIT_REACHED'

export interface StandalonePlayerError {
  readonly code: StandalonePlayerErrorCode
}

/** Technical result before the Standalone state owner commits it under the Main transition arbiter. */
export type StandaloneCommandExecutionResult =
  | ({ readonly outcome: 'confirmed'; readonly attemptId?: string } & StandaloneCommandExecutionIdentity)
  | ({ readonly outcome: 'rejected'; readonly error: StandalonePlayerError } & StandaloneCommandExecutionIdentity)
  | ({ readonly outcome: 'blocked'; readonly error: StandalonePlayerError } & StandaloneCommandExecutionIdentity)
  | ({ readonly outcome: 'uncertain'; readonly error: StandalonePlayerError } & StandaloneCommandExecutionIdentity)

export interface StandaloneCommandExecutionIdentity {
  readonly operationId: string
  /** Technical playback attempt when the effect created or targeted one; never replaces operationId. */
  readonly attemptId?: string
}

/** `confirmed` is published only after Main confirms the sequence decision and correlated playback outcome. */
export type StandalonePlayerCommandResult =
  | { readonly outcome: 'confirmed'; readonly operationId: string; readonly snapshot: StandalonePlayerSnapshot; readonly attemptId?: string }
  /** Rejected before mutation; invalid code/media and operation-ID conflicts leave the snapshot unchanged. */
  | { readonly outcome: 'rejected'; readonly operationId: string; readonly error: StandalonePlayerError; readonly snapshot: StandalonePlayerSnapshot; readonly attemptId?: string }
  /** A known partial transition, such as confirmed Stop followed by a failed next start; retain pending entries. */
  | { readonly outcome: 'blocked'; readonly operationId: string; readonly snapshot: StandaloneBlockedSnapshot; readonly attemptId?: string }
  | { readonly outcome: 'uncertain'; readonly operationId: string; readonly snapshot: StandaloneUncertainSnapshot; readonly attemptId?: string }

export type StandalonePlayerListener = (snapshot: StandalonePlayerSnapshot) => void

/** Future Main-side orchestration boundary; this substep defines it but does not implement or activate it. */
export interface StandalonePlayerControl {
  getSnapshot(): StandalonePlayerSnapshot
  execute(request: StandalonePlayerCommandRequest): Promise<StandalonePlayerCommandResult>
  subscribe(listener: StandalonePlayerListener): () => void
}

/** Narrow technical playback dependency, structurally implemented by PlayerPlaybackService. */
export interface StandalonePlaybackPort extends PlayerPlaybackRecoveryTarget {
  validateMusicCode(canonicalCode: string): Promise<void>
  playImmediately(canonicalCode: string, validateBeforeCommit?: () => void): Promise<PlayerPlaybackState>
  pause(): Promise<PlayerPlaybackState>
  resume(): Promise<PlayerPlaybackState>
  restart(): Promise<PlayerPlaybackState>
  stop(expectedAttemptId?: string): Promise<PlayerPlaybackState>
  clearCompletedMedia(expectedAttemptId: string): Promise<boolean>
  clearStoppedMedia(expectedAttemptId: string): Promise<boolean>
  subscribe(listener: PlayerPlaybackListener): () => void
}

/** Optional metadata lookup; it does not determine whether a local video can play. */
export type StandaloneCatalogPort = Pick<MusicCatalogService, 'lookupByVideoCode'>

/** Narrow recovery boundary; it reuses the existing store/coordinator without legacy sequence actions. */
export interface StandaloneRecoveryPort extends PlayerPlaybackPersistence {
  initialize(): PlayerRecoverySnapshot
  attachPlayback(playback: PlayerPlaybackRecoveryTarget): void
  getState(): PlayerRecoverySnapshot
  assertPlaybackAllowed(recoveryAttemptId?: string): void
  resolveInvalidRecovery(): { state: PlayerRecoverySnapshot; preservedFileCount: number }
  leaveStopped(expectedAttemptId: string): Promise<PlayerRecoverySnapshot>
  dispose(): void
}

/**
 * Playback-service outcomes consumed by the future orchestrator. They still
 * require matching against the current entry and EOF deduplication by attemptId.
 */
export type StandalonePlaybackEvent = Extract<
  PlayerPlaybackEvent,
  { type: 'state-changed' | 'natural-end-candidate' | 'interrupted' | 'uncertain' | 'error' | 'surface-cleanup-failed' }
>

/** Initial confirmed state; each caller receives its own pending array. */
export function createInitialStandalonePlayerSnapshot(): StandaloneReadySnapshot {
  return {
    playbackCondition: 'ready',
    state: {
      operationalState: 'idle',
      current: null,
      pending: []
    }
  }
}
