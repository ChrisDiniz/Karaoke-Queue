import assert from 'node:assert/strict'
import { KaraokeApplication } from '../src/application'
import { createStateRepository } from '../src/state-repository'
import { debutTurnIds } from '../src/queue-rules'

/** Same deterministic event trace can run against a saved baseline build. */
export async function simulateRoundRobin(Application = KaraokeApplication, mixed = false) {
  let now = Date.UTC(2026, 9, 26, 22)
  const realNow = Date.now
  const realRandom = Math.random
  let random = 42
  Date.now = () => now
  Math.random = () => ((random = (random * 1664525 + 1013904223) >>> 0) / 4294967296)
  const entry = (id: string, table: string, index: number): QueueEntry => ({
    id, name: id, table, songNumber: '111', songNumber2: index % 2 ? '222' : '',
    insertedAt: now - 10_000 + index, sessionId: 's1', status: 'pending'
  })
  const queue = ['1', '2', '3'].flatMap(table => Array.from({ length: mixed ? 8 : 40 }, (_, i) => entry(`${table}-${i}`, table, i)))
  let saved: StoredAppState = {
    queue, history: ['1', '2', '3', '4', '5', '6'].map(table => ({ ...entry(`old-${table}`, table, 0),
      status: 'done', doneAt: now - 10_000_000 + Number(table) })), sessions: [{ id: 's1', startedAt: now - 86_400_000, endedAt: null }],
    currentSessionId: 's1', queueOrderPolicyVersion: 1, regularsSinceDebut: 0, currentTurnId: null
  }
  const repository = createStateRepository({
    async load() { return structuredClone(saved) },
    async save(state) { saved = structuredClone(state); return true }
  })
  let app = new Application(repository)
  const metrics = {
    events: 0, completions: 0, cancellations: 0, arrivals: 0, restarts: 0,
    regularCompletions: 0, debutCompletions: 0, automaticGroups: '',
    consecutive: 0, repeatsWithUnprotectedAlternative: 0, protectedRepeats: 0,
    maxRun: 0, maxEligibleRoundGap: 0, maxSharedEligibilityGap: 0,
    overtakingPairs: 0, rotationRepairPairs: 0, initialRepairPairs: 0, maxCompletionWait: 0,
    completedByTable: {} as Record<string, number>, sequence: [] as string[],
    initialPending: [] as string[], firstRequestCompletion: {} as Record<string, number>,
    pending: 0, cadence: 0, unique: true, restartExact: true
  }
  let previous: string | null = null
  let run = 0
  const waitingSince = new Map(queue.map(item => [item.id, 0]))
  const effective = () => app.getPlayOrder().filter(item => item.id !== app.state.currentTurnId)
  const protectedId = (id: string) => app.state.frozenTurnIds.includes(id) || app.state.fixedTurnPositions[id] !== undefined
  const pairBalances = new Map<string, { a: string; b: string; balance: number }>()
  const syncEligiblePairs = () => {
    const eligible = [...new Set(app.state.queue.filter(item => !protectedId(item.id)).map(item => item.table))].sort()
    for (const [key, pair] of pairBalances) if (!eligible.includes(pair.a) || !eligible.includes(pair.b)) pairBalances.delete(key)
    for (let a = 0; a < eligible.length; a++) for (let b = a + 1; b < eligible.length; b++) {
      const key = JSON.stringify([eligible[a], eligible[b]])
      if (!pairBalances.has(key)) pairBalances.set(key, { a: eligible[a], b: eligible[b], balance: 0 })
    }
  }
  const prototype = Application.prototype as any
  const originalRepair = prototype.repairTableRotation
  const instrumentRepair = () => {
    prototype.repairTableRotation = function () {
      const order = () => this.getPlayOrder().filter((entry: QueueEntry) => entry.id !== this.state.currentTurnId)
      const before = order().map((entry: QueueEntry) => entry.id)
      originalRepair.call(this)
      const positions = new Map<string, number>(order().map((entry: QueueEntry, index: number) => [entry.id, index]))
      let inversions = 0
      for (let a = 0; a < before.length; a++) for (let b = a + 1; b < before.length; b++) {
        if (positions.get(before[a])! > positions.get(before[b])!) inversions++
      }
      if (metrics.events === 0 && metrics.arrivals === 0) metrics.initialRepairPairs += inversions
      else metrics.rotationRepairPairs += inversions
    }
  }
  const add = async (table: string) => {
    const added = (await app.addEntry({ name: `request-${metrics.events}`, table, songNumber: '111', songNumber2: '222' }))
    waitingSince.set(added.id, metrics.completions)
    metrics.arrivals++
  }
  try {
    instrumentRepair()
    await app.load()
    syncEligiblePairs()
    for (let event = 0; event < (mixed ? 120 : 100); event++) {
      now += 3 * 60_000
      const before = effective().map(item => item.id)
      const operation = mixed ? event % 12 : 3
      if ([3, 5, 7, 10].includes(operation)) {
        const first = app.state.currentTurnId ?? app.getPlayOrder()[0]?.id
        const manual = first ? protectedId(first) || (app.state.currentTurnId === first && !app.state.currentTurnAutomatic) : false
        await app.ensureCurrentTurn()
        const current = app.state.queue.find(item => item.id === app.state.currentTurnId)
        if (current) {
          assert.equal(current.id, first, 'executed turn matches the displayed first turn')
          const debut = debutTurnIds(app.state.queue, app.state.history, 's1').has(current.id)
          if (debut) metrics.debutCompletions++
          else metrics.regularCompletions++
          if (!manual) metrics.automaticGroups += debut ? 'D' : 'R'
          if (previous === current.table) {
            metrics.consecutive++
            if (manual) metrics.protectedRepeats++
            else if (effective().some(item => item.table !== current.table && !protectedId(item.id)))
              metrics.repeatsWithUnprotectedAlternative++
          }
          run = previous === current.table ? run + 1 : 1
          metrics.maxRun = Math.max(metrics.maxRun, run)
          previous = current.table
          metrics.sequence.push(current.table)
          metrics.completions++
          for (const pair of pairBalances.values()) {
            if (current.table === pair.a) pair.balance++
            if (current.table === pair.b) pair.balance--
            metrics.maxSharedEligibilityGap = Math.max(metrics.maxSharedEligibilityGap, Math.abs(pair.balance))
          }
          metrics.completedByTable[current.table] = (metrics.completedByTable[current.table] ?? 0) + 1
          metrics.maxCompletionWait = Math.max(metrics.maxCompletionWait, metrics.completions - (waitingSince.get(current.id) ?? 0))
          if (current.id.endsWith('-0')) metrics.firstRequestCompletion[current.table] = metrics.completions
          await app.markDone(current.id, now)
          const eligible = new Set(app.state.queue.filter(item => !protectedId(item.id)).map(item => item.table))
          const counts = [...eligible].map(table => metrics.completedByTable[table] ?? 0)
          if (counts.length > 1) metrics.maxEligibleRoundGap = Math.max(metrics.maxEligibleRoundGap, Math.max(...counts) - Math.min(...counts))
        }
      } else if (operation === 0 || operation === 1) await add('1')
      else if (operation === 2) await add('2')
      else if (operation === 4) await add(String(100 + event))
      else if (operation === 6) {
        const target = effective().filter(item => !protectedId(item.id) && !item.id.includes('-0')).at(-1)
        if (target) { (await app.cancelEntry(target.id, now)); metrics.cancellations++ }
      } else if (operation === 8) {
        const pending = effective()
        if (pending.length > 3) (await app.moveTurn(pending.at(-1)!.id, app.state.frozenTurnIds.length + 2))
      } else if (operation === 9) {
        const pending = effective()
        if (pending.length > 2) (await app.freezeThrough(pending[1].id))
      } else if (operation === 11) {
        await app.releaseFreeze()
        for (const id of Object.keys(app.state.fixedTurnPositions)) (await app.unpin(id))
      }
      metrics.events++
      syncEligiblePairs()
      const after = effective().map(item => item.id)
      const positions = new Map(after.map((id, index) => [id, index]))
      for (let a = 0; a < before.length; a++) for (let b = a + 1; b < before.length; b++) {
        if (positions.has(before[a]) && positions.has(before[b]) && positions.get(before[a])! > positions.get(before[b])!) metrics.overtakingPairs++
      }
      assert.equal(new Set(app.getPlayOrder().map(item => item.id)).size, app.state.queue.length)
      const stateBeforeRead = JSON.stringify(app.state)
      for (let read = 0; read < 3; read++) app.getPlayOrder()
      assert.equal(JSON.stringify(app.state), stateBeforeRead)
      if (event === (mixed ? 58 : 49)) {
        await app.flush()
        const order = app.getPlayOrder().map(item => item.id)
        const phase = app.state.regularsSinceDebut
        const frozen = [...app.state.frozenTurnIds]
        const pins = { ...app.state.fixedTurnPositions }
        app = new Application(repository)
        instrumentRepair()
        await app.load()
        assert.deepEqual(app.getPlayOrder().map(item => item.id), order)
        assert.equal(app.state.regularsSinceDebut, phase)
        assert.deepEqual(app.state.frozenTurnIds, frozen)
        assert.deepEqual(app.state.fixedTurnPositions, pins)
        metrics.restarts++
      }
    }
    await app.flush()
    metrics.initialPending = app.state.queue.filter(item => queue.some(initial => initial.id === item.id)).map(item => item.id)
    metrics.pending = app.state.queue.length
    metrics.cadence = app.state.regularsSinceDebut
    assert.equal(app.state.queue.length + app.state.history.filter(item => !item.id.startsWith('old-')).length,
      queue.length + metrics.arrivals, 'no lost or duplicated requests')
    return metrics
  } finally { prototype.repairTableRotation = originalRepair; Date.now = realNow; Math.random = realRandom }
}
