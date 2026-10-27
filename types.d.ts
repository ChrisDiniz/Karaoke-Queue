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
  fixedTurnPositions: Record<string, number>
  frozenTurnIds: string[]
  queueOrderPolicyVersion: number
  regularsSinceDebut: number
  currentTurnAutomatic: boolean
  nextTurnId: string | null
  currentTurnId: string | null
  lastReset: string | null
  /** Deprecated SQLite compatibility fields; never trusted for licensing. */
  trialStartedAt?: number
  licenseActivated?: boolean
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

type UiScalePreference = import('./src/ui/ui-scale').UiScalePreference
type UiScaleState = import('./src/ui/ui-scale').UiScaleState

interface KaraokeUiScaleBridge {
  getState: () => Promise<UiScaleState>
  setPreference: (preference: UiScalePreference) => Promise<UiScaleState>
  onChanged: (callback: (state: UiScaleState) => void) => () => void
}

interface KaraokePreferencesBridge {
  getSidebarDisplayName: () => Promise<string>
  setSidebarDisplayName: (name: string) => Promise<string>
}

interface KaraokeDiagnosticsBridge {
  openLogsFolder: () => Promise<{ ok: boolean; error?: string }>
  logSessionEvent: (event: string, sessionId: string | null, result?: string) => void
  reportRendererError: (event: string, message: string, stack?: string) => void
}

type LicenseStatus = import('./src/licensing').LicenseStatus

interface KaraokeLicenseBridge {
  getStatus: () => Promise<LicenseStatus>
  activate: (token: string) => Promise<LicenseStatus>
}

interface Window {
  karaokeDatabase?: KaraokeDatabaseBridge
  karaokeUiScale?: KaraokeUiScaleBridge
  karaokePreferences?: KaraokePreferencesBridge
  karaokeDiagnostics?: KaraokeDiagnosticsBridge
  karaokeLicense?: KaraokeLicenseBridge
  __kqueue?: {
    prepareToClose: () => Promise<void>
    cancelClose: () => void
    queueLength: () => number
    sessionEnded: () => boolean
    closeSummary: () => { sessionActive: boolean; uncompletedCount: number; sessionId: string | null }
    flushState: () => Promise<boolean>
    endSessionAndArchive: () => Promise<boolean>
  }
}
