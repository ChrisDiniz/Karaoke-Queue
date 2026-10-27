import { applyFixedTurnPositions, type FixedTurnPositions } from './fixed-turn-rules'

/** Keep only unique pending IDs, retaining the stored sequence. */
export function normalizeFrozenTurnIds<T extends { id: string }>(
  ids: readonly string[],
  queue: readonly T[],
  currentTurnId: string | null
): string[] {
  const available = new Set(queue.filter(entry => entry.id !== currentTurnId).map(entry => entry.id))
  const seen = new Set<string>()
  return ids.filter(id => {
    if (!available.has(id) || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/**
 * Apply individual pins first, then force a stable frozen prefix. Pin records
 * are not modified here, so pins inside the block resume when it is released.
 */
export function applyFrozenQueueOrder<T extends { id: string }>(
  order: readonly T[],
  currentTurnId: string | null,
  frozenTurnIds: readonly string[],
  fixedPositions: Readonly<FixedTurnPositions>
): T[] {
  const pinnedOrder = applyFixedTurnPositions(order, currentTurnId, fixedPositions)
  const pending = pinnedOrder.filter(entry => entry.id !== currentTurnId)
  const current = currentTurnId ? pinnedOrder.find(entry => entry.id === currentTurnId) : undefined
  const frozenIds = normalizeFrozenTurnIds(frozenTurnIds, pending, null)
  if (!frozenIds.length) return pinnedOrder

  const byId = new Map(pending.map(entry => [entry.id, entry]))
  const frozenSet = new Set(frozenIds)
  const frozen = frozenIds.map(id => byId.get(id)!).filter(Boolean)
  const dynamic = pending.filter(entry => !frozenSet.has(entry.id))
  return current ? [current, ...frozen, ...dynamic] : [...frozen, ...dynamic]
}
