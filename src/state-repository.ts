/** Persistence boundary for application state (SQLite bridge or browser fallback). */

const STORE_KEY = 'kshake_store'
const LEGACY_KEYS = {
  QUEUE: 'kshake_queue', HISTORY: 'kshake_history', SESSIONS: 'kshake_sessions',
  CURRENT_SESSION_ID: 'kshake_current_session', PRIORITY_IDS: 'kshake_priority',
  FIXED_TURN_POSITIONS: 'kshake_fixed_turn_positions',
  FROZEN_TURN_IDS: 'kshake_frozen_turn_ids',
  CURRENT_TURN_ID: 'kshake_current_turn', LAST_RESET: 'kshake_last_reset'
} as const

interface StorageAdapter {
  load(): Promise<StoredAppState>
  save(state: AppState): Promise<boolean>
}

interface LegacyStorage {
  getItem(key: string): string | null
  removeItem(key: string): void
}

export interface StateRepository {
  load(): Promise<StoredAppState>
  save(state: AppState): Promise<boolean>
  recover?(): Promise<'committed' | 'unchanged'>
  finishMigration(): void
  flush(): Promise<unknown>
}

function legacyFromStorage(storage: LegacyStorage): StoredAppState | null {
  if (storage.getItem(LEGACY_KEYS.QUEUE) === null &&
      storage.getItem(LEGACY_KEYS.HISTORY) === null &&
      storage.getItem(LEGACY_KEYS.SESSIONS) === null) return null
  return {
    queue: JSON.parse(storage.getItem(LEGACY_KEYS.QUEUE) || '[]'),
    history: JSON.parse(storage.getItem(LEGACY_KEYS.HISTORY) || '[]'),
    sessions: JSON.parse(storage.getItem(LEGACY_KEYS.SESSIONS) || '[]'),
    currentSessionId: storage.getItem(LEGACY_KEYS.CURRENT_SESSION_ID) || null,
    priorityIds: JSON.parse(storage.getItem(LEGACY_KEYS.PRIORITY_IDS) || '[]'),
    fixedTurnPositions: JSON.parse(storage.getItem(LEGACY_KEYS.FIXED_TURN_POSITIONS) || '{}'),
    frozenTurnIds: JSON.parse(storage.getItem(LEGACY_KEYS.FROZEN_TURN_IDS) || '[]'),
    currentTurnId: storage.getItem(LEGACY_KEYS.CURRENT_TURN_ID) || null,
    lastReset: storage.getItem(LEGACY_KEYS.LAST_RESET) || null
  }
}

export class PersistenceError extends Error {
  constructor(readonly outcome: 'rejected' | 'failed' | 'uncertain', message =
    'Não foi possível confirmar a gravação. Seus dados foram preservados; verifique o armazenamento e tente novamente.') {
    super(message)
    this.name = 'PersistenceError'
  }
}

/** Compare persisted semantics (SQLite groups history by session on read). */
function fingerprint(state: StoredAppState): string {
  const entries = [...(state.queue || []), ...(state.history || [])]
  const groups: Record<string, string[]> = {}
  for (const entry of entries) {
    const key = JSON.stringify([entry.sessionId ?? null, entry.status === 'pending' ? 'pending' : 'history'])
    ;(groups[key] ??= []).push(entry.id)
  }
  const normalized = { ...state, queue: undefined, history: undefined,
    entries: entries.map(entry => ({ ...entry, doneAt: entry.doneAt ?? null, cancelledAt: entry.cancelledAt ?? null,
      sessionId: entry.sessionId ?? null, songNumber2: entry.songNumber2 || '' })).sort((a, b) => a.id.localeCompare(b.id)),
    groups }
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value
  return JSON.stringify(canonical(normalized))
}

