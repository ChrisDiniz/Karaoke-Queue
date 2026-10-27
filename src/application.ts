import { debutTurnIds, sungEntries, playOrder, resolveCurrentTurn } from './queue-rules'
import { roundRobinOrder } from './round-robin-rules'
import { insertNewDebutByCadence, restoreRegularOpportunitiesAfterCancellation } from './debut-cadence-rules'
import {
  consumeFirstQueuePosition, moveTurnAndFix,
  removeTurnFromFixedPositions, type FixedTurnPositions
} from './fixed-turn-rules'
import { applyFrozenQueueOrder, normalizeFrozenTurnIds } from './frozen-queue-rules'
import { PersistenceError, type StateRepository } from './state-repository'

export interface ReadonlyAppState {
  readonly queue: readonly Readonly<QueueEntry>[]
  readonly history: readonly Readonly<QueueEntry>[]
  readonly sessions: readonly Readonly<KaraokeSession>[]
  readonly currentSessionId: string | null
  readonly priorityIds: readonly string[]
  readonly fixedTurnPositions: Readonly<FixedTurnPositions>
  readonly frozenTurnIds: readonly string[]
  readonly queueOrderPolicyVersion: number
  readonly regularsSinceDebut: number
  readonly currentTurnAutomatic: boolean
  readonly nextTurnId: string | null
  readonly currentTurnId: string | null
  readonly lastReset: string | null
}

export interface NewQueueEntry {
  name: string
  songNumber: string
  songNumber2: string
  table: string
}

function generateLogId(): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `LOG-${ts}-${rand}`
}

function emptyState(): AppState {
  return {
    queue: [], history: [], sessions: [], currentSessionId: null,
    priorityIds: [], fixedTurnPositions: {}, frozenTurnIds: [], nextTurnId: null, currentTurnId: null, lastReset: null,
    queueOrderPolicyVersion: 2, regularsSinceDebut: 0, currentTurnAutomatic: false
  }
}

export class KaraokeApplication {
  private current: AppState = emptyState()
  private lastInsertedAt = 0
  private startedFreshAfterEndedSession = false
  private startedFreshSessionOnLoad = false

  constructor(private readonly repository: StateRepository) {}

  get state(): ReadonlyAppState {
    return this.current
  }

  get didRecoverEndedSession(): boolean { return this.startedFreshAfterEndedSession }
  get didStartFreshSessionOnLoad(): boolean { return this.startedFreshSessionOnLoad }

