/** Incremental repair of an operational sequence, never a new arrival sort. */
export function roundRobinOrder<T extends { id: string; table: string }>(
  pending: readonly T[],
  previousTable: string | null,
  debutIds: ReadonlySet<string>,
  protectedIds: ReadonlySet<string>,
  previousWasEligible = true,
  debutTables: ReadonlySet<string> = new Set(pending.filter(entry => debutIds.has(entry.id)).map(entry => entry.table))
): T[] {
  let order = [...pending]
  for (;;) {
    const repaired = repairPass(order, previousTable, debutIds, protectedIds, previousWasEligible, debutTables)
    if (repaired.every((entry, index) => entry.id === order[index].id)) return repaired
    order = repaired
    // A move can free an earlier conflict beside a pin. Reach a fixed point
    // now, not on the next render/load. Every pass strictly improves the first
    // changed automatic slot (non-repetition, then fewer opportunities), so
    // the finite set of permutations cannot cycle. Ties never cause a move.
  }
}

function repairPass<T extends { id: string; table: string }>(
  pending: readonly T[], previousTable: string | null,
  debutIds: ReadonlySet<string>, protectedIds: ReadonlySet<string>, previousWasEligible: boolean,
  debutTables: ReadonlySet<string>
): T[] {
  const order = [...pending]
  // These are projected opportunities, not lifetime wins/debts. The saved
  // sequence carries the cycle cursor; the current/last turn seeds its boundary.
  // New/returning tables receive no credit for rounds before they were waiting.
  const opportunities = new Map<string, number>()
  if (previousTable !== null && previousWasEligible) opportunities.set(previousTable, 1)
  let previous = previousTable
  const count = (table: string) => opportunities.get(table) ?? 0

  for (let index = 0; index < order.length; index++) {
    const head = order[index]
    if (!protectedIds.has(head.id) && !debutIds.has(head.id)) {
      const candidates: number[] = []
      const seenTables = new Set<string>()
      let displacedTable: string | null = null
      for (let scan = index; scan < order.length; scan++) {
        const entry = order[scan]
        // Shifting an automatic request across its own pinned successor would
        // invert requests of that table. That protected slot is a barrier too.
        if (protectedIds.has(entry.id) && entry.table === displacedTable) break
        // Only a table's first remaining request may move. This also prevents
        // an automatic request overtaking its own later protected/debut turn.
        const canAdvanceDebut = !debutIds.has(entry.id) || head.table === previous || debutTables.has(head.table)
        if (!seenTables.has(entry.table) && !protectedIds.has(entry.id) && canAdvanceDebut) candidates.push(scan)
        seenTables.add(entry.table)
        if (!protectedIds.has(entry.id)) displacedTable = entry.table
        // Keep 2:1 opportunities in place: comparing a new table's zero count
        // to regular tables would otherwise give all debuts absolute priority.
        // Only repetition (or extra requests behind an unconsumed debut) may
        // advance the first debut. A later regular can never cross this barrier.
        if (debutIds.has(entry.id) && !protectedIds.has(entry.id)) break
      }
      const alternatives = candidates.filter(slot => order[slot].table !== previous)
      const eligible = alternatives.length ? alternatives : candidates
      const target = eligible.reduce((best, slot) =>
        count(order[slot].table) < count(order[best].table) ? slot : best, eligible[0])
      if (target !== undefined && target !== index) {
        // Stable insertion through automatic slots only. Pins/frozen entries
        // keep their exact effective indexes; every other request keeps order.
        let carry = order[target]
        for (let slot = index; slot <= target; slot++) {
          if (protectedIds.has(order[slot].id)) continue
          const displaced = order[slot]
          order[slot] = carry
          carry = displaced
        }
      }
    }
    const selected = order[index]
    opportunities.set(selected.table, count(selected.table) + 1)
    previous = selected.table
  }
  return order
}