export function createStateRepository(adapter: StorageAdapter, legacyStorage?: LegacyStorage): StateRepository {
  let migrationPending = false
  let writeTail: Promise<unknown> = Promise.resolve()
  let baseline: StoredAppState = {}
  let recoveryBlocked = false
  let uncertain: { before: StoredAppState; after: AppState } | null = null
  const log = (event: string) => {
    try {
      if (typeof window !== 'undefined') window.karaokeDiagnostics?.reportRendererError(event,
        JSON.stringify({ sessionId: baseline.currentSessionId ?? null }))
    } catch { /* logging failure must not mask the storage failure */ }
  }
  const reconcile = async (before: StoredAppState, after: AppState): Promise<'committed' | 'unchanged'> => {
    const actual = await adapter.load()
    if (fingerprint(actual) === fingerprint(after)) { baseline = structuredClone(after); return 'committed' }
    if (fingerprint(actual) === fingerprint(before)) return 'unchanged'
    throw new PersistenceError('uncertain')
  }

  return {
    async load() {
      let data = await adapter.load()
      baseline = structuredClone(data)
      if (data.queue === undefined && data.history === undefined && data.sessions === undefined && legacyStorage) {
        const legacy = legacyFromStorage(legacyStorage)
        if (legacy) { data = legacy; migrationPending = true }
      }
      return data
    },
    save(state) {
      const snapshot = structuredClone(state)
      const write = writeTail.catch(() => undefined).then(async () => {
        if (uncertain || recoveryBlocked) throw new PersistenceError('uncertain')
        const before = structuredClone(baseline)
        for (let attempt = 0; ; attempt++) {
          try {
            if (!await adapter.save(snapshot)) throw new Error('Gravação rejeitada')
            baseline = snapshot
            return true
          } catch (error) {
            log('PERSISTENCE_WRITE_FAILED')
            let result: 'committed' | 'unchanged'
            try { result = await reconcile(before, snapshot) } catch {
              uncertain = { before, after: snapshot }
              log('PERSISTENCE_UNCERTAIN')
              throw new PersistenceError('uncertain', 'A gravação não pôde ser verificada. Recupere a conexão antes de alterar a fila.')
            }
            if (result === 'committed') { log('PERSISTENCE_ACK_RECOVERED'); return true }
            // Retry only contention and only after proving no change committed.
            if (attempt < 2 && /SQLITE_BUSY|SQLITE_LOCKED|database (?:is )?locked/i.test(String(error))) {
              log('PERSISTENCE_RETRY')
              await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
              continue
            }
            throw new PersistenceError('failed')
          }
        }
      })
      writeTail = write
      return write
    },
    async recover() {
      await writeTail.catch(() => undefined)
      try {
        const result = uncertain ? await reconcile(uncertain.before, uncertain.after)
          : fingerprint(await adapter.load()) === fingerprint(baseline) ? 'unchanged' : null
        if (!result) throw new PersistenceError('uncertain')
        uncertain = null
        recoveryBlocked = false
        writeTail = Promise.resolve()
        log('PERSISTENCE_RECONCILED')
        return result
      } catch {
        recoveryBlocked = true
        throw new PersistenceError('uncertain')
      }
    },
    finishMigration() {
      if (!migrationPending || !legacyStorage) return
      Object.values(LEGACY_KEYS).forEach(key => legacyStorage.removeItem(key))
      migrationPending = false
    },
    flush() { return writeTail }
  }
}

export function createRendererStateRepository(): StateRepository {
  const storage = window.localStorage
  const adapter: StorageAdapter = {
    async load() {
      if (window.karaokeDatabase) return (await window.karaokeDatabase.load()) || {}
      const raw = storage.getItem(STORE_KEY)
      return raw ? JSON.parse(raw) : {}
    },
    save(state) {
      if (window.karaokeDatabase) return window.karaokeDatabase.save(state)
      storage.setItem(STORE_KEY, JSON.stringify(state))
      return Promise.resolve(true)
    }
  }
  return createStateRepository(adapter, storage)
}