  private async loadDraft(readOnly = false): Promise<void> {
    this.startedFreshAfterEndedSession = false
    this.startedFreshSessionOnLoad = false
    const data = await this.repository.load()
    this.current.queue = data.queue || []
    this.current.history = data.history || []
    this.lastInsertedAt = [...this.current.queue, ...this.current.history].reduce((latest, entry) =>
      Number.isFinite(entry.insertedAt) ? Math.max(latest, entry.insertedAt) : latest, 0)
    this.current.sessions = data.sessions || []
    this.current.currentSessionId = data.currentSessionId || null
    this.current.priorityIds = data.priorityIds || []
    this.current.nextTurnId = data.nextTurnId || null
    this.current.currentTurnId = data.currentTurnId || null
    this.current.fixedTurnPositions = this.normalizeFixedPositions(data.fixedTurnPositions || {})
    this.current.frozenTurnIds = this.normalizeFrozenTurnIds(Array.isArray(data.frozenTurnIds) ? data.frozenTurnIds : [])
    this.current.queueOrderPolicyVersion = Number(data.queueOrderPolicyVersion) || 0
    this.current.regularsSinceDebut = Math.max(0, Math.min(2, Math.trunc(Number(data.regularsSinceDebut) || 0)))
    this.current.currentTurnAutomatic = data.currentTurnAutomatic === true
    this.current.lastReset = data.lastReset || null

    if (this.current.sessions.length === 0) {
      if (!readOnly) {
        const session = this.createSession()
        this.startedFreshSessionOnLoad = true
        // Pre-session stores had one live queue and no session history. The
        // absence of any session record is the only case where every pending
        // row has an unambiguous owner.
        this.current.queue.forEach(entry => { if (!entry.sessionId) entry.sessionId = session.id })
        this.current.history.forEach(entry => { if (!entry.sessionId) entry.sessionId = session.id })
      }
    } else if (!this.current.currentSessionId) {
      this.current.currentSessionId = this.current.sessions[this.current.sessions.length - 1].id
    }
    this.repairLegacyActiveReferences()
    if (readOnly) return
    // One-time migration: preserve the old forced-next/pin order as fixed
    // positions, then stop applying the legacy priority mechanisms.
    const legacyOrder = playOrder(this.current.queue, this.current.history, this.current.currentSessionId,
      this.current.priorityIds, this.current.nextTurnId, Date.now(), this.protectedTurnIds())
    const legacyPending = legacyOrder.filter(entry => entry.id !== this.current.currentTurnId)
    const occupied = new Set(Object.values(this.current.fixedTurnPositions))
    for (const id of [...(this.current.nextTurnId ? [this.current.nextTurnId] : []), ...this.current.priorityIds]) {
      if (this.current.fixedTurnPositions[id]) continue
      const index = legacyPending.findIndex(entry => entry.id === id)
      if (index < 0) continue
      let position = index + 1
      while (occupied.has(position)) position++
      this.current.fixedTurnPositions[id] = position
      occupied.add(position)
    }
    this.current.priorityIds = []
    this.current.nextTurnId = null
    if (this.current.queueOrderPolicyVersion < 1) {
      const scheduled = applyFrozenQueueOrder(legacyOrder, this.current.currentTurnId,
        this.current.frozenTurnIds, this.current.fixedTurnPositions)
      const byId = new Map(this.current.queue.map(entry => [entry.id, entry]))
      this.current.queue = scheduled.map(entry => byId.get(entry.id)!).filter(Boolean)
      this.current.queueOrderPolicyVersion = 1
      this.current.regularsSinceDebut = 0
      this.current.currentTurnAutomatic = false
    }
    const loadedSession = this.current.sessions.find(session => session.id === this.current.currentSessionId)
    if (loadedSession?.endedAt != null) {
      this.archiveActiveQueue()
      this.clearActiveQueueState()
      this.createSession()
      this.startedFreshAfterEndedSession = true
      this.startedFreshSessionOnLoad = true
    }
    // Existing v1 operational queues need one repair. Already repaired queues
    // (including explicit manual moves) resume exactly, without a load shuffle.
    if (this.current.queueOrderPolicyVersion < 2) {
      this.repairTableRotation()
      this.current.queueOrderPolicyVersion = 2
    }
  }

  /** Repair null session links only where persisted active controls identify the entry. */
  private repairLegacyActiveReferences(): void {
    let ambiguous = [...this.current.queue, ...this.current.history]
      .filter(entry => entry.status === 'pending' && !entry.sessionId).length
    const sessionId = this.current.currentSessionId
    const session = this.current.sessions.find(item => item.id === sessionId)
    if (!sessionId || !session || session.endedAt != null) {
      if (ambiguous) this.log('LEGACY_SESSION_LINK_AMBIGUOUS', 'load')
      return
    }

    const referencedIds = new Set([
      this.current.currentTurnId,
      this.current.nextTurnId,
      ...this.current.priorityIds,
      ...Object.keys(this.current.fixedTurnPositions),
      ...this.current.frozenTurnIds
    ].filter((id): id is string => Boolean(id)))
    for (const entry of this.current.queue) {
      if (entry.sessionId) continue
      if (referencedIds.has(entry.id)) entry.sessionId = sessionId
    }
    ambiguous = [...this.current.queue, ...this.current.history]
      .filter(entry => entry.status === 'pending' && !entry.sessionId).length
    if (ambiguous) this.log('LEGACY_SESSION_LINK_AMBIGUOUS', 'load')
  }

  // Only a confirmed candidate is published. The candidate never escapes while
  // a write is in flight, and the next command is prepared from its predecessor.
  private operationTail: Promise<unknown> = Promise.resolve()
  private generation = 0
  private failure: Error | null = null
  private uncertain: KaraokeApplication | null = null
  private closing = false

