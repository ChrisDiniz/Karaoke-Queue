export type PlayerPairingState = 'idle-unbound' | 'awaiting-local-consent' | 'code-ready' |
  'preparing-attempt' | 'awaiting-KE3' | 'awaiting-controller-bind' | 'pending' | 'committed' | 'active' |
  'rejected' | 'cancelled' | 'timed-out' | 'error' | 'blocked' | 'revoked'

export type ControllerPairingState = 'selected' | 'requested' | 'waiting-consent' | 'awaiting-code' |
  'preparing-KE1' | 'verifying-KE2' | 'awaiting-player-bind' | 'saving-prepared' | 'awaiting-commit' |
  'saving-committed' | 'awaiting-active' | 'active-awaiting-reconciliation' | 'rejected' | 'cancelled' |
  'timed-out' | 'error' | 'blocked' | 'revoked'

const PLAYER_TRANSITIONS: Readonly<Record<PlayerPairingState, readonly PlayerPairingState[]>> = {
  'idle-unbound': ['awaiting-local-consent', 'blocked'],
  'awaiting-local-consent': ['code-ready', 'rejected', 'cancelled', 'timed-out', 'error', 'blocked'],
  'code-ready': ['preparing-attempt', 'cancelled', 'timed-out', 'error', 'blocked'],
  'preparing-attempt': ['awaiting-KE3', 'code-ready', 'cancelled', 'timed-out', 'error', 'blocked'],
  'awaiting-KE3': ['awaiting-controller-bind', 'preparing-attempt', 'code-ready', 'cancelled', 'timed-out', 'error', 'blocked'],
  'awaiting-controller-bind': ['pending', 'cancelled', 'timed-out', 'error', 'blocked'],
  pending: ['committed', 'error', 'blocked', 'revoked'],
  committed: ['active', 'error', 'blocked', 'revoked'],
  active: ['revoked', 'blocked'],
  rejected: [], cancelled: [], 'timed-out': [], error: ['blocked', 'revoked'], blocked: ['revoked'], revoked: []
}

const CONTROLLER_TRANSITIONS: Readonly<Record<ControllerPairingState, readonly ControllerPairingState[]>> = {
  selected: ['requested', 'cancelled', 'error'],
  requested: ['waiting-consent', 'rejected', 'cancelled', 'timed-out', 'error', 'blocked'],
  'waiting-consent': ['awaiting-code', 'rejected', 'cancelled', 'timed-out', 'error', 'blocked'],
  'awaiting-code': ['preparing-KE1', 'cancelled', 'timed-out', 'error', 'blocked'],
  'preparing-KE1': ['verifying-KE2', 'error', 'blocked'],
  'verifying-KE2': ['awaiting-player-bind', 'awaiting-code', 'error', 'blocked'],
  'awaiting-player-bind': ['saving-prepared', 'error', 'blocked'],
  'saving-prepared': ['awaiting-commit', 'error', 'blocked'],
  'awaiting-commit': ['saving-committed', 'error', 'blocked'],
  'saving-committed': ['awaiting-active', 'error', 'blocked'],
  'awaiting-active': ['active-awaiting-reconciliation', 'error', 'blocked'],
  'active-awaiting-reconciliation': ['revoked', 'blocked'],
  rejected: [], cancelled: [], 'timed-out': [], error: ['blocked', 'revoked'], blocked: ['revoked'], revoked: []
}

export function transitionPlayerPairing(from: PlayerPairingState, to: PlayerPairingState): PlayerPairingState {
  if (!PLAYER_TRANSITIONS[from].includes(to)) throw new Error('PAIRING_STATE_TRANSITION_INVALID')
  return to
}

export function transitionControllerPairing(from: ControllerPairingState, to: ControllerPairingState): ControllerPairingState {
  if (!CONTROLLER_TRANSITIONS[from].includes(to)) throw new Error('PAIRING_STATE_TRANSITION_INVALID')
  return to
}

export function canCancelPairing(state: PlayerPairingState | ControllerPairingState): boolean {
  return ['awaiting-local-consent', 'code-ready', 'preparing-attempt', 'awaiting-KE3', 'requested', 'waiting-consent', 'awaiting-code',
    'preparing-KE1', 'verifying-KE2', 'awaiting-player-bind'].includes(state)
}
