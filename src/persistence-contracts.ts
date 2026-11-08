/** Legacy Renderer localStorage keys accepted only by the one-time Main import handshake. */
export const LEGACY_STATE_STORAGE_KEYS = {
  QUEUE: 'kshake_queue', HISTORY: 'kshake_history', SESSIONS: 'kshake_sessions',
  CURRENT_SESSION_ID: 'kshake_current_session', PRIORITY_IDS: 'kshake_priority',
  FIXED_TURN_POSITIONS: 'kshake_fixed_turn_positions',
  FROZEN_TURN_IDS: 'kshake_frozen_turn_ids',
  CURRENT_TURN_ID: 'kshake_current_turn', LAST_RESET: 'kshake_last_reset'
} as const

export type LegacyStateStorageDto = Readonly<Record<
  typeof LEGACY_STATE_STORAGE_KEYS[keyof typeof LEGACY_STATE_STORAGE_KEYS], string | null
>>

export class PersistenceError extends Error {
  constructor(readonly outcome: 'rejected' | 'failed' | 'uncertain', message =
    'Não foi possível confirmar a gravação. Seus dados foram preservados; verifique o armazenamento e tente novamente.') {
    super(message)
    this.name = 'PersistenceError'
  }
}