  private enqueue<T>(operation: string, prepare: (draft: KaraokeApplication) => T | Promise<T>, persist = true): Promise<T> {
    const generation = this.generation
    const sessionId = this.current.currentSessionId
    const admitted = (!this.closing || operation === 'endCurrentSession') && !this.uncertain &&
      !(this.failure instanceof PersistenceError && this.failure.outcome === 'uncertain')
    const run = this.operationTail.then(async () => {
      if (!admitted || this.uncertain || generation !== this.generation ||
          (operation !== 'load' && sessionId !== this.current.currentSessionId)) {
        throw new PersistenceError('rejected', 'A operação não foi executada. Confira a sessão e tente novamente.')
      }
      const draft = new KaraokeApplication(this.repository)
      draft.current = structuredClone(this.current)
      draft.lastInsertedAt = this.lastInsertedAt
      draft.startedFreshAfterEndedSession = this.startedFreshAfterEndedSession
      draft.startedFreshSessionOnLoad = this.startedFreshSessionOnLoad
      try {
        const result = await prepare(draft)
        // Queries/no-ops and duplicate completion requests never write.
        if (persist && (operation === 'load' || JSON.stringify(draft.current) !== JSON.stringify(this.current))) {
          if (!await this.repository.save(draft.current)) throw new PersistenceError('failed')
        }
        this.publish(draft)
        this.failure = null
        return result
      } catch (error) {
        this.generation++ // reject already queued dependents; never replay them blindly
        this.failure = error instanceof Error ? error : new Error(String(error))
        if (error instanceof PersistenceError && error.outcome === 'uncertain') this.uncertain = draft
        this.log('PERSISTENCE_OPERATION_FAILED', operation)
        throw error
      }
    })
    this.operationTail = run.catch(() => undefined)
    return run
  }

  private publish(draft: KaraokeApplication): void {
    this.current = draft.current
    this.lastInsertedAt = draft.lastInsertedAt
    this.startedFreshAfterEndedSession = draft.startedFreshAfterEndedSession
    this.startedFreshSessionOnLoad = draft.startedFreshSessionOnLoad
  }

  private log(event: string, operation: string): void {
    try {
      if (typeof window !== 'undefined') window.karaokeDiagnostics?.reportRendererError(event,
        JSON.stringify({ operation, sessionId: this.current.currentSessionId }))
    } catch { /* diagnostics must never affect durability */ }
  }

  async load(readOnly = false): Promise<void> {
    await this.enqueue('load', draft => draft.loadDraft(readOnly), !readOnly)
    if (!readOnly) this.repository.finishMigration()
  }

  persist(): Promise<boolean> { return this.enqueue('persist', () => true) }

  async flush(): Promise<void> {
    await this.operationTail
    if (this.failure) throw this.failure
    await this.repository.flush()
  }

  /** Freeze admission only during the native close dialogue, after accepted writes settle. */
  async prepareToClose(): Promise<void> {
    this.closing = true
    await this.flush()
  }
  cancelClose(): void { this.closing = false }

  recoverPersistence(): Promise<'committed' | 'unchanged'> {
    const run = this.operationTail.then(async () => {
      this.log('PERSISTENCE_RECOVERY_STARTED', 'recover')
      if (!this.repository.recover) throw new PersistenceError('uncertain')
      const committed = await this.repository.recover()
      if (this.uncertain && committed === 'committed') this.publish(this.uncertain)
      this.uncertain = null
      this.failure = null
      this.log('PERSISTENCE_RECOVERED', 'recover')
      return committed
    }).catch(error => {
      this.generation++
      this.failure = new PersistenceError('uncertain')
      this.log('PERSISTENCE_UNCERTAIN', 'recover')
      throw error
    })
    this.operationTail = run.catch(() => undefined)
    return run
  }

