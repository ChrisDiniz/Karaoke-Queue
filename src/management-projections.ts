import { applyFrozenQueueOrder } from './frozen-queue-rules'
import { moveTurnAndFix } from './fixed-turn-rules'
import type { ReadonlyAppState } from './application'

/** Pure synchronous queue projections over the last confirmed serializable state. */
export function getManagementPlayOrder(state: ReadonlyAppState): readonly Readonly<QueueEntry>[] {
  return applyFrozenQueueOrder([...state.queue], state.currentTurnId, [...state.frozenTurnIds],
    { ...state.fixedTurnPositions })
}

export function canMoveManagementTurn(state: ReadonlyAppState, id: string, targetPosition: number): boolean {
  if (!state.queue.some(entry => entry.id === id) || id === state.currentTurnId) return false
  if (state.frozenTurnIds.includes(id) || targetPosition <= state.frozenTurnIds.length) return false
  const order = getManagementPlayOrder(state).filter(entry => entry.id !== state.currentTurnId)
  return moveTurnAndFix(order, { ...state.fixedTurnPositions }, id, targetPosition) !== null
}
