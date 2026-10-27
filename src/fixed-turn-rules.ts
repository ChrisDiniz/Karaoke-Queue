/** Pure helpers for individual turn pins and stable manual queue movements. */

export type FixedTurnPositions = Record<string, number>

/**
 * Merge fixed positions into an automatic order. Positions are 1-based and
 * relative to the queue after the current presentation. Invalid/colliding
 * legacy values are resolved deterministically without dropping a fixed ID.
 */
export function applyFixedTurnPositions<T extends { id: string }>(
  order: readonly T[],
  currentTurnId: string | null,
  fixedPositions: Readonly<FixedTurnPositions>
): T[] {
  const currentIndex = currentTurnId ? order.findIndex(entry => entry.id === currentTurnId) : -1
  const current = currentIndex >= 0 ? order[currentIndex] : null
  const pending = order.filter(entry => entry.id !== currentTurnId)
  if (!pending.length || !Object.keys(fixedPositions).length) return [...order]

  const byId = new Map(pending.map(entry => [entry.id, entry]))
  const fixedEntries = Object.entries(fixedPositions)
    .filter(([id, position]) => byId.has(id) && Number.isFinite(position))
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
  const slots: Array<T | null> = Array(pending.length).fill(null)
  const fixedIds = new Set<string>()

  for (const [id, requestedPosition] of fixedEntries) {
    const desired = Math.max(0, Math.min(pending.length - 1, Math.trunc(requestedPosition) - 1))
    let slot = slots.findIndex((entry, index) => index >= desired && entry === null)
    if (slot < 0) slot = slots.findIndex(entry => entry === null)
    if (slot < 0) continue
    slots[slot] = byId.get(id)!
    fixedIds.add(id)
  }

  const automatic = pending.filter(entry => !fixedIds.has(entry.id))
  let automaticIndex = 0
  const orderedPending = slots.map(entry => entry ?? automatic[automaticIndex++])
  if (!current) return orderedPending

  const result: T[] = []
  let pendingIndex = 0
  order.forEach(entry => result.push(entry.id === current.id ? current : orderedPending[pendingIndex++]))
  return result
}

/** Move one turn and shift only fixed positions crossed by that movement. */
export function moveTurnAndFix<T extends { id: string }>(
  orderAfterCurrent: readonly T[],
  fixedPositions: Readonly<FixedTurnPositions>,
  id: string,
  targetPosition: number
): { order: T[]; fixedPositions: FixedTurnPositions } | null {
  const fromIndex = orderAfterCurrent.findIndex(entry => entry.id === id)
  if (fromIndex < 0 || !Number.isInteger(targetPosition) || targetPosition < 1 || targetPosition > orderAfterCurrent.length) return null
  const toIndex = targetPosition - 1
  if (fromIndex === toIndex) return null

  const order = [...orderAfterCurrent]
  const [moved] = order.splice(fromIndex, 1)
  order.splice(toIndex, 0, moved)

  const nextPositions: FixedTurnPositions = {}
  Object.entries(fixedPositions).forEach(([fixedId, position]) => {
    if (fixedId === id) return
    let nextPosition = position
    if (fromIndex < toIndex && position > fromIndex + 1 && position <= toIndex + 1) nextPosition--
    if (fromIndex > toIndex && position >= toIndex + 1 && position < fromIndex + 1) nextPosition++
    nextPositions[fixedId] = nextPosition
  })
  nextPositions[id] = targetPosition

  return { order, fixedPositions: nextPositions }
}

/** Remove a queue entry and close its vacated slot in all later pins. */
export function removeTurnFromFixedPositions(
  fixedPositions: Readonly<FixedTurnPositions>,
  id: string,
  removedPosition: number | null
): FixedTurnPositions {
  const next: FixedTurnPositions = {}
  Object.entries(fixedPositions).forEach(([fixedId, position]) => {
    if (fixedId === id) return
    next[fixedId] = removedPosition !== null && position > removedPosition ? position - 1 : position
  })
  return next
}

/** When an automatic/fixed turn becomes current, its queue slot is consumed. */
export function consumeFirstQueuePosition(
  fixedPositions: Readonly<FixedTurnPositions>,
  currentId: string
): FixedTurnPositions {
  const next: FixedTurnPositions = {}
  Object.entries(fixedPositions).forEach(([fixedId, position]) => {
    if (fixedId === currentId) next[fixedId] = 0
    else next[fixedId] = position > 1 ? position - 1 : position
  })
  return next
}