  addEntry(input: NewQueueEntry) { input = { ...input }; return this.enqueue('addEntry', draft => draft.addEntryDraft(input)) }
  editEntry(id: string, input: NewQueueEntry) { input = { ...input }; return this.enqueue('editEntry', draft => draft.editEntryDraft(id, input)) }
  cancelEntry(id: string, cancelledAt = Date.now()) { return this.enqueue('cancelEntry', draft => draft.cancelEntryDraft(id, cancelledAt)) }
  markDone(id: string, doneAt = Date.now()) { return this.enqueue('markDone', draft => draft.markDoneDraft(id, doneAt)) }
  pinNext(id: string) { return this.enqueue('pinNext', draft => draft.pinNextDraft(id)) }
  unpin(id: string) { return this.enqueue('unpin', draft => draft.unpinDraft(id)) }
  moveTurn(id: string, targetPosition: number) { return this.enqueue('moveTurn', draft => draft.moveTurnDraft(id, targetPosition)) }
  promoteToCurrent(id: string) { return this.enqueue('promoteToCurrent', draft => draft.promoteToCurrentDraft(id)) }
  ensureCurrentTurn() { return this.enqueue('ensureCurrentTurn', draft => draft.ensureCurrentTurnDraft()) }
  freezeThrough(id: string) { return this.enqueue('freezeThrough', draft => draft.freezeThroughDraft(id)) }
  releaseFreeze() { return this.enqueue('releaseFreeze', draft => draft.releaseFreezeDraft()) }
  startNewSession() { return this.enqueue('startNewSession', draft => draft.startNewSessionDraft()) }
  ensureSession() { return this.enqueue('ensureSession', draft => draft.ensureSessionDraft()) }
  resetTableHistory(table: string) { return this.enqueue('resetTableHistory', draft => draft.resetTableHistoryDraft(table)) }
  endCurrentSession() { return this.enqueue('endCurrentSession', draft => draft.endCurrentSessionDraft()) }

  addEntries(inputs: NewQueueEntry[], selectCurrent = false) {
    const captured = structuredClone(inputs)
    return this.enqueue('addEntries', draft => {
      return captured.map(input => {
        const entry = draft.addEntryDraft(input)
        // Preserve the former per-row selection timing, within one commit.
        if (selectCurrent) draft.ensureCurrentTurnDraft()
        return entry
      })
    })
  }

  completeAndAdvance(id: string, doneAt = Date.now()) {
    return this.enqueue('completeAndAdvance', draft => {
      const entry = draft.markDoneDraft(id, doneAt)
      if (entry) draft.ensureCurrentTurnDraft()
      return entry
    })
  }

  cancelAndAdvance(id: string) {
    return this.enqueue('cancelAndAdvance', draft => {
      const entry = draft.cancelEntryDraft(id)
      if (entry) draft.ensureCurrentTurnDraft()
      return entry
    })
  }

  private addEntryDraft(input: NewQueueEntry): QueueEntry {
    this.lastInsertedAt = Math.max(Date.now(), this.lastInsertedAt + 1)
    const entry: QueueEntry = {
      id: generateLogId(), name: input.name.trim(), songNumber: input.songNumber.trim(),
      songNumber2: input.songNumber2.trim(), table: String(input.table).trim(),
      insertedAt: this.lastInsertedAt, status: 'pending', sessionId: this.current.currentSessionId
    }
    this.current.queue.push(entry)
    const debuts = debutTurnIds(this.current.queue, this.current.history, this.current.currentSessionId)
    if (debuts.has(entry.id)) this.scheduleDebut(entry.id)
    this.repairTableRotation()
    return entry
  }

  private editEntryDraft(id: string, input: NewQueueEntry): boolean {
    const entry = this.current.queue.find(item => item.id === id)
    if (!entry) return false
    const previousDebuts = debutTurnIds(this.current.queue, this.current.history, this.current.currentSessionId)
    const previousTable = entry.table
    entry.name = input.name.trim()
    entry.songNumber = input.songNumber.trim()
    entry.songNumber2 = input.songNumber2.trim()
    entry.table = String(input.table).trim()
    const currentDebuts = debutTurnIds(this.current.queue, this.current.history, this.current.currentSessionId)
    for (const debutId of currentDebuts) {
      if (!previousDebuts.has(debutId)) this.scheduleDebut(debutId)
    }
    if (entry.table !== previousTable) this.repairTableRotation()
    return true
  }

