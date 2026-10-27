import assert from 'node:assert/strict'
import { KaraokeApplication } from '../src/application'
import { createStateRepository } from '../src/state-repository'
import { debutTurnIds } from '../src/queue-rules'

/** Deterministic empty-group boundaries, usable against the previous build too. */
export async function simulateCadenceReset(Application = KaraokeApplication) {
  let now = Date.UTC(2026, 9, 26, 22)
  const originalNow = Date.now
  const originalRandom = Math.random
  let random = 123
  Date.now = () => now
  Math.random = () => ((random = (random * 1664525 + 1013904223) >>> 0) / 4294967296)
  let saved: StoredAppState = {
    queue: [], history: ['1', '2', '3'].map(table => ({
      id: `old-${table}`, name: table, table, songNumber: '1', songNumber2: '',
      insertedAt: now - 10_000_000, doneAt: now - 9_000_000 + Number(table), status: 'done', sessionId: 's1'
    })), sessions: [{ id: 's1', startedAt: now - 86_400_000, endedAt: null }], currentSessionId: 's1',
    queueOrderPolicyVersion: 2, regularsSinceDebut: 0
  }
  const repository = createStateRepository({
    async load() { return structuredClone(saved) },
    async save(state) { saved = structuredClone(state); return true }
  })
  let app = new Application(repository)
  const metrics = {
    events: 0, completions: 0, cancellations: 0, restarts: 0, protectedCompletions: 0,
    staleAutomaticDebutResets: 0, avoidableRepeats: 0, existingOrderInversions: 0, arrivalOvertakes: 0,
    groups: '', tables: [] as string[], phases: [] as number[], cycleEndPhases: [] as number[],
    completedByTable: {} as Record<string, number>, finalPhase: 0
  }
  let previous: string | null = null
  const event = () => { now += 60_000; metrics.events++ }
  const add = async (table: string) => {
    event()
    const before = app.getPlayOrder().map(entry => entry.id)
    const entry = (await app.addEntry({ name: table, table, songNumber: '111', songNumber2: '222' }))
    const after = app.getPlayOrder().map(item => item.id)
    metrics.arrivalOvertakes += before.filter(id => after.indexOf(id) > after.indexOf(entry.id)).length
    for (let a = 0; a < before.length; a++) for (let b = a + 1; b < before.length; b++) {
      if (after.indexOf(before[a]) > after.indexOf(before[b])) metrics.existingOrderInversions++
    }
    return entry.id
  }
  const complete = async () => {
    event()
    const visible = app.state.currentTurnId ?? app.getPlayOrder()[0]?.id
    const phaseBeforeSelection = app.state.regularsSinceDebut
    await app.ensureCurrentTurn()
    assert.equal(app.state.regularsSinceDebut, phaseBeforeSelection)
    assert.equal(app.state.currentTurnId, visible)
    const entry = app.state.queue.find(item => item.id === app.state.currentTurnId)!
    const debut = debutTurnIds(app.state.queue, app.state.history, 's1').has(entry.id)
    const automatic = app.state.currentTurnAutomatic
    if (!automatic) metrics.protectedCompletions++
    if (entry.table === previous && app.state.queue.some(item => item.table !== entry.table)) metrics.avoidableRepeats++
    previous = entry.table
    await app.markDone(entry.id, now)
    if (automatic && debut && app.state.regularsSinceDebut !== 0) metrics.staleAutomaticDebutResets++
    metrics.groups += debut ? 'E' : 'R'
    metrics.tables.push(entry.table)
    metrics.phases.push(app.state.regularsSinceDebut)
    metrics.completedByTable[entry.table] = (metrics.completedByTable[entry.table] ?? 0) + 1
    metrics.completions++
    if (!automatic) assert.equal(app.state.regularsSinceDebut, phaseBeforeSelection)
  }
  try {
    await app.load()
    for (let cycle = 0; cycle < 8; cycle++) {
      await add('1'); await add('2'); await add(String(100 + cycle))
      while (app.state.queue.length) await complete()
      metrics.cycleEndPhases.push(app.state.regularsSinceDebut)
      await app.flush()
      const before = JSON.stringify(app.state)
      event()
      app = new Application(repository)
      await app.load()
      assert.equal(JSON.stringify(app.state), before)
      metrics.restarts++

      // Only debuts, then only regulars; neither selection nor a regular with
      // no automatic debut available may change the phase.
      await add(String(200 + cycle)); await complete()
      await add('3'); await complete()
      const canceled = await add(String(300 + cycle))
      const replacement = await add(String(300 + cycle))
      const phase = app.state.regularsSinceDebut
      event(); (await app.cancelEntry(canceled, now)); metrics.cancellations++
      assert.equal(app.state.regularsSinceDebut, phase)
      assert.deepEqual([...debutTurnIds(app.state.queue, app.state.history, 's1')], [replacement])
      event(); assert.equal((await app.freezeThrough(replacement)), true)
      await complete()
      assert.equal(app.state.regularsSinceDebut, phase)
      assert.equal(app.state.queue.length, 0)
      assert.equal(app.state.queueOrderPolicyVersion, 2)
      await app.flush()
    }
    metrics.finalPhase = app.state.regularsSinceDebut
    assert.equal(app.state.history.length, 3 + metrics.completions + metrics.cancellations)
    return metrics
  } finally { Date.now = originalNow; Math.random = originalRandom }
}
