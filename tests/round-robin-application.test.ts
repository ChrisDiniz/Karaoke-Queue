import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KaraokeApplication } from '../src/application'
import { debutTurnIds } from '../src/queue-rules'
import { createStateRepository } from '../src/state-repository'
import { createKaraokeDatabase } from '../database'
import { simulateRoundRobin } from './round-robin-simulation'

const NOW = Date.UTC(2026, 9, 26, 22)
export function turn(id: string, table: string, index = 0): QueueEntry {
  return { id, name: id, table, insertedAt: NOW - 10_000 + index, sessionId: 's1',
    songNumber: '111', songNumber2: index % 2 ? '222' : '', status: 'pending' }
}
export function seed(tables: string[], extra: StoredAppState = {}): StoredAppState {
  return {
    queue: tables.map((table, index) => turn(`${table}-${index}`, table, index)),
    history: ['1', '2', '3', '4', '5', '6', '99'].map((table, index) => ({
      ...turn(`old-${table}`, table), status: 'done', doneAt: NOW - 10_000_000 + index
    })), sessions: [{ id: 's1', startedAt: NOW - 86_400_000, endedAt: null }], currentSessionId: 's1',
    queueOrderPolicyVersion: 1, currentTurnId: null, regularsSinceDebut: 1, ...extra
  }
}
export async function memory(seedState: StoredAppState, Application = KaraokeApplication) {
  let saved = structuredClone(seedState)
  let writes = 0
  const repository = createStateRepository({
    async load() { return structuredClone(saved) },
    async save(state) { saved = structuredClone(state); writes++; return true }
  })
  const app = new Application(repository)
  await app.load()
  return { app, repository, saved: () => saved, writes: () => writes }
}
const ids = (app: KaraokeApplication) => app.getPlayOrder().map(entry => entry.id)
const tables = (app: KaraokeApplication) => app.getPlayOrder().map(entry => entry.table)
const add = async (app: KaraokeApplication, table: string, name = table) => (await app.addEntry({ name, table, songNumber: '123', songNumber2: '456' }))

test('J: 100 conclusões equilibradas e 120 eventos mistos preservam integridade e progresso', async () => {
  const regular = await simulateRoundRobin()
  assert.deepEqual(regular.completedByTable, { '1': 34, '2': 33, '3': 33 })
  assert.equal(regular.maxEligibleRoundGap, 1)
  assert.equal(regular.maxSharedEligibilityGap, 1)
  assert.equal(regular.repeatsWithUnprotectedAlternative, 0)
  assert.equal(regular.maxRun, 1)
  assert.deepEqual(regular.firstRequestCompletion, { '1': 1, '2': 2, '3': 3 })
  const mixed = await simulateRoundRobin(KaraokeApplication, true)
  assert.equal(mixed.events, 120)
  assert.equal(mixed.completions, 40)
  assert.equal(mixed.restarts, 1)
  assert.equal(mixed.repeatsWithUnprotectedAlternative, 0)
  assert.equal(mixed.maxSharedEligibilityGap, 2, 'as reservas do roteiro misto prevalecem sobre o equilíbrio estrito')
  assert.equal(mixed.automaticGroups, 'RRRRDRRRRRDRRRRRDRRRRRDRRRRRDR', 'cadência real igual à baseline deste roteiro')
  assert.equal(mixed.regularCompletions, 30)
  assert.equal(mixed.debutCompletions, 10)
  assert.equal(mixed.cadence, 0)
  assert.equal(mixed.initialPending.length, 0, 'todos os pedidos antigos avançam ou são cancelados explicitamente')
})

