/** Pure history and table-summary calculations shared by the UI. */

export interface TableHistorySummary {
  totalSongs: number
  uniqueSingers: string[]
  avgWaitMin: number
  firstTime: number
  lastTime: number
  durationMinutes: number
  currentRound: number
  singers: Array<[string, Readonly<QueueEntry>[]]>
  topSongs: Array<[string, number]>
}

export interface TableSingerActivity {
  name: string
  sung: Readonly<QueueEntry>[]
  pending: Readonly<QueueEntry>[]
}

export interface TableActivitySummary {
  sungEntries: Readonly<QueueEntry>[]
  pendingEntries: Readonly<QueueEntry>[]
  singers: TableSingerActivity[]
  sungSongs: number
  pendingSongs: number
  singerCount: number
}

export interface SessionSummary {
  sungSongs: number
  singers: number
  tables: number
  durationMinutes: number
}

/** Date filter uses the establishment's local calendar and the actual session interval. */
export function sessionWasActiveOnLocalDate(
  session: Readonly<KaraokeSession>,
  entries: readonly Readonly<QueueEntry>[],
  dateValue: string
): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue)
  if (!match) return false
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const dayStart = new Date(year, month - 1, day).getTime()
  const validDate = new Date(dayStart)
  if (validDate.getFullYear() !== year || validDate.getMonth() !== month - 1 || validDate.getDate() !== day) return false
  const dayEnd = new Date(year, month - 1, day + 1).getTime()

  if (session.endedAt != null) {
    // Half-open intervals avoid counting an end exactly at midnight as activity
    // on the following day. A session starting at midnight belongs to that day.
    return session.startedAt < dayEnd && session.endedAt > dayStart
  }

  // Legacy sessions without an end time only match dates supported by recorded
  // timestamps; never infer a duration or an artificial end boundary.
  const timestamps = [session.startedAt, ...entries.filter(entry => entry.sessionId === session.id)
    .flatMap(entry => [entry.insertedAt, entry.doneAt, entry.cancelledAt].filter((value): value is number => value != null))]
  return timestamps.some(timestamp => timestamp >= dayStart && timestamp < dayEnd)
}

export interface SessionTableSummary {
  table: string
  sungSongs: number
  pendingSongs: number
}

export interface SingerEntryGroup {
  identityKey: string
  name: string
  table: string
  entries: Readonly<QueueEntry>[]
}

export interface SessionSingerSummary extends SingerEntryGroup {
  sungSongs: number
}

export function songCount(entries: readonly Readonly<QueueEntry>[]): number {
  return entries.reduce((count, entry) => count + (entry.songNumber ? 1 : 0) + (entry.songNumber2 ? 1 : 0), 0)
}

/** Counts completed presentation turns per table in one session, not songs. */
export function completedTurnCountsByTable(
  history: readonly Readonly<QueueEntry>[],
  sessionId: string | null
): Map<string, number> {
  const counts = new Map<string, number>()
  history.forEach(entry => {
    if (entry.status === 'done' && entry.doneAt != null && entry.sessionId === sessionId) {
      counts.set(entry.table, (counts.get(entry.table) || 0) + 1)
    }
  })
  return counts
}

/** Normalizes display names for matching, without changing the stored/displayed value. */
export function normalizeSingerName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('pt-BR')
}

/** Singer identity is scoped to one table; no persistent singer ID is introduced. */
export function singerIdentityKey(name: string, table: string): string {
  return JSON.stringify([normalizeSingerName(name), table.trim()])
}

export function groupSingerEntries(entries: readonly Readonly<QueueEntry>[]): SingerEntryGroup[] {
  const grouped = new Map<string, SingerEntryGroup>()
  for (const entry of entries) {
    const identityKey = singerIdentityKey(entry.name, entry.table)
    let group = grouped.get(identityKey)
    if (!group) {
      group = { identityKey, name: entry.name, table: entry.table, entries: [] }
      grouped.set(identityKey, group)
    }
    group.entries.push(entry)
  }
  return [...grouped.values()]
}

/** Completed singer totals are scoped to the requested session and singer identity. */
export function sessionSingerSummaries(
  history: readonly Readonly<QueueEntry>[],
  sessionId: string | null
): SessionSingerSummary[] {
  const sung = history.filter(entry => entry.status === 'done' && entry.doneAt != null && entry.sessionId === sessionId)
  return groupSingerEntries(sung).map(group => {
    return {
      ...group,
      sungSongs: songCount(group.entries)
    }
  })
}

export function sessionHistory(history: readonly Readonly<QueueEntry>[], sessionId: string | null): Readonly<QueueEntry>[] {
  return history.filter(entry => entry.sessionId === sessionId)
}