  private cancelEntryDraft(id: string, cancelledAt = Date.now()): QueueEntry | null {
    const entry = this.current.queue.find(item => item.id === id)
    if (!entry) return null
    const wasDebut = debutTurnIds(this.current.queue, this.current.history, this.current.currentSessionId).has(id)
    const oldPosition = this.getPlayOrder().findIndex(item => item.id === id)
    this.removeTurnPosition(id)
    this.current.frozenTurnIds = this.current.frozenTurnIds.filter(frozenId => frozenId !== id)
    this.current.queue = this.current.queue.filter(item => item.id !== id)
    this.current.priorityIds = this.current.priorityIds.filter(priority => priority !== id)
    if (this.current.currentTurnId === id) this.current.currentTurnId = null
    if (this.current.currentTurnId === null) this.current.currentTurnAutomatic = false
    if (this.current.nextTurnId === id) this.current.nextTurnId = null
    entry.status = 'cancelled'
    entry.cancelledAt = cancelledAt
    this.current.history.unshift(entry)
    if (wasDebut) this.transferCancelledDebut(entry.table, oldPosition)
    else this.restoreCadenceAfterCancellation()
    this.repairTableRotation()
    return entry
  }

  private markDoneDraft(id: string, doneAt = Date.now()): QueueEntry | null {
    const index = this.current.queue.findIndex(entry => entry.id === id)
    if (index === -1) return null
    const wasAutomatic = id === this.current.currentTurnId && this.current.currentTurnAutomatic
    const debutIds = debutTurnIds(this.current.queue, this.current.history, this.current.currentSessionId)
    const wasDebut = debutIds.has(id)
    const otherPending = this.current.queue.filter(entry => entry.id !== id && entry.status === 'pending')
    const otherDebuts = debutTurnIds(otherPending, this.current.history, this.current.currentSessionId)
    const hasAutomaticDebut = otherPending.some(entry => otherDebuts.has(entry.id) && !this.isProtected(entry.id))
    this.removeTurnPosition(id)
    this.current.frozenTurnIds = this.current.frozenTurnIds.filter(frozenId => frozenId !== id)
    const [entry] = this.current.queue.splice(index, 1)
    entry.status = 'done'
    entry.doneAt = doneAt
    this.current.priorityIds = this.current.priorityIds.filter(priority => priority !== entry.id)
    if (this.current.currentTurnId === entry.id) this.current.currentTurnId = null
    if (this.current.currentTurnId === null) this.current.currentTurnAutomatic = false
    if (this.current.nextTurnId === entry.id) this.current.nextTurnId = null
    this.current.history.unshift(entry)
    // A completed automatic debut closes its cycle even if the regular group
    // is empty. Regular increments still require an available automatic debut.
    if (wasAutomatic && wasDebut) this.current.regularsSinceDebut = 0
    else if (wasAutomatic && hasAutomaticDebut) {
      this.current.regularsSinceDebut = Math.min(2, this.current.regularsSinceDebut + 1)
    }
    this.repairTableRotation()
    return entry
  }

  private pinNextDraft(id: string): void {
    this.moveTurnDraft(id, 1)
  }

  private unpinDraft(id: string): void {
    if (this.current.fixedTurnPositions[id] === undefined) return
    const { [id]: _removed, ...remaining } = this.current.fixedTurnPositions
    this.current.fixedTurnPositions = remaining
    this.repairTableRotation()
  }

  private moveTurnDraft(id: string, targetPosition: number): boolean {
    const moved = this.previewTurnMove(id, targetPosition)
    if (!moved) return false
    this.current.fixedTurnPositions = moved.fixedPositions
    this.current.priorityIds = []
    this.current.nextTurnId = null
    return true
  }

  /** Check whether the exact manual move would change queue order, without mutating state. */
  canMoveTurn(id: string, targetPosition: number): boolean {
    return this.previewTurnMove(id, targetPosition) !== null
  }

  private previewTurnMove(id: string, targetPosition: number) {
    if (!this.current.queue.some(entry => entry.id === id) || id === this.current.currentTurnId) return null
    if (this.current.frozenTurnIds.includes(id) || targetPosition <= this.current.frozenTurnIds.length) return null
    const order = this.getPlayOrder().filter(entry => entry.id !== this.current.currentTurnId)
    return moveTurnAndFix(order, this.current.fixedTurnPositions, id, targetPosition)
  }

