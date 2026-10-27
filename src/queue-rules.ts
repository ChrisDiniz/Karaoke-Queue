/** Pure queue ordering and recommendation rules. */

export function sungEntries(history: readonly Readonly<QueueEntry>[], sessionId: string | null): SungEntry[] {
  return history.filter((entry): entry is SungEntry =>
    entry.sessionId === sessionId && entry.status === 'done' && entry.doneAt != null
  )
}

export function lastSungTable(history: QueueEntry[], sessionId: string | null): string | null {
  const sung = sungEntries(history, sessionId)
  if (sung.length === 0) return null
  return sung.reduce((a, b) => (b.doneAt > a.doneAt ? b : a)).table
}

export function maxWaitMinutes(queue: readonly Readonly<QueueEntry>[]): number {
  const distinct = new Set(queue.map(entry => entry.table)).size
  return Math.max(30, Math.round(1.5 * distinct * 6))
}

/** Arrival-order fairness with recent completed turns and table alternation. */
export function fairOrder(
  entries: QueueEntry[],
  history: readonly Readonly<QueueEntry>[],
  sessionId: string | null,
  seedLastTable: string | null,
  now = Date.now(),
  roundEntries: readonly Readonly<QueueEntry>[] = entries
): QueueEntry[] {
  const windowStart = now - 90 * 60000
  const sungByTable: Record<string, number> = {}
  sungEntries(history, sessionId).forEach(entry => {
    if (entry.doneAt >= windowStart) {
      sungByTable[entry.table] = (sungByTable[entry.table] || 0) + 1
    }
  })
  const queueRound = (entry: QueueEntry): number => roundEntries.filter(other =>
    other.table === entry.table && other.insertedAt < entry.insertedAt
  ).length
  const tableTurns = (entry: QueueEntry): number =>
    (sungByTable[entry.table] || 0) + queueRound(entry)
  const remaining = [...entries].sort((a, b) => {
    const turnsA = tableTurns(a), turnsB = tableTurns(b)
    if (turnsA !== turnsB) return turnsA - turnsB
    return a.insertedAt - b.insertedAt
  })
  const result: QueueEntry[] = []
  let lastTable = seedLastTable
  while (remaining.length > 0) {
    let idx = remaining.findIndex(entry => entry.table !== lastTable)
    if (idx === -1) idx = 0
    const [picked] = remaining.splice(idx, 1)
    result.push(picked)
    lastTable = picked.table
  }
  return result
}

/** One UI/business token per never-sung table: its oldest pending turn. */
export function debutTurnIds(
  queue: readonly Readonly<QueueEntry>[],
  history: readonly Readonly<QueueEntry>[],
  sessionId: string | null
): Set<string> {
  const completedTables = new Set(sungEntries(history, sessionId).map(entry => entry.table))
  const firstPendingByTable = new Map<string, Readonly<QueueEntry>>()
  const pending = queue.filter(entry => entry.status === 'pending' && entry.sessionId === sessionId)
    .slice().sort((a, b) => a.insertedAt - b.insertedAt || a.id.localeCompare(b.id))
  for (const entry of pending) {
    if (!firstPendingByTable.has(entry.table)) firstPendingByTable.set(entry.table, entry)
  }
  return new Set([...firstPendingByTable.entries()]
    .filter(([table]) => !completedTables.has(table))
    .map(([, entry]) => entry.id))
}

/**
 * Fair automatic order with a 2:1 regular-to-debut cadence. A debut is the
 * oldest pending turn of a table with no completed turn in this session.
 * Reserved turns are excluded from the cadence, while still counting toward
 * queueRound so the automatic rules see the complete waiting context.
 */
export function debutBalancedOrder(
  entries: readonly QueueEntry[],
  history: readonly Readonly<QueueEntry>[],
  sessionId: string | null,
  seedLastTable: string | null,
  now = Date.now(),
  reservedIds: readonly string[] = [],
  allPendingEntries: readonly Readonly<QueueEntry>[] = entries,
  roundEntries: readonly Readonly<QueueEntry>[] = allPendingEntries
): QueueEntry[] {
  if (!entries.length) return []

  const reserved = new Set(reservedIds)
  const allDebutIds = debutTurnIds(allPendingEntries, history, sessionId)
  const debutEntries = entries.filter(entry => allDebutIds.has(entry.id) && !reserved.has(entry.id))
  const selectedDebutIds = new Set(debutEntries.map(entry => entry.id))
  const regularEntries = entries.filter(entry => !selectedDebutIds.has(entry.id))
  const regular = fairOrder([...regularEntries], history, sessionId, seedLastTable, now, roundEntries)
  const debut = fairOrder([...debutEntries], history, sessionId, seedLastTable, now, roundEntries)
  if (!debut.length) return regular
  if (!regular.length) return debut

  // A later request from a debuting table cannot pass its first request unless
  // that first request is already protected (current, frozen or manually fixed).
  const debutTableById = new Map(debut.map(entry => [entry.id, entry.table]))
  const pendingDebutTables = new Set(debut.map(entry => entry.table))
  const remainingRegular = [...regular]
  const remainingDebut = [...debut]
  const result: QueueEntry[] = []
  let lastTable = seedLastTable

  const takeRegular = (): QueueEntry | undefined => {
    const eligible = (entry: QueueEntry) => !pendingDebutTables.has(entry.table)
    let index = remainingRegular.findIndex(entry => eligible(entry) && entry.table !== lastTable)
    if (index < 0) index = remainingRegular.findIndex(eligible)
    if (index < 0) return undefined
    return remainingRegular.splice(index, 1)[0]
  }
  const takeDebut = (): QueueEntry | undefined => {
    let index = remainingDebut.findIndex(entry => entry.table !== lastTable)
    if (index < 0) index = remainingDebut.length ? 0 : -1
    const entry = index >= 0 ? remainingDebut.splice(index, 1)[0] : undefined
    if (entry) pendingDebutTables.delete(debutTableById.get(entry.id)!)
    return entry
  }
  const append = (entry: QueueEntry | undefined): void => {
    if (!entry) return
    result.push(entry)
    lastTable = entry.table
  }

  while (remainingRegular.length || remainingDebut.length) {
    // Fill two regular opportunities, then one debut. If a group has no
    // currently eligible turn, use the other group instead of leaving a hole.
    for (let slot = 0; slot < 2; slot++) {
      append(takeRegular() || takeDebut())
    }
    append(takeDebut() || takeRegular())
  }
  return result
}