test('A–C: fila operacional executa Round Robin completo e funciona com uma única mesa', async () => {
  for (const [input, expected] of [
    [['1', '1', '2'], ['1', '2', '1']],
    [['1', '1', '1', '1', '1', '2', '2', '2', '3', '3'], ['1', '2', '3', '1', '2', '3', '1', '2', '1', '1']],
    [['1', '1', '1', '1', '1'], ['1', '1', '1', '1', '1']]
  ]) {
    const { app, writes } = await memory(seed(input))
    assert.deepEqual(tables(app), expected)
    const snapshot = structuredClone(app.state)
    const writesBefore = writes()
    for (let i = 0; i < 10; i++) assert.deepEqual(tables(app), expected)
    assert.deepEqual(app.state, snapshot)
    assert.equal(writes(), writesBefore, 'consultas não gravam')
    const executed: string[] = []
    while (app.state.queue.length) {
      const before = ids(app)
      await app.ensureCurrentTurn()
      assert.equal(app.state.currentTurnId, before[0], 'executa a sequência exibida')
      const current = app.state.queue.find(entry => entry.id === app.state.currentTurnId)!
      executed.push(current.table)
      await app.markDone(current.id, NOW + executed.length)
    }
    assert.deepEqual(executed, expected)
    assert.equal(app.state.history.filter(entry => entry.doneAt! >= NOW).length, input.length, 'duas músicas são um turno')
  }
  for (const currentTurnId of [null, '1-0']) {
    const { app } = await memory(seed(['1', '1', '2'], { history: [], currentTurnId }))
    assert.deepEqual(tables(app), ['1', '2', '1'], 'João e Maria compartilham mesa mesmo antes da primeira conclusão')
    assert.deepEqual([...debutTurnIds(app.state.queue, app.state.history, 's1')], ['1-0', '2-2'])
  }
})

test('D–F: cadastros posteriores entram no ciclo sem crédito retroativo; mesa prevalece sobre cantor', async () => {
  for (const newcomers of [['2', '3'], ['20', '30']]) {
    const { app } = await memory(seed(['1', '1', '1', '1']))
    await app.ensureCurrentTurn()
    const current = app.state.currentTurnId!
    await app.markDone(current, NOW)
    await app.ensureCurrentTurn()
    const selected = app.state.currentTurnId
    await add(app, newcomers[0], 'Carlos')
    await add(app, newcomers[1], 'Pedro')
    assert.equal(app.state.currentTurnId, selected)
    const pending = app.getPlayOrder().filter(entry => entry.id !== selected)
    assert.deepEqual(pending.map(entry => entry.table), newcomers[0] === '2'
      ? ['2', '3', '1', '1'] : ['20', '1', '30', '1'], 'estreias mantêm sua intercalação; regulares completam a rodada')
    const before = ids(app)
    await app.ensureCurrentTurn()
    assert.deepEqual(ids(app), before)
    assert.equal(app.state.history.filter(entry => entry.doneAt === NOW).length, 1)
  }
  const { app } = await memory(seed(['1', '1', '1', '2'], { currentTurnId: '1-0' }))
  assert.deepEqual(tables(app), ['1', '2', '1', '1'])
  await app.editEntry('1-1', { name: 'Maria', table: '3', songNumber: '123', songNumber2: '' })
  assert.deepEqual(tables(app), ['1', '2', '3', '1'])
})

test('G: uma única estreia, reservas respeitadas e cancelamento transfere sem alterar fase', async () => {
  const { app } = await memory(seed(['1', '1', '2', '2', '10', '10', '10', '11'], {
    currentTurnId: '1-0', regularsSinceDebut: 2
  }))
  const beforeCounter = app.state.regularsSinceDebut
  assert.deepEqual([...debutTurnIds(app.state.queue, app.state.history, 's1')], ['10-4', '11-7'])
  await app.freezeThrough('10-4')
  const frozen = [...app.state.frozenTurnIds]
  await add(app, '10', 'Outra pessoa da mesa')
  assert.deepEqual(app.state.frozenTurnIds, frozen)
  assert.equal(debutTurnIds(app.state.queue, app.state.history, 's1').has('10-5'), false)
  await app.cancelEntry('10-4', NOW)
  assert.equal(debutTurnIds(app.state.queue, app.state.history, 's1').has('10-5'), true)
  assert.equal(app.state.regularsSinceDebut, beforeCounter)
  await app.releaseFreeze()
  assert.equal(app.state.regularsSinceDebut, beforeCounter, 'reordenar não conta conclusão')
})

test('H: bloco e pins soberanos; liberação devolve os turnos ao Round Robin', async () => {
  for (const protection of ['freeze', 'pins']) {
    const { app } = await memory(seed(['1', '1', '1', '2', '3'], {
      currentTurnId: '1-0',
      frozenTurnIds: protection === 'freeze' ? ['1-1', '1-2'] : [],
      fixedTurnPositions: protection === 'pins' ? { '1-1': 1, '1-2': 2 } : {}
    }))
    assert.deepEqual(tables(app).slice(0, 3), ['1', '1', '1'])
    const fixed = structuredClone(app.state.fixedTurnPositions)
    const frozen = [...app.state.frozenTurnIds]
    await add(app, '4')
    assert.deepEqual(app.state.fixedTurnPositions, fixed)
    assert.deepEqual(app.state.frozenTurnIds, frozen)
    assert.deepEqual(tables(app).slice(0, 3), ['1', '1', '1'])
    if (protection === 'freeze') (await app.releaseFreeze())
    else { (await app.unpin('1-1')); (await app.unpin('1-2')) }
    assert.deepEqual(tables(app).slice(0, 4), ['1', '2', '3', '4'])
  }
})