  private promoteToCurrentDraft(id: string): boolean {
    if (!this.current.queue.some(entry => entry.id === id) || id === this.current.currentTurnId) return false
    const oldCurrentId = this.current.currentTurnId
    const wasTargetFixed = this.current.fixedTurnPositions[id] !== undefined
    this.current.frozenTurnIds = this.current.frozenTurnIds.filter(frozenId => frozenId !== id)
    const orderAfterCurrent = this.getPlayOrder().filter(entry => entry.id !== oldCurrentId)
    const targetPosition = orderAfterCurrent.findIndex(entry => entry.id === id) + 1
    let fixed = removeTurnFromFixedPositions(this.current.fixedTurnPositions, id,
      targetPosition > 0 ? targetPosition : null)
    if (oldCurrentId && oldCurrentId !== id && this.current.queue.some(entry => entry.id === oldCurrentId)) {
      fixed = Object.fromEntries(Object.entries(fixed).map(([fixedId, position]) => [fixedId, position + 1]))
      fixed[oldCurrentId] = 1
    }
    if (wasTargetFixed) fixed[id] = 0
    this.current.fixedTurnPositions = fixed
    this.current.currentTurnId = id
    this.current.currentTurnAutomatic = false
    this.current.nextTurnId = null
    this.repairTableRotation()
    return true
  }

  private ensureCurrentTurnDraft(): void {
    const hadCurrent = Boolean(this.current.currentTurnId &&
      this.current.queue.some(entry => entry.id === this.current.currentTurnId))
    if (!hadCurrent) this.repairTableRotation()
    const order = this.getPlayOrder()
    const turn = resolveCurrentTurn([...this.current.queue], [...order], this.current.currentTurnId, this.current.nextTurnId)
    if (!hadCurrent) {
      const selectedWasProtected = Boolean(turn.current && this.isProtected(turn.current.id))
      this.current.currentTurnId = turn.currentTurnId
      this.current.currentTurnAutomatic = Boolean(turn.current && !selectedWasProtected)
      this.current.nextTurnId = turn.nextTurnId
      if (turn.currentTurnId) {
        this.current.frozenTurnIds = this.current.frozenTurnIds.filter(id => id !== turn.currentTurnId)
      }
      if (turn.current) this.current.fixedTurnPositions = consumeFirstQueuePosition(
        this.current.fixedTurnPositions, turn.current.id)
    }
  }

  getPlayOrder(): readonly Readonly<QueueEntry>[] {
    const currentId = this.current.currentTurnId &&
      this.current.queue.some(entry => entry.id === this.current.currentTurnId)
      ? this.current.currentTurnId : null
    return applyFrozenQueueOrder([...this.current.queue], this.current.currentTurnId, this.current.frozenTurnIds,
      this.current.fixedTurnPositions)
  }

  isTurnFrozen(id: string): boolean {
    return this.current.frozenTurnIds.includes(id)
  }

  private freezeThroughDraft(id: string): boolean {
    if (!this.current.queue.some(entry => entry.id === id) || id === this.current.currentTurnId) return false
    const order = this.getPlayOrder().filter(entry => entry.id !== this.current.currentTurnId)
    const index = order.findIndex(entry => entry.id === id)
    if (index < this.current.frozenTurnIds.length) return false
    const nextIds = order.slice(0, index + 1).map(entry => entry.id)
    if (nextIds.length === this.current.frozenTurnIds.length &&
        nextIds.every((value, position) => value === this.current.frozenTurnIds[position])) return false
    this.current.frozenTurnIds = nextIds
    return true
  }

  private releaseFreezeDraft(): boolean {
    if (!this.current.frozenTurnIds.length) return false
    this.current.frozenTurnIds = []
    this.repairTableRotation()
    return true
  }

  private startNewSessionDraft(): void {
    const current = this.current.sessions.find(session => session.id === this.current.currentSessionId)
    if (current && !current.endedAt) current.endedAt = Date.now()
    this.archiveActiveQueue()
    this.createSession()
    this.clearActiveQueueState()
    this.current.lastReset = new Date().toDateString()
  }

