/** Incremental placement rules for a stable 2:1 debut cadence. */

/**
 * Inserts only the newly arrived debut token. Existing protected slots and the
 * relative order of older turns/debuts are preserved. The first pending debut
 * fills the remaining cycle slots; later debuts follow the most recent pending
 * debut after two regular opportunities, preserving the operational cadence.
 */
export function insertNewDebutByCadence<T extends { id: string; table?: string }>(
  order: readonly T[],
  newDebutId: string,
  debutIds: ReadonlySet<string>,
  regularsSinceDebut: number,
  protectedIds: readonly string[] = []
): T[] {
  const result = [...order]
  const originalIndex = result.findIndex(entry => entry.id === newDebutId)
  if (originalIndex < 0) return result
  const protectedSet = new Set(protectedIds)
  const dynamic = result.filter(entry => !protectedSet.has(entry.id))
  const index = dynamic.findIndex(entry => entry.id === newDebutId)
  if (index < 0) return result

  const without = dynamic.filter(entry => entry.id !== newDebutId)
  const debutTables = new Set(order.filter(entry => debutIds.has(entry.id))
    .map(entry => entry.table).filter((table): table is string => typeof table === 'string'))
  const isRegularOpportunity = (entry: T) => !debutIds.has(entry.id) &&
    !(entry.table && debutTables.has(entry.table))
  const olderDebutBarrier = without.reduce((last, entry, position) =>
    debutIds.has(entry.id) ? position + 1 : last, 0)
  const lastOlderDebut = without.reduce((last, entry, position) =>
    debutIds.has(entry.id) ? position : last, -1)
  const regularOpportunitiesDue = lastOlderDebut >= 0
    ? 2
    : Math.max(0, 2 - Math.min(2, Math.max(0, regularsSinceDebut)))
  let cadencePosition = 0
  let seenRegulars = 0
  const cadenceStart = lastOlderDebut >= 0 ? lastOlderDebut + 1 : 0
  cadencePosition = cadenceStart
  for (let position = cadenceStart; position < without.length && seenRegulars < regularOpportunitiesDue; position++) {
    if (isRegularOpportunity(without[position])) seenRegulars++
    cadencePosition = position + 1
  }
  const target = Math.min(without.length, Math.max(olderDebutBarrier, cadencePosition))
  without.splice(target, 0, result.find(entry => entry.id === newDebutId)!)

  let cursor = 0
  return result.map(entry => protectedSet.has(entry.id) ? entry : without[cursor++])
}

/** A canceled regular turn consumes no cadence slot; refill the missing slot. */
export function restoreRegularOpportunitiesAfterCancellation<T extends { id: string; table?: string }>(
  order: readonly T[],
  debutIds: ReadonlySet<string>,
  regularsSinceDebut: number,
  protectedIds: readonly string[] = []
): T[] {
  const protectedSet = new Set(protectedIds)
  const dynamic = order.filter(entry => !protectedSet.has(entry.id))
  const debutTables = new Set(order.filter(entry => debutIds.has(entry.id))
    .map(entry => entry.table).filter((table): table is string => typeof table === 'string'))
  const isRegularOpportunity = (entry: T) => !debutIds.has(entry.id) &&
    !(entry.table && debutTables.has(entry.table))
  const needed = Math.max(0, 2 - Math.min(2, Math.max(0, regularsSinceDebut)))
  const firstDebut = dynamic.findIndex(entry => debutIds.has(entry.id))
  if (firstDebut < 0 || needed === 0) return [...order]

  const before = dynamic.slice(0, firstDebut)
  let regularsBefore = before.filter(isRegularOpportunity).length
  while (regularsBefore < needed) {
    const debutIndex = dynamic.findIndex(entry => debutIds.has(entry.id))
    const regularIndex = dynamic.findIndex((entry, index) => index > debutIndex && isRegularOpportunity(entry))
    if (regularIndex < 0) break
    const [regular] = dynamic.splice(regularIndex, 1)
    dynamic.splice(debutIndex, 0, regular)
    regularsBefore++
  }

  let cursor = 0
  return order.map(entry => protectedSet.has(entry.id) ? entry : dynamic[cursor++])
}
