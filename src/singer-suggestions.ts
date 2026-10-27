import { normalizeSingerName } from './history-rules'

export interface SingerSuggestion {
  name: string
  normalizedName: string
  lastUsedAt: number
}

/** Autocomplete uses the existing singer normalization plus accent folding for matching only. */
export function normalizeSingerSuggestionText(value: string): string {
  return normalizeSingerName(value).normalize('NFD').replace(/\p{Diacritic}/gu, '')
}

function validTable(value: string): string | null {
  const table = value.trim()
  return /^\d+$/u.test(table) && Number(table) > 0 ? String(Number(table)) : null
}

/**
 * Derives recent names from the active queue and completed records in the
 * current session. Cancellations and all records from other sessions are
 * excluded. No IDs or persistent singer data are created.
 */
export function singerSuggestions(
  queue: readonly Readonly<QueueEntry>[],
  history: readonly Readonly<QueueEntry>[],
  sessionId: string | null,
  tableValue: string,
  query: string,
  limit = 6
): SingerSuggestion[] {
  const table = validTable(tableValue)
  const normalizedQuery = normalizeSingerSuggestionText(query)
  if (!table || !normalizedQuery || !sessionId || limit <= 0) return []

  const candidates = [
    ...queue.filter(entry => entry.status === 'pending' &&
      (entry.sessionId === sessionId || entry.sessionId == null)),
    ...history.filter(entry => entry.sessionId === sessionId &&
      (entry.status === 'done' || entry.status === 'pending'))
  ].filter(entry => String(Number(entry.table.trim())) === table)

  const latestByName = new Map<string, SingerSuggestion>()
  for (const entry of candidates) {
    const normalizedName = normalizeSingerSuggestionText(entry.name)
    if (!normalizedName || !normalizedName.startsWith(normalizedQuery)) continue
    const lastUsedAt = entry.status === 'done' && entry.doneAt != null
      ? entry.doneAt
      : entry.insertedAt
    const existing = latestByName.get(normalizedName)
    if (!existing || lastUsedAt > existing.lastUsedAt) {
      latestByName.set(normalizedName, { name: entry.name.trim().replace(/\s+/gu, ' '), normalizedName, lastUsedAt })
    }
  }

  return [...latestByName.values()]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.normalizedName.localeCompare(b.normalizedName, 'pt-BR'))
    .slice(0, Math.trunc(limit))
}