  private ensureSessionDraft(): void {
    if (this.current.sessions.length === 0) {
      this.createSession()
    }
  }

  private resetTableHistoryDraft(table: string): void {
    const previousDebuts = debutTurnIds(this.current.queue, this.current.history, this.current.currentSessionId)
    this.current.history = this.current.history.filter(entry =>
      !(entry.sessionId === this.current.currentSessionId && entry.table === table)
    )
    const currentDebuts = debutTurnIds(this.current.queue, this.current.history, this.current.currentSessionId)
    for (const id of currentDebuts) {
      if (!previousDebuts.has(id) && this.current.queue.some(entry => entry.id === id && entry.table === table)) {
        this.scheduleDebut(id)
      }
    }
  }

  private endCurrentSessionDraft(): boolean {
    const session = this.current.sessions.find(item => item.id === this.current.currentSessionId)
    if (!session || session.endedAt != null) return false
    this.archiveActiveQueue()
    session.endedAt = Date.now()
    this.clearActiveQueueState()
    return true
  }

  private createSession(): KaraokeSession {
    const session: KaraokeSession = { id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, startedAt: Date.now(), endedAt: null }
    this.current.sessions.push(session)
    this.current.currentSessionId = session.id
    return session
  }

  private archiveActiveQueue(): void {
    const sessionId = this.current.currentSessionId
    if (!sessionId || !this.current.queue.length) return
    const archivedIds = new Set(this.current.history.map(entry => entry.id))
    const ordered = this.getPlayOrder()
    const orderedIds = new Set(ordered.map(entry => entry.id))
    const entries = [...ordered, ...this.current.queue.filter(entry => !orderedIds.has(entry.id))]
    const pending = entries.filter(entry => entry.status === 'pending' && !archivedIds.has(entry.id))
    const pendingIds = new Set(pending.map(entry => entry.id))
    this.current.queue.forEach(entry => {
      if (pendingIds.has(entry.id)) entry.sessionId ??= sessionId
    })
    this.current.history = [...pending, ...this.current.history]
  }

  private clearActiveQueueState(): void {
    this.current.queue = []
    this.current.priorityIds = []
    this.current.fixedTurnPositions = {}
    this.current.frozenTurnIds = []
    this.current.nextTurnId = null
    this.current.currentTurnId = null
    this.current.currentTurnAutomatic = false
    this.current.regularsSinceDebut = 0
    this.current.queueOrderPolicyVersion = 2
  }

  private removeTurnPosition(id: string): void {
    const position = id === this.current.currentTurnId
      ? null
      : this.getPlayOrder().filter(entry => entry.id !== this.current.currentTurnId)
        .findIndex(entry => entry.id === id) + 1
    this.current.fixedTurnPositions = removeTurnFromFixedPositions(
      this.current.fixedTurnPositions, id, position && position > 0 ? position : null)
  }

  private normalizeFixedPositions(input: Readonly<FixedTurnPositions>): FixedTurnPositions {
    const pendingCount = Math.max(0, this.current.queue.length -
      (this.current.currentTurnId && this.current.queue.some(entry => entry.id === this.current.currentTurnId) ? 1 : 0))
    const ids = new Set(this.current.queue.map(entry => entry.id))
    const used = new Set<number>()
    const normalized: FixedTurnPositions = {}
    Object.entries(input)
      .filter(([id, position]) => ids.has(id) && Number.isFinite(position))
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .forEach(([id, rawPosition]) => {
        if (id === this.current.currentTurnId) {
          normalized[id] = 0
          return
        }
        if (!pendingCount) return
        const desired = Math.max(1, Math.min(pendingCount, Math.trunc(rawPosition)))
        let position = desired
        while (position <= pendingCount && used.has(position)) position++
        if (position > pendingCount) {
          position = 1
          while (used.has(position) && position <= pendingCount) position++
        }
        if (position <= pendingCount) {
          normalized[id] = position
          used.add(position)
        }
      })
    return normalized
  }