export type QueuePositionReasonKind = 'current' | 'frozen' | 'manual' | 'debut' | 'regular'

export interface QueuePositionReason {
  kind: QueuePositionReasonKind
  position: number | null
}

/** Explains only policy layers and criteria the current order can prove. */
export function queuePositionReason(
  id: string,
  order: readonly Readonly<QueueEntry>[],
  queue: readonly Readonly<QueueEntry>[],
  history: readonly Readonly<QueueEntry>[],
  sessionId: string | null,
  currentTurnId: string | null,
  frozenTurnIds: readonly string[],
  fixedTurnPositions: Readonly<Record<string, number>>,
  priorityIds: readonly string[] = [],
  nextTurnId: string | null = null
): QueuePositionReason | null {
  const index = order.findIndex(entry => entry.id === id)
  if (index < 0) return null
  if (id === currentTurnId) return { kind: 'current', position: null }
  const position = order.slice(0, index).filter(entry => entry.id !== currentTurnId).length + 1
  if (frozenTurnIds.includes(id)) return { kind: 'frozen', position }
  if (fixedTurnPositions[id] !== undefined || priorityIds.includes(id) || nextTurnId === id) {
    return { kind: 'manual', position }
  }
  if (debutTurnIds(queue, history, sessionId).has(id)) return { kind: 'debut', position }
  return { kind: 'regular', position }
}

/** Full recommendation order: displaced current, manual pins, then fair order. */
export function playOrder(
  queue: QueueEntry[], history: QueueEntry[], sessionId: string | null,
  priorityIds: string[], nextTurnId: string | null, now = Date.now(),
  reservedIds: readonly string[] = []
): QueueEntry[] {
  const pinnedSet = new Set(priorityIds)
  const forcedNext = queue.find(entry => entry.id === nextTurnId) || null
  const pinned = priorityIds
    .filter(id => id !== forcedNext?.id)
    .map(id => queue.find(entry => entry.id === id))
    .filter((entry): entry is QueueEntry => entry !== undefined)
  const excludedIds = new Set<string>([...pinnedSet, ...(forcedNext ? [forcedNext.id] : [])])
  const fairEntries = queue.filter(entry => !excludedIds.has(entry.id))
  const reserved = new Set(reservedIds)
  const automatic = debutBalancedOrder(
    fairEntries.filter(entry => !reserved.has(entry.id)), history, sessionId,
    lastSungTable(history, sessionId), now, reservedIds, queue, fairEntries
  )
  const protectedEntries = fairEntries.filter(entry => reserved.has(entry.id))
  return [forcedNext, ...pinned, ...automatic, ...protectedEntries].filter((entry): entry is QueueEntry =>
    entry !== null && entry !== undefined
  )
}

export type QueueTurnPosition =
  | { kind: 'current' }
  | { kind: 'waiting'; position: number }

/** Long-wait alerts remain reserved for positions after the first three turns. */
export const LONG_WAIT_ALERT_AFTER_POSITION = 3

/** Wait-alert eligibility excludes the current turn, the first three waiting turns and frozen turns. */
export function longWaitAlertEligibleIds(
  order: readonly Readonly<QueueEntry>[],
  currentTurnId: string | null,
  frozenTurnIds: readonly string[],
  canAdvance: (id: string) => boolean = () => true
): string[] {
  const frozen = new Set(frozenTurnIds)
  return order
    .filter(entry => entry.id !== currentTurnId)
    .filter((entry, index) => index >= LONG_WAIT_ALERT_AFTER_POSITION && !frozen.has(entry.id) && canAdvance(entry.id))
    .map(entry => entry.id)
}

/** Assigns continuous queue positions without changing queue state. */
export function queueTurnPositions(
  order: readonly Readonly<QueueEntry>[],
  currentTurnId: string | null
): Map<string, QueueTurnPosition> {
  const positions = new Map<string, QueueTurnPosition>()
  if (currentTurnId && order.some(entry => entry.id === currentTurnId)) {
    positions.set(currentTurnId, { kind: 'current' })
  }
  const afterCurrent = order.filter(entry => entry.id !== currentTurnId)
  afterCurrent.forEach((entry, index) => {
    const position = index + 1
    positions.set(entry.id, { kind: 'waiting', position })
  })
  return positions
}

/** Preserve a valid current turn; otherwise choose the first recommendation. */
export function resolveCurrentTurn(
  queue: QueueEntry[], order: QueueEntry[], currentTurnId: string | null,
  nextTurnId: string | null
): { current: QueueEntry | null; currentTurnId: string | null; nextTurnId: string | null } {
  let current = currentTurnId ? queue.find(entry => entry.id === currentTurnId) || null : null
  if (!current) {
    current = order[0] || null
    if (current && current.id === nextTurnId) nextTurnId = null
    currentTurnId = current ? current.id : null
  }
  return { current, currentTurnId, nextTurnId }
}