test('slots efetivos de pins não mudam quando sobrepostos por congelamento', async () => {
  for (let sample = 0; sample < 50; sample++) {
    const { app } = await memory(seed(Array.from({ length: 15 }, (_, i) => String(1 + (i * i + sample) % 4)), {
      queueOrderPolicyVersion: 2, currentTurnId: `${1 + sample % 4}-0`
    }))
    const pending = app.getPlayOrder().filter(entry => entry.id !== app.state.currentTurnId)
    await app.moveTurn(pending[7].id, 2)
    await app.moveTurn(pending[11].id, 6)
    await app.freezeThrough(app.getPlayOrder().filter(entry => entry.id !== app.state.currentTurnId)[3].id)
    const protectedIds = new Set([...app.state.frozenTurnIds, ...Object.keys(app.state.fixedTurnPositions), app.state.currentTurnId!])
    const before = ids(app)
    await add(app, '5')
    for (const id of protectedIds) assert.equal(ids(app).indexOf(id), before.indexOf(id), `slot de ${id}`)
    const saved = structuredClone(app.state)
    const restarted = await memory(saved as AppState)
    assert.deepEqual(ids(restarted.app), ids(app))
  }
})

test('I: SQLite recupera rodada parcial, fase, vez atual e decisões manuais exatamente', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-rr-sqlite-'))
  let database = createKaraokeDatabase(root)
  const repository = () => createStateRepository({
    async load() { return database.loadState() },
    async save(state) { database.saveState(state); return true }
  })
  try {
    let app = new KaraokeApplication(repository())
    await app.load()
    database.saveState({ ...structuredClone(app.state), ...seed(['1', '1', '1', '2', '2', '3', '3']) } as AppState)
    app = new KaraokeApplication(repository())
    await app.load()
    await app.ensureCurrentTurn()
    await app.markDone(app.state.currentTurnId!, NOW)
    await app.ensureCurrentTurn()
    assert.equal(app.state.queue.find(entry => entry.id === app.state.currentTurnId)!.table, '2')
    const pending = app.getPlayOrder().filter(entry => entry.id !== app.state.currentTurnId)
    await app.moveTurn(pending.at(-1)!.id, 2)
    await app.freezeThrough(app.getPlayOrder().filter(entry => entry.id !== app.state.currentTurnId)[1].id)
    await app.flush()
    const saved = structuredClone(app.state)
    const expected = ids(app)
    database.close()
    database = createKaraokeDatabase(root)
    app = new KaraokeApplication(repository())
    await app.load()
    assert.deepEqual(ids(app), expected)
    for (const key of ['currentTurnId', 'frozenTurnIds', 'fixedTurnPositions', 'regularsSinceDebut', 'currentTurnAutomatic'] as const)
      assert.deepEqual(app.state[key], saved[key])
    const raw = new DatabaseSync(path.join(root, 'karaoke.sqlite'), { readOnly: true })
    try {
      assert.deepEqual(raw.prepare("SELECT id FROM entries WHERE status = 'pending' ORDER BY queue_order").all().map(row => row.id),
        app.state.queue.map(entry => entry.id))
      assert.equal((raw.prepare('SELECT queue_order_policy_version FROM app_state').get() as any).queue_order_policy_version, 2)
    } finally { raw.close() }
    await app.releaseFreeze()
    for (const id of Object.keys(app.state.fixedTurnPositions)) (await app.unpin(id))
    const seen = new Set<string>()
    while (app.state.queue.length) {
      await app.ensureCurrentTurn()
      const id = app.state.currentTurnId!
      assert.equal(seen.has(id), false)
      seen.add(id)
      await app.markDone(id, NOW + seen.size)
    }
    assert.equal(seen.size, saved.queue.length)
    await app.flush()
  } finally {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