  private normalizeFrozenTurnIds(ids: readonly string[]): string[] {
    return normalizeFrozenTurnIds(ids, this.current.queue, this.current.currentTurnId)
  }

  private protectedTurnIds(): string[] {
    return [...new Set([
      ...(this.current.currentTurnId ? [this.current.currentTurnId] : []),
      ...this.current.frozenTurnIds,
      ...Object.keys(this.current.fixedTurnPositions)
    ])]
  }

  private isProtected(id: string): boolean {
    return this.current.currentTurnId === id || this.current.frozenTurnIds.includes(id) ||
      this.current.fixedTurnPositions[id] !== undefined
  }

  private scheduleDebut(id: string): void {
    const debuts = debutTurnIds(this.current.queue, this.current.history, this.current.currentSessionId)
    if (!debuts.has(id)) return
    const order = insertNewDebutByCadence(this.getPlayOrder(), id, debuts,
      this.current.regularsSinceDebut, this.protectedTurnIds())
    const byId = new Map(this.current.queue.map(entry => [entry.id, entry]))
    this.current.queue = order.map(entry => byId.get(entry.id)!).filter(Boolean)
  }

  /** Repair only automatic slots at mutation boundaries. Reads never schedule. */
  private repairTableRotation(): void {
    const current = this.current.queue.find(entry => entry.id === this.current.currentTurnId)
    const pending = this.getPlayOrder().filter(entry => entry.id !== current?.id)
    const protectedIds = new Set(this.protectedTurnIds())
    const debuts = debutTurnIds(this.current.queue, this.current.history, this.current.currentSessionId)
    const lastDone = sungEntries(this.current.history, this.current.currentSessionId)
      .reduce<SungEntry | null>((last, entry) => !last || entry.doneAt > last.doneAt ? entry : last, null)
    // No retroactive round credit when all waiting requests arrived after the
    // previous completion. The last table still informs adjacent repetition.
    const sharedOpportunity = Boolean(current || (lastDone && pending.some(entry => entry.insertedAt <= lastDone.doneAt)))
    const repaired = roundRobinOrder(pending,
      current?.table ?? lastDone?.table ?? null, debuts, protectedIds, sharedOpportunity,
      new Set(this.current.queue.filter(entry => debuts.has(entry.id)).map(entry => entry.table)))
    if (repaired.every((entry, index) => entry.id === pending[index].id)) return

    // Keep protected entries at their base-array locations as well as keeping
    // pin/freeze metadata untouched. Reapplying the existing overlays then
    // produces precisely the repaired effective automatic subsequence.
    const automatic = repaired.filter(entry => !protectedIds.has(entry.id))
    const byId = new Map(this.current.queue.map(entry => [entry.id, entry]))
    let cursor = 0
    this.current.queue = this.current.queue.map(entry => protectedIds.has(entry.id)
      ? entry : byId.get(automatic[cursor++].id)!)
  }

  private transferCancelledDebut(table: string, oldPosition: number): void {
    const next = this.current.queue.filter(entry => entry.table === table)
      .sort((a, b) => a.insertedAt - b.insertedAt || a.id.localeCompare(b.id))[0]
    if (!next || !debutTurnIds(this.current.queue, this.current.history, this.current.currentSessionId).has(next.id)) return
    const order = [...this.getPlayOrder()]
    const withoutNext = order.filter(entry => entry.id !== next.id)
    const target = Math.max(0, Math.min(withoutNext.length, oldPosition))
    withoutNext.splice(target, 0, next)
    const byId = new Map(this.current.queue.map(entry => [entry.id, entry]))
    this.current.queue = withoutNext.map(entry => byId.get(entry.id)!).filter(Boolean)
  }

  private restoreCadenceAfterCancellation(): void {
    const order = [...this.getPlayOrder()]
    const debuts = debutTurnIds(this.current.queue, this.current.history, this.current.currentSessionId)
    const restored = restoreRegularOpportunitiesAfterCancellation(order, debuts,
      this.current.regularsSinceDebut, this.protectedTurnIds())
    const byId = new Map(this.current.queue.map(entry => [entry.id, entry]))
    this.current.queue = restored.map(entry => byId.get(entry.id)!).filter(Boolean)
  }
}