/** Session dashboard metrics count only completed performances, never cancellations or queue entries. */
export function sessionSummary(
  history: readonly Readonly<QueueEntry>[],
  session: Readonly<KaraokeSession> | null,
  now = Date.now()
): SessionSummary {
  const sung = session
    ? history.filter(entry => entry.status === 'done' && entry.doneAt != null && entry.sessionId === session.id)
    : []
  const end = session?.endedAt ?? now
  return {
    sungSongs: songCount(sung),
    singers: session ? sessionSingerSummaries(history, session.id).length : 0,
    tables: new Set(sung.map(entry => entry.table)).size,
    durationMinutes: session ? Math.max(0, Math.floor((end - session.startedAt) / 60000)) : 0
  }
}

/** Combines completed history and live queue entries for one table and session. */
export function tableActivitySummary(
  history: readonly Readonly<QueueEntry>[],
  queue: readonly Readonly<QueueEntry>[],
  sessionId: string | null,
  table: string
): TableActivitySummary {
  const sungEntries = history.filter(entry => entry.status === 'done' && entry.doneAt != null &&
    entry.sessionId === sessionId && entry.table === table)
  const sungIds = new Set(sungEntries.map(entry => entry.id))
  const pendingById = new Map<string, Readonly<QueueEntry>>()
  for (const entry of [...history, ...queue]) {
    if (entry.status === 'pending' && entry.sessionId === sessionId && entry.table === table && !sungIds.has(entry.id)) {
      pendingById.set(entry.id, entry)
    }
  }
  const pendingEntries = [...pendingById.values()]

  const singers = groupSingerEntries([...sungEntries, ...pendingEntries]).map(group => ({
    name: group.name,
    sung: group.entries.filter(entry => entry.status === 'done'),
    pending: group.entries.filter(entry => entry.status === 'pending')
  })).sort((a, b) =>
    (b.sung.length + b.pending.length) - (a.sung.length + a.pending.length))

  return {
    sungEntries, pendingEntries, singers,
    sungSongs: songCount(sungEntries), pendingSongs: songCount(pendingEntries),
    singerCount: singers.length
  }
}

/** Lists every table mentioned by this session's history or live queue, including zero-sung tables. */
export function sessionTableSummaries(
  history: readonly Readonly<QueueEntry>[],
  queue: readonly Readonly<QueueEntry>[],
  sessionId: string | null
): SessionTableSummary[] {
  const tables = new Set<string>()
  history.filter(entry => entry.sessionId === sessionId).forEach(entry => tables.add(entry.table))
  queue.filter(entry => entry.sessionId === sessionId && entry.status === 'pending')
    .forEach(entry => tables.add(entry.table))
  return [...tables]
    .sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b, 'pt-BR'))
    .map(table => {
      const summary = tableActivitySummary(history, queue, sessionId, table)
      return { table, sungSongs: summary.sungSongs, pendingSongs: summary.pendingSongs }
    })
}

export function tableHistorySummary(entries: readonly Readonly<QueueEntry>[]): TableHistorySummary {
  const totalSongs = songCount(entries)
  const singerGroups = groupSingerEntries(entries)
  const uniqueSingers = singerGroups.map(group => group.name)
  const waits = entries.map(entry => (entry.doneAt ?? 0) - entry.insertedAt).filter(Boolean)
  const avgWaitMin = waits.length
    ? Math.round(waits.reduce((sum, wait) => sum + wait, 0) / waits.length / 60000)
    : 0
  const timestamps = entries.flatMap(entry => [entry.insertedAt, entry.doneAt ?? 0]).filter(Boolean)
  const firstTime = timestamps.length ? Math.min(...timestamps) : 0
  const lastTime = timestamps.length ? Math.max(...timestamps) : 0

  const singers = singerGroups
    .map(group => [group.name, group.entries] as [string, Readonly<QueueEntry>[]])
    .sort((a, b) => b[1].length - a[1].length)

  const songCounts: Record<string, number> = {}
  entries.forEach(entry => {
    [entry.songNumber, entry.songNumber2].filter(Boolean).forEach(song => {
      songCounts[song] = (songCounts[song] || 0) + 1
    })
  })
  const topSongs = Object.entries(songCounts).sort((a, b) => b[1] - a[1])

  return {
    totalSongs, uniqueSingers, avgWaitMin, firstTime, lastTime,
    durationMinutes: timestamps.length ? Math.round((lastTime - firstTime) / 60000) : 0,
    currentRound: entries.length + 1, singers, topSongs
  }
}
