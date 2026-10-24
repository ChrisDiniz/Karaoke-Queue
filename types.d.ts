type EntryStatus = 'pending' | 'done' | 'cancelled'

interface QueueEntry {
  id: string
  name: string
  songNumber: string
  songNumber2: string
  table: string
  insertedAt: number
  status: EntryStatus
  sessionId: string | null
  doneAt?: number
  cancelledAt?: number
}

interface SungEntry extends QueueEntry {
  status: 'done'
  doneAt: number
}

interface KaraokeSession {
  id: string
  startedAt: number
  endedAt: number | null
}

interface AppState {
  queue: QueueEntry[]
  history: QueueEntry[]
  sessions: KaraokeSession[]
  currentSessionId: string | null
  priorityIds: string[]
  nextTurnId: string | null
  currentTurnId: string | null
  lastReset: string | null
  trialStartedAt: number
  licenseActivated: boolean
}

type StoredAppState = Partial<AppState>

interface HistoryFilter {
  search: string
  table: string | null
  order: 'asc' | 'desc'
  sessionId?: string | null
}

interface KaraokeDatabaseBridge {
  load: () => Promise<StoredAppState>
  save: (state: AppState) => Promise<boolean>
}

interface Window {
  karaokeDatabase?: KaraokeDatabaseBridge
  __kqueue?: {
    queueLength: () => number
    sessionEnded: () => boolean
    flushState: () => Promise<boolean>
    endSessionSilent: () => Promise<void>
  }
}
