import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KaraokeApplication } from '../src/application'
import { debutTurnIds, playOrder } from '../src/queue-rules'
import { createStateRepository } from '../src/state-repository'
import type { StateRepository } from '../src/state-repository'
import { createKaraokeDatabase } from '../database'
import { simulateCadenceReset } from './cadence-reset-simulation'

function memoryRepository(seed: StoredAppState = {}): { repository: StateRepository; writes: AppState[] } {
  const writes: AppState[] = []
  const repository = createStateRepository({
    async load() { return structuredClone(seed) },
    async save(state) { writes.push(structuredClone(state)); return true }
  })
  return { repository, writes }
}

function scheduledEntry(id: string, table: string, insertedAt: number, sessionId = 's1'): QueueEntry {
  return { id, name: id, songNumber: '1', songNumber2: '', table, insertedAt, status: 'pending', sessionId }
}

function completedEntry(id: string, table: string, insertedAt: number, doneAt: number, sessionId = 's1'): QueueEntry {
  return { ...scheduledEntry(id, table, insertedAt, sessionId), status: 'done', doneAt }
}

function cadenceSeed(queue: QueueEntry[], extra: StoredAppState = {}): StoredAppState {
  return { queue, history: ['1', '2', '3'].map((table, index) => completedEntry(`old-${table}`, table, 1, 2 + index)),
    sessions: [{ id: 's1', startedAt: 0, endedAt: null }], currentSessionId: 's1',
    queueOrderPolicyVersion: 2, regularsSinceDebut: 2, ...extra }
}

test('repara vínculo legado comprovado por controles ativos e conserva referências e ordem', async () => {
  const current = scheduledEntry('legacy-current', '8', 1, '')
  const frozen = scheduledEntry('legacy-frozen', '9', 2, '')
  const ambiguous = scheduledEntry('legacy-ambiguous', '10', 3, '')
  const seed: StoredAppState = {
    queue: [current, frozen, ambiguous], history: [],
    sessions: [{ id: 's1', startedAt: 0, endedAt: null }], currentSessionId: 's1',
    currentTurnId: current.id, frozenTurnIds: [frozen.id], fixedTurnPositions: { [frozen.id]: 1 },
    queueOrderPolicyVersion: 2, regularsSinceDebut: 1
  }
  const { repository, writes } = memoryRepository(seed)
  const app = new KaraokeApplication(repository)
  await app.load()

  assert.equal(app.state.queue.find(entry => entry.id === current.id)?.sessionId, 's1')
  assert.equal(app.state.queue.find(entry => entry.id === frozen.id)?.sessionId, 's1')
  assert.equal(app.state.queue.find(entry => entry.id === ambiguous.id)?.sessionId, '')
  assert.equal(app.state.currentTurnId, current.id)
  assert.deepEqual(app.state.frozenTurnIds, [frozen.id])
  assert.deepEqual(app.state.fixedTurnPositions, { [frozen.id]: 1 })
  assert.deepEqual(app.state.queue.map(entry => entry.id), [current.id, frozen.id, ambiguous.id])
  assert.equal(app.state.regularsSinceDebut, 1)
  assert.equal(debutTurnIds(app.state.queue, app.state.history, 's1').has(current.id), true)
  assert.equal(writes.length, 1, 'reparo e carregamento são confirmados em uma única gravação')

  const recovered = new KaraokeApplication(memoryRepository(writes[0]).repository)
  await recovered.load()
  assert.equal(recovered.state.queue.find(entry => entry.id === current.id)?.sessionId, 's1')
  assert.deepEqual(recovered.state.frozenTurnIds, [frozen.id])
})

test('associa toda fila legada somente quando ainda não há histórico de sessões', async () => {
  const pending = scheduledEntry('pre-sessions', '8', 1, '')
  const { repository, writes } = memoryRepository({ queue: [pending], history: [], sessions: [], currentSessionId: null })
  const app = new KaraokeApplication(repository)
  await app.load()
  assert.ok(app.state.currentSessionId)
  assert.equal(app.state.queue[0].sessionId, app.state.currentSessionId)
  assert.equal(writes[0].queue[0].sessionId, app.state.currentSessionId)
})

test('reset: RRERRERRE termina em zero; novos R1/R2/E1 mantêm ordem inclusive após recuperação', async () => {
  for (const restart of [false, true]) {
    const queue = ['1', '2', '10', '3', '1', '11', '2', '3', '12']
      .map((table, i) => scheduledEntry(`turn-${i}`, table, 100 + i))
    const { repository, writes } = memoryRepository(cadenceSeed(queue, { regularsSinceDebut: 0 }))
    let app = new KaraokeApplication(repository)
    await app.load()
    const executed: string[] = []
    for (let i = 0; i < 9; i++) {
      const before = app.getPlayOrder().map(entry => entry.id)
      const phase = app.state.regularsSinceDebut
      await app.ensureCurrentTurn()
      assert.equal(app.state.currentTurnId, before[0])
      assert.equal(app.state.regularsSinceDebut, phase)
      const id = app.state.currentTurnId!
      executed.push(debutTurnIds(app.state.queue, app.state.history, 's1').has(id) ? 'E' : 'R')
      await app.markDone(id, 1_000 + i)
    }
    assert.equal(executed.join(''), 'RRERRERRE')
    assert.equal(app.state.regularsSinceDebut, 0)
    await app.flush()
    assert.equal(writes.at(-1)!.regularsSinceDebut, 0, 'reset é salvo junto à conclusão')
    assert.equal(writes.at(-1)!.history[0].id, 'turn-8')
    if (restart) {
      app = new KaraokeApplication(memoryRepository(writes.at(-1)!).repository)
      await app.load()
      assert.equal(app.state.regularsSinceDebut, 0)
    }
    for (const [name, table] of [['R1', '1'], ['R2', '2'], ['E1', '13']])
      await app.addEntry({ name, table, songNumber: '1', songNumber2: '' })
    assert.deepEqual(app.getPlayOrder().map(entry => entry.name), ['R1', 'R2', 'E1'])
    assert.equal(app.state.queueOrderPolicyVersion, 2)
  }
})

test('reset: estreia automática zera com regulares, somente estreias ou fila vazia', async () => {
  for (const remainingTable of ['1', '11', null]) {
    const queue = [scheduledEntry('debut', '10', 10)]
    if (remainingTable) queue.push(scheduledEntry('remaining', remainingTable, 11))
    const app = new KaraokeApplication(memoryRepository(cadenceSeed(queue)).repository)
    await app.load()
    await app.ensureCurrentTurn()
    assert.equal(app.state.regularsSinceDebut, 2)
    assert.equal(app.state.currentTurnAutomatic, true)
    await app.markDone('debut', 100)
    assert.equal(app.state.regularsSinceDebut, 0, `grupo restante: ${remainingTable}`)
  }
})

test('reset: incremento regular preserva disponibilidade de estreia automática e teto de dois', async () => {
  for (const phase of [0, 1, 2]) for (const availability of ['none', 'automatic', 'frozen', 'pinned']) {
    const queue = [scheduledEntry('regular', '1', 10)]
    if (availability !== 'none') queue.push(scheduledEntry('debut', '10', 11))
    const app = new KaraokeApplication(memoryRepository(cadenceSeed(queue, {
      currentTurnId: 'regular', currentTurnAutomatic: true, regularsSinceDebut: phase,
      frozenTurnIds: availability === 'frozen' ? ['debut'] : [],
      fixedTurnPositions: availability === 'pinned' ? { debut: 1 } : {}
    })).repository)
    await app.load()
    await app.markDone('regular', 100)
    assert.equal(app.state.regularsSinceDebut, availability === 'automatic' ? Math.min(2, phase + 1) : phase)
  }
})

test('reset: origem congelada, fixada ou promovida manualmente não consome cadência', async () => {
  for (const origin of ['frozen', 'pinned', 'promoted', 'automatic', 'non-current']) {
    const app = new KaraokeApplication(memoryRepository(cadenceSeed([
      scheduledEntry('regular', '1', 10), scheduledEntry('debut', '10', 11)
    ])).repository)
    await app.load()
    if (origin === 'frozen') (await app.freezeThrough('debut'))
    if (origin === 'pinned') (await app.moveTurn('debut', 1))
    await app.ensureCurrentTurn()
    if (origin === 'promoted') (await app.promoteToCurrent('debut'))
    else if (origin === 'frozen' || origin === 'automatic') {
      await app.markDone('regular', 100)
      await app.ensureCurrentTurn()
    }
    assert.equal(app.state.regularsSinceDebut, 2)
    if (origin !== 'non-current') assert.equal(app.state.currentTurnId, 'debut')
    await app.markDone('debut', 101)
    assert.equal(app.state.regularsSinceDebut, origin === 'automatic' ? 0 : 2, origin)
  }
})

test('reset: cancelar estreia transfere token sem reset ou consumo por movimento', async () => {
  for (const currentTurnId of ['regular', 'first']) {
    const app = new KaraokeApplication(memoryRepository(cadenceSeed([
      scheduledEntry('regular', '1', 10), scheduledEntry('first', '10', 11),
      scheduledEntry('second', '10', 12), scheduledEntry('other', '11', 13)
    ], { currentTurnId, currentTurnAutomatic: true })).repository)
    await app.load()
    await app.cancelEntry('first', 100)
    assert.equal(app.state.regularsSinceDebut, 2)
    assert.deepEqual([...debutTurnIds(app.state.queue, app.state.history, 's1')], ['second', 'other'])
    assert.deepEqual(app.getPlayOrder().filter(entry => entry.id !== 'regular').map(entry => entry.id), ['second', 'other'])
    await app.moveTurn('other', 1)
    await app.unpin('other')
    assert.equal(app.state.regularsSinceDebut, 2)
    assert.equal(app.state.history[0].status, 'cancelled')
  }
})

test('reset: 128 eventos com grupos vazios, cancelamentos, proteções e reinícios não retêm fases antigas', async () => {
  const result = await simulateCadenceReset()
  assert.equal(result.events, 128)
  assert.equal(result.completions, 48)
  assert.equal(result.cancellations, 8)
  assert.equal(result.restarts, 8)
  assert.equal(result.protectedCompletions, 8)
  assert.equal(result.staleAutomaticDebutResets, 0)
  assert.equal(result.avoidableRepeats, 0)
  assert.equal(result.existingOrderInversions, 0)
  assert.deepEqual(result.cycleEndPhases, Array(8).fill(0))
  assert.equal(result.finalPhase, 0)
})

test('application owns entry actions, individual pins, promotion and session transitions', async () => {
  const { repository, writes } = memoryRepository()
  const app = new KaraokeApplication(repository)
  await app.load()
  const firstSession = app.state.currentSessionId
  assert.ok(firstSession)

  const first = (await app.addEntry({ name: 'Ana', songNumber: '1', songNumber2: '', table: '1' }))
  const second = (await app.addEntry({ name: 'Bia', songNumber: '2', songNumber2: '', table: '2' }))
  const third = (await app.addEntry({ name: 'Caio', songNumber: '3', songNumber2: '', table: '3' }))
  await app.ensureCurrentTurn()
  assert.equal(app.state.currentTurnId, first.id)

  assert.equal((await app.editEntry(second.id, { name: 'Bia editada', songNumber: '22', songNumber2: '23', table: '2' })), true)
  assert.equal((await app.moveTurn(third.id, 1)), true)
  assert.deepEqual(app.state.fixedTurnPositions, { [third.id]: 1 })
  assert.deepEqual(app.getPlayOrder().filter(entry => entry.id !== first.id).map(entry => entry.id), [third.id, second.id])
  assert.equal(app.canMoveTurn(third.id, 1), false, 'the already first turn cannot be advanced again')
  assert.equal(app.canMoveTurn(second.id, 1), true, 'a later turn can advance into the first slot, shifting the existing pin')
  assert.deepEqual(app.state.fixedTurnPositions, { [third.id]: 1 }, 'checking a possible move is read-only')

  assert.equal((await app.promoteToCurrent(third.id)), true)
  assert.equal(app.state.currentTurnId, third.id)
  assert.equal(app.state.nextTurnId, null)
  assert.deepEqual(app.state.fixedTurnPositions, { [third.id]: 0, [first.id]: 1 })
  await app.markDone(third.id, 500)
  await app.ensureCurrentTurn()
  assert.equal(app.state.currentTurnId, first.id)
  assert.equal(app.state.nextTurnId, null)
  assert.deepEqual(app.state.fixedTurnPositions, { [first.id]: 0 })
  assert.equal(app.state.history[0].status, 'done')

  const cancelled = (await app.cancelEntry(first.id, 600))
  assert.equal(cancelled?.status, 'cancelled')
  await app.ensureCurrentTurn()
  assert.equal(app.state.currentTurnId, second.id)
  assert.deepEqual(app.state.fixedTurnPositions, {})
  assert.equal(app.state.history[0].cancelledAt, 600)
  assert.equal(app.state.queue[0].name, 'Bia editada')

  await app.resetTableHistory('1')
  assert.equal(app.state.history.some(entry => entry.table === '1'), false)
  await app.startNewSession()
  assert.equal(app.state.sessions.length, 2)
  assert.equal(app.state.sessions[0].endedAt !== null, true)
  assert.notEqual(app.state.currentSessionId, firstSession)
  assert.deepEqual(app.state.queue, [])
  assert.deepEqual(app.state.fixedTurnPositions, {}, 'a new session clears the previous session\'s fixed turns')
  assert.equal(app.state.history.length, 2, 'the pending turn remains archived in its original session')
  assert.equal(app.state.history.some(entry => entry.id === second.id && entry.status === 'pending' && entry.sessionId === firstSession), true)

  await app.flush()
  assert.ok(writes.length >= 10)
})

test('repository snapshots and serializes writes in invocation order', async () => {
  const started: AppState[] = []
  const releases: Array<(result: boolean) => void> = []
  const repository = createStateRepository({
    async load() { return {} },
    save(state) {
      started.push(structuredClone(state))
      return new Promise(resolve => releases.push(resolve))
    }
  })
  const first: AppState = {
    queue: [], history: [], sessions: [], currentSessionId: 'one', priorityIds: [], fixedTurnPositions: {}, frozenTurnIds: [],
    queueOrderPolicyVersion: 1, regularsSinceDebut: 0, currentTurnAutomatic: false,
    nextTurnId: null, currentTurnId: null, lastReset: null, trialStartedAt: 1, licenseActivated: false
  }
  const second = structuredClone(first)
  second.currentSessionId = 'two'

  const firstWrite = repository.save(first)
  const secondWrite = repository.save(second)
  first.currentSessionId = 'mutated-after-save'

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started.map(state => state.currentSessionId), ['one'])
  releases[0](true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started.map(state => state.currentSessionId), ['one', 'two'])
  releases[1](true)
  await Promise.all([firstWrite, secondWrite])
  await repository.flush()
})

test('recupera ordem de estreia e lastInsertedAt ao reiniciar', async () => {
  const recent = Date.now()
  const queue = [
    { id: 'current', name: 'Current', table: '1', insertedAt: recent + 1000, songNumber: '1', songNumber2: '', status: 'pending' as const, sessionId: 's1' },
    { id: 'older-waiting', name: 'Older', table: '2', insertedAt: recent + 1001, songNumber: '2', songNumber2: '', status: 'pending' as const, sessionId: 's1' },
    { id: 'new-table', name: 'New', table: '3', insertedAt: recent + 1002, songNumber: '3', songNumber2: '', status: 'pending' as const, sessionId: 's1' }
  ]
  const completed = { id: 'old-done', name: 'Sung', table: '2', insertedAt: recent - 200_000,
    doneAt: recent - 100_000, songNumber: '4', songNumber2: '', status: 'done' as const, sessionId: 's1' }
  const seed: StoredAppState = {
    queue, history: [completed], sessions: [{ id: 's1', startedAt: recent - 300_000, endedAt: null }],
    currentSessionId: 's1', currentTurnId: 'current', priorityIds: [], nextTurnId: null
  }
  const first = new KaraokeApplication(memoryRepository(seed).repository)
  await first.load()
  const firstOrder = first.getPlayOrder().map(item => item.id)

  const recovered = new KaraokeApplication(memoryRepository(seed).repository)
  await recovered.load()
  assert.deepEqual(recovered.getPlayOrder().map(item => item.id), firstOrder,
    'the same session state yields the same order after recovery')
  const added = (await recovered.addEntry({ name: 'After restart', songNumber: '5', songNumber2: '', table: '4' }))
  assert.ok(added.insertedAt > Math.max(...queue.map(item => item.insertedAt), completed.insertedAt),
    'new arrivals remain chronologically later if the OS clock is behind stored timestamps')
})

test('sessão ativa atravessando a meia-noite é recuperada sem encerramento ou limpeza automática', async () => {
  const old = new Date(2026, 9, 19, 23, 50).getTime()
  const state: StoredAppState = {
    queue: [scheduledEntry('overnight-current', '1', old + 60_000), scheduledEntry('overnight-next', '2', old + 120_000)],
    history: [], sessions: [{ id: 'overnight-session', startedAt: old, endedAt: null }],
    currentSessionId: 'overnight-session', currentTurnId: 'overnight-current',
    fixedTurnPositions: { 'overnight-next': 1 }, frozenTurnIds: [],
    queueOrderPolicyVersion: 1, regularsSinceDebut: 1, currentTurnAutomatic: true
  }
  const app = new KaraokeApplication(memoryRepository(state).repository)
  await app.load()
  await app.ensureCurrentTurn()
  assert.equal(app.state.sessions[0].endedAt, null)
  assert.deepEqual(app.state.queue.map(item => item.id), ['overnight-current', 'overnight-next'])
  assert.equal(app.state.currentTurnId, 'overnight-current')
  assert.deepEqual(app.state.fixedTurnPositions, { 'overnight-next': 1 })
  assert.equal(app.state.regularsSinceDebut, 1)
})

test('encerramento arquiva pendências e remove a fila ativa antes de persistir', async () => {
  const now = Date.now()
  const current = scheduledEntry('closing-current', '1', now - 2000, 'closing-session')
  const next = scheduledEntry('closing-next', '2', now - 1000, 'closing-session')
  const state: StoredAppState = {
    queue: [current, next], history: [completedEntry('older-done', '3', now - 5000, now - 4000, 'closing-session')],
    sessions: [{ id: 'closing-session', startedAt: now - 10_000, endedAt: null }],
    currentSessionId: 'closing-session', currentTurnId: current.id, fixedTurnPositions: { [next.id]: 1 },
    frozenTurnIds: [next.id], queueOrderPolicyVersion: 1, regularsSinceDebut: 2, currentTurnAutomatic: true
  }
  const { repository, writes } = memoryRepository(state)
  const app = new KaraokeApplication(repository)
  await app.load()
  assert.equal(await app.endCurrentSession(), true)
  assert.equal(app.state.sessions[0].endedAt != null, true)
  assert.deepEqual(app.state.queue, [])
  assert.deepEqual(app.state.fixedTurnPositions, {})
  assert.deepEqual(app.state.frozenTurnIds, [])
  assert.equal(app.state.history.filter(entry => entry.status === 'pending').length, 2)
  assert.ok(app.state.history.filter(entry => entry.status === 'pending')
    .every(entry => entry.sessionId === 'closing-session'))
  assert.equal(app.state.currentTurnId, null)
  assert.equal(app.state.regularsSinceDebut, 0)
  assert.equal(await app.endCurrentSession(), false, 'a repeated close must not end or archive twice')
  assert.deepEqual(writes.at(-1)?.queue, [])
})

test('reabre estado encerrado criando nova sessão vazia e arquiva fila antiga sem ressuscitá-la', async () => {
  const now = Date.now()
  const pending = scheduledEntry('stale-pending', '4', now - 1000, 'ended-session')
  let saved: StoredAppState = {
    queue: [pending], history: [completedEntry('ended-song', '2', now - 5000, now - 3000, 'ended-session')],
    sessions: [{ id: 'ended-session', startedAt: now - 20_000, endedAt: now - 500 }],
    currentSessionId: 'ended-session', currentTurnId: pending.id, fixedTurnPositions: { [pending.id]: 0 },
    frozenTurnIds: [pending.id], queueOrderPolicyVersion: 1, regularsSinceDebut: 2,
    currentTurnAutomatic: false
  }
  const repository: StateRepository = {
    async load() { return structuredClone(saved) },
    async save(state) { saved = structuredClone(state); return true },
    finishMigration() {}, async flush() {}
  }
  const app = new KaraokeApplication(repository)
  await app.load()
  assert.equal(app.didRecoverEndedSession, true)
  assert.equal(app.state.sessions.length, 2)
  assert.equal(app.state.sessions[0].endedAt, now - 500)
  assert.notEqual(app.state.currentSessionId, 'ended-session')
  assert.deepEqual(app.state.queue, [])
  assert.deepEqual(app.state.fixedTurnPositions, {})
  assert.deepEqual(app.state.frozenTurnIds, [])
  assert.equal(app.state.history.find(entry => entry.id === pending.id)?.status, 'pending')
  assert.equal(app.state.history.find(entry => entry.id === pending.id)?.sessionId, 'ended-session')

  const reopened = new KaraokeApplication(repository)
  await reopened.load()
  assert.equal(reopened.didRecoverEndedSession, false)
  assert.equal(reopened.state.currentSessionId, app.state.currentSessionId)
  assert.deepEqual(reopened.state.queue, [])
})

test('falha ao persistir encerramento restaura a sessão aberta e não limpa a fila', async () => {
  let saved: StoredAppState = {
    queue: [scheduledEntry('failure-pending', '1', 100, 'failure-session')], history: [],
    sessions: [{ id: 'failure-session', startedAt: 1, endedAt: null }], currentSessionId: 'failure-session',
    currentTurnId: 'failure-pending', queueOrderPolicyVersion: 1, fixedTurnPositions: {}, frozenTurnIds: []
  }
  let rejectWrites = false
  const repository: StateRepository = {
    async load() { return structuredClone(saved) },
    async save(state) {
      if (rejectWrites) throw new Error('SQLite indisponível')
      saved = structuredClone(state)
      return true
    },
    finishMigration() {}, async flush() {}
  }
  const app = new KaraokeApplication(repository)
  await app.load()
  const before = structuredClone(app.state)
  rejectWrites = true
  await assert.rejects(app.endCurrentSession(), /SQLite indisponível/)
  assert.deepEqual(app.state, before)
  assert.equal(saved.sessions?.[0].endedAt, null)
  assert.equal(saved.queue?.length, 1)
})

test('migrates legacy priorityIds and nextTurnId into stable individual positions', async () => {
  const current = { id: 'current', name: 'Current', table: '1', insertedAt: 1, songNumber: '1', songNumber2: '', status: 'pending' as const, sessionId: 's1' }
  const forced = { ...current, id: 'forced', name: 'Forced', table: '2', insertedAt: 2 }
  const pinA = { ...current, id: 'pin-a', name: 'Pin A', table: '3', insertedAt: 3 }
  const pinB = { ...current, id: 'pin-b', name: 'Pin B', table: '4', insertedAt: 4 }
  const automatic = { ...current, id: 'automatic', name: 'Automatic', table: '5', insertedAt: 5 }
  const { repository } = memoryRepository({
    queue: [current, forced, pinA, pinB, automatic], history: [],
    sessions: [{ id: 's1', startedAt: 1, endedAt: null }], currentSessionId: 's1',
    priorityIds: ['pin-a', 'pin-b'], nextTurnId: 'forced', currentTurnId: 'current'
  })
  const app = new KaraokeApplication(repository)
  await app.load()
  assert.deepEqual(app.state.priorityIds, [])
  assert.equal(app.state.nextTurnId, null)
  assert.deepEqual(app.state.fixedTurnPositions, { forced: 1, 'pin-a': 2, 'pin-b': 3 })
  assert.deepEqual(app.getPlayOrder().filter(entry => entry.id !== 'current').map(entry => entry.id),
    ['forced', 'pin-a', 'pin-b', 'automatic'])

  await app.markDone('current', 10)
  await app.ensureCurrentTurn()
  assert.equal(app.state.currentTurnId, 'forced')
  assert.deepEqual(app.state.fixedTurnPositions, { forced: 0, 'pin-a': 1, 'pin-b': 2 })
  await app.markDone('forced', 20)
  await app.ensureCurrentTurn()
  assert.equal(app.state.currentTurnId, 'pin-a')
  assert.deepEqual(app.state.fixedTurnPositions, { 'pin-a': 0, 'pin-b': 1 })
})

test('keeps fixed ranks on arrivals, removes completed/cancelled pins and releases manually', async () => {
  const { repository } = memoryRepository()
  const app = new KaraokeApplication(repository)
  await app.load()
  const a = (await app.addEntry({ name: 'A', songNumber: '1', songNumber2: '', table: '1' }))
  const b = (await app.addEntry({ name: 'B', songNumber: '2', songNumber2: '', table: '2' }))
  const c = (await app.addEntry({ name: 'C', songNumber: '3', songNumber2: '', table: '3' }))
  const d = (await app.addEntry({ name: 'D', songNumber: '4', songNumber2: '', table: '4' }))
  await app.ensureCurrentTurn()
  const pending = app.getPlayOrder().filter(entry => entry.id !== app.state.currentTurnId)
  const dPosition = pending.findIndex(entry => entry.id === d.id) + 1
  assert.ok(dPosition > 1)
  assert.equal((await app.moveTurn(d.id, 2)), true)
  assert.equal(app.state.fixedTurnPositions[d.id], 2)
  const extra = (await app.addEntry({ name: 'New table', songNumber: '5', songNumber2: '', table: '5' }))
  assert.equal(app.getPlayOrder().filter(entry => entry.id !== app.state.currentTurnId)[1].id, d.id)
  assert.ok(app.getPlayOrder().some(entry => entry.id === extra.id))

  const middle = app.getPlayOrder().filter(entry => entry.id !== app.state.currentTurnId)[0]
  assert.notEqual(middle.id, d.id)
  await app.cancelEntry(middle.id, 30)
  assert.equal(app.state.fixedTurnPositions[d.id], 1)
  await app.markDone(d.id, 40)
  assert.equal(app.state.fixedTurnPositions[d.id], undefined)

  const again = app.getPlayOrder().filter(entry => entry.id !== app.state.currentTurnId)
  if (again.length > 1) {
    assert.equal((await app.moveTurn(again[again.length - 1].id, 1)), true)
    const fixedId = again[again.length - 1].id
    await app.unpin(fixedId)
    assert.equal(app.state.fixedTurnPositions[fixedId], undefined)
    const expectedAutomatic = playOrder([...app.state.queue], [...app.state.history], app.state.currentSessionId, [], null)
      .filter(entry => entry.id !== app.state.currentTurnId).map(entry => entry.id)
    assert.deepEqual(app.getPlayOrder().filter(entry => entry.id !== app.state.currentTurnId).map(entry => entry.id),
      expectedAutomatic, 'released turns return to automatic rotation')
  }
  void b
  void c
})

test('freezes a stable prefix, consumes it as turns become current and releases independently of pins', async () => {
  const { repository } = memoryRepository()
  const app = new KaraokeApplication(repository)
  await app.load()
  const entries = await Promise.all(Array.from({ length: 7 }, async (_, index) => (await app.addEntry({
    name: `Singer ${index}`, songNumber: String(index + 1), songNumber2: '', table: String(index + 1)
  }))))
  await app.ensureCurrentTurn()
  const currentId = app.state.currentTurnId!
  const waiting = app.getPlayOrder().filter(entry => entry.id !== currentId)
  const pinId = waiting[waiting.length - 1].id
  assert.equal((await app.moveTurn(pinId, waiting.length - 1)), true)
  const pinnedPosition = app.state.fixedTurnPositions[pinId]
  const currentOrderBeforeFreeze = app.getPlayOrder().filter(entry => entry.id !== currentId)
  const insidePinId = currentOrderBeforeFreeze[2].id
  assert.equal((await app.moveTurn(insidePinId, 1)), true)
  const currentOrder = app.getPlayOrder().filter(entry => entry.id !== currentId)
  const frozenIds = currentOrder.slice(0, 3).map(entry => entry.id)

  assert.equal((await app.freezeThrough(frozenIds[2])), true)
  assert.deepEqual(app.state.frozenTurnIds, frozenIds)
  assert.equal(app.state.fixedTurnPositions[insidePinId], 1, 'an individual pin remains stored inside the frozen block')
  assert.equal(app.isTurnFrozen(frozenIds[1]), true)
  assert.equal((await app.moveTurn(frozenIds[1], 1)), false, 'a frozen turn cannot be manually moved')
  assert.equal((await app.moveTurn(currentOrder[3].id, 2)), false, 'dynamic turns cannot enter the protected prefix')
  assert.equal(app.canMoveTurn(currentOrder[3].id, frozenIds.length + 1), false,
    'the first dynamic turn cannot be advanced into its existing first available slot')
  assert.equal(app.canMoveTurn(currentOrder[4].id, frozenIds.length + 1), true,
    'a later dynamic turn can advance to the first slot after the frozen prefix')

  const arrival = (await app.addEntry({ name: 'New table', songNumber: '99', songNumber2: '', table: '99' }))
  assert.deepEqual(app.getPlayOrder().filter(entry => entry.id !== currentId).slice(0, 3).map(entry => entry.id), frozenIds)
  assert.equal(app.isTurnFrozen(arrival.id), false)

  await app.markDone(currentId, 100)
  await app.ensureCurrentTurn()
  assert.equal(app.state.currentTurnId, frozenIds[0])
  assert.equal(app.state.fixedTurnPositions[insidePinId], 0, 'the pin remains attached as its frozen turn becomes current')
  assert.deepEqual(app.state.frozenTurnIds, frozenIds.slice(1), 'the current turn is consumed from the protected block')
  await app.cancelEntry(frozenIds[1], 110)
  assert.deepEqual(app.state.frozenTurnIds, frozenIds.slice(2), 'canceling a protected turn removes only that ID')
  await app.markDone(frozenIds[0], 120)
  await app.ensureCurrentTurn()
  assert.deepEqual(app.state.frozenTurnIds, [], 'the block ends after its final turn becomes current')
  assert.equal(app.state.fixedTurnPositions[pinId], pinnedPosition - 3,
    'manual pins outside the block survive as the frozen turns advance and one frozen pending turn is canceled')

  const queueAfterCurrent = app.getPlayOrder().filter(entry => entry.id !== app.state.currentTurnId)
  const freezeTarget = queueAfterCurrent[1]
  assert.equal((await app.freezeThrough(freezeTarget.id)), true)
  assert.equal((await app.releaseFreeze()), true)
  assert.deepEqual(app.state.frozenTurnIds, [])
  assert.equal(app.state.fixedTurnPositions[pinId], pinnedPosition - 3, 'releasing a block never deletes individual pins')

  const beforeSessionChange = app.getPlayOrder().filter(entry => entry.id !== app.state.currentTurnId)
  assert.equal((await app.freezeThrough(beforeSessionChange[0].id)), true)
  await app.startNewSession()
  assert.deepEqual(app.state.frozenTurnIds, [], 'a new session starts without a frozen block')
  assert.equal(entries.length, 7)
})

test('freeze extension preserves the original block and keeps arrivals outside it', async () => {
  const { repository } = memoryRepository()
  const app = new KaraokeApplication(repository)
  await app.load()
  for (let index = 0; index < 12; index++) {
    await app.addEntry({ name: `Queue ${index}`, songNumber: String(index), songNumber2: '', table: String(index + 1) })
  }
  await app.ensureCurrentTurn()
  const currentId = app.state.currentTurnId
  const firstOrder = app.getPlayOrder().filter(entry => entry.id !== currentId)
  assert.equal((await app.freezeThrough(firstOrder[0].id)), true)
  const originalBlock = [...app.state.frozenTurnIds]
  await app.addEntry({ name: 'Arrival during freeze', songNumber: '99', songNumber2: '', table: '99' })
  const nextOrder = app.getPlayOrder().filter(entry => entry.id !== currentId)
  assert.equal(nextOrder[0].id, originalBlock[0])
  assert.equal((await app.freezeThrough(nextOrder[9].id)), true)
  assert.deepEqual(app.state.frozenTurnIds.slice(0, 1), originalBlock)
  assert.equal(app.state.frozenTurnIds.length, 10)
  assert.equal(app.state.frozenTurnIds.includes(app.state.queue.find(entry => entry.name === 'Arrival during freeze')!.id), false)
})

test('nova regular Duda não ultrapassa estreias já estabelecidas, com ou sem proteções', async () => {
  const now = Date.now()
  const queue = [
    scheduledEntry('frozen-3', '3', now - 8000),
    scheduledEntry('frozen-4', '4', now - 7000),
    scheduledEntry('frozen-5', '5', now - 6000),
    scheduledEntry('pin-7', '7', now - 5000),
    scheduledEntry('yas', '6', now - 4000),
    scheduledEntry('opa', '22', now - 3000),
    scheduledEntry('cristian', '18', now - 2000)
  ]
  const history = [
    completedEntry('mesa1-done-1', '1', now - 120_000, now - 60_000),
    completedEntry('mesa1-done-2', '1', now - 90_000, now - 40_000),
    completedEntry('mesa6-done', '6', now - 5_000_000, now - 4_000_000)
  ]
  const makeApp = async (protectedQueue: boolean) => {
    const state: StoredAppState = {
      queue: protectedQueue ? queue : queue.slice(4), history, sessions: [{ id: 's1', startedAt: now - 86_400_000, endedAt: null }],
      currentSessionId: 's1', currentTurnId: null, priorityIds: [], nextTurnId: null,
      fixedTurnPositions: protectedQueue ? { 'pin-7': 4 } : {},
      frozenTurnIds: protectedQueue ? ['frozen-3', 'frozen-4', 'frozen-5'] : [],
      queueOrderPolicyVersion: 1, regularsSinceDebut: 0, currentTurnAutomatic: false
    }
    const app = new KaraokeApplication(memoryRepository(state).repository)
    await app.load()
    return app
  }

  for (const protectedQueue of [true, false]) {
    const app = await makeApp(protectedQueue)
    const before = app.getPlayOrder().filter(item => item.id !== app.state.currentTurnId).map(item => item.id)
    assert.deepEqual(before.slice(protectedQueue ? 4 : 0), ['yas', 'opa', 'cristian'])
    const duda = (await app.addEntry({ name: 'Duda', songNumber: '11', songNumber2: '', table: '1' }))
    const after = app.getPlayOrder().filter(item => item.id !== app.state.currentTurnId).map(item => item.id)
    assert.deepEqual(after.slice(protectedQueue ? 4 : 0), ['yas', 'opa', 'cristian', duda.id])
  }
})

test('cancelar a estreia transfere a vaga ao próximo pedido da mesa sem criar outro token', async () => {
  const now = Date.now()
  const queue = [
    scheduledEntry('debut-a-1', 'A', now - 5000), scheduledEntry('regular-1', 'R1', now - 4000),
    scheduledEntry('debut-b-1', 'B', now - 3000), scheduledEntry('debut-a-2', 'A', now - 2000),
    scheduledEntry('debut-a-3', 'A', now - 1000)
  ]
  const app = new KaraokeApplication(memoryRepository({
    queue, history: [completedEntry('regular-history', 'R1', now - 9000, now - 8000)],
    sessions: [{ id: 's1', startedAt: now - 10_000, endedAt: null }],
    currentSessionId: 's1', queueOrderPolicyVersion: 1, regularsSinceDebut: 0
  }).repository)
  await app.load()
  assert.deepEqual([...debutTurnIds(app.state.queue, app.state.history, 's1')], ['debut-a-1', 'debut-b-1'])
  const before = app.getPlayOrder().map(entry => entry.id)
  await app.cancelEntry('debut-a-1', now)
  assert.deepEqual([...debutTurnIds(app.state.queue, app.state.history, 's1')].sort(), ['debut-a-2', 'debut-b-1'].sort())
  const after = app.getPlayOrder().map(entry => entry.id)
  assert.equal(after.indexOf('debut-a-2'), before.indexOf('debut-a-1'))
  assert.ok(after.indexOf('debut-a-2') < after.indexOf('debut-a-3'))
  assert.equal(debutTurnIds(app.state.queue, app.state.history, 's1').has('debut-a-3'), false)
})

test('2:1 segue a ordem de apresentações concluídas e não reinicia em consultas', async () => {
  const now = Date.now()
  const queue = [
    scheduledEntry('r1', '1', now - 6000), scheduledEntry('r2', '2', now - 5000),
    scheduledEntry('r3', '3', now - 4000), scheduledEntry('d1', '4', now - 3000),
    scheduledEntry('d2', '5', now - 2000), scheduledEntry('d3', '6', now - 1000)
  ]
  const history = ['1', '2', '3'].map((table, index) =>
    completedEntry(`old-${table}`, table, now - 8_000_000 + index, now - 7_000_000 + index))
  const app = new KaraokeApplication(memoryRepository({
    queue, history, sessions: [{ id: 's1', startedAt: now - 9_000_000, endedAt: null }],
    currentSessionId: 's1', queueOrderPolicyVersion: 0, regularsSinceDebut: 0
  }).repository)
  await app.load()
  assert.deepEqual(app.getPlayOrder().map(item => item.id), ['r1', 'r2', 'd1', 'r3', 'd2', 'd3'])

  const completedGroups: string[] = []
  for (let index = 0; index < 6; index++) {
    const before = app.getPlayOrder()
    const debutIds = debutTurnIds(app.state.queue, app.state.history, app.state.currentSessionId)
    await app.ensureCurrentTurn()
    const currentId = app.state.currentTurnId!
    completedGroups.push(debutIds.has(currentId) ? 'D' : 'R')
    assert.equal(app.state.currentTurnAutomatic, true)
    assert.equal(before[0].id, currentId)
    await app.markDone(currentId, now + index + 1)
    assert.deepEqual(app.getPlayOrder().map(item => item.id), before.filter(item => item.id !== currentId).map(item => item.id),
      'reading order after a completion cannot reconstruct and restart the cadence')
  }
  assert.deepEqual(completedGroups, ['R', 'R', 'D', 'R', 'D', 'D'])
  assert.equal(app.state.regularsSinceDebut, 0,
    'the final automatic debut closes the cycle even when no regular remains')
})

test('pins e congelamento não contam como oportunidades automáticas do ciclo', async () => {
  const now = Date.now()
  const queue = [scheduledEntry('debut', '2', now - 4), scheduledEntry('regular', '1', now - 3),
    scheduledEntry('regular-2', '3', now - 2)]
  const history = [completedEntry('done-1', '1', now - 5000, now - 4000)]
  const app = new KaraokeApplication(memoryRepository({
    queue, history, sessions: [{ id: 's1', startedAt: now - 6000, endedAt: null }], currentSessionId: 's1',
    fixedTurnPositions: { regular: 1 }, frozenTurnIds: ['debut'], queueOrderPolicyVersion: 1
  }).repository)
  await app.load()
  await app.ensureCurrentTurn()
  assert.equal(app.state.currentTurnId, 'debut')
  assert.equal(app.state.currentTurnAutomatic, false)
  await app.markDone('debut', now + 1)
  assert.equal(app.state.regularsSinceDebut, 0)
})

test('ordem e fase operacional são recuperadas sem reordenar o estado salvo', async () => {
  let saved: StoredAppState = {
    queue: [scheduledEntry('r1', '1', 1), scheduledEntry('d1', '2', 2), scheduledEntry('r2', '3', 3)],
    history: [], sessions: [{ id: 's1', startedAt: 0, endedAt: null }], currentSessionId: 's1',
    queueOrderPolicyVersion: 1, regularsSinceDebut: 2, currentTurnAutomatic: true,
    currentTurnId: 'r1', fixedTurnPositions: {}, frozenTurnIds: []
  }
  const repository: StateRepository = {
    async load() { return structuredClone(saved) },
    async save(state) { saved = structuredClone(state); return true },
    finishMigration() {}, async flush() {}
  }
  const first = new KaraokeApplication(repository)
  await first.load()
  const order = first.getPlayOrder().map(item => item.id)
  await first.flush()
  const recovered = new KaraokeApplication(repository)
  await recovered.load()
  assert.deepEqual(recovered.getPlayOrder().map(item => item.id), order)
  assert.equal(recovered.state.regularsSinceDebut, 2)
  assert.equal(recovered.state.currentTurnAutomatic, true)
  const added = (await recovered.addEntry({ name: 'new regular', songNumber: '9', songNumber2: '', table: '9' }))
  assert.deepEqual(recovered.getPlayOrder().map(item => item.id), [...order, added.id])
})

test('simulação contínua de 50 conclusões mantém estreias antigas progredindo', async () => {
  const now = Date.now()
  const queue = [
    scheduledEntry('regular-1', '1', now - 7000), scheduledEntry('regular-2', '2', now - 6000),
    scheduledEntry('regular-3', '3', now - 5000), scheduledEntry('debut-1', '11', now - 4000),
    scheduledEntry('debut-2', '12', now - 3000), scheduledEntry('debut-3', '13', now - 2000)
  ]
  const history = ['1', '2', '3'].map((table, index) =>
    completedEntry(`regular-history-${table}`, table, now - 20_000 + index, now - 10_000 + index))
  const app = new KaraokeApplication(memoryRepository({
    queue, history, sessions: [{ id: 's1', startedAt: now - 30_000, endedAt: null }],
    currentSessionId: 's1', queueOrderPolicyVersion: 0, regularsSinceDebut: 0
  }).repository)
  await app.load()
  const firstDebutIds = ['debut-1', 'debut-2', 'debut-3']
  const debutCompletionIndex = new Map<string, number>()
  let completions = 0

  for (let event = 0; event < 50; event++) {
    await app.addEntry({ name: `Regular arrival ${event}`, songNumber: '1', songNumber2: '', table: '1' })
    if (event % 2 === 0) {
      await app.addEntry({ name: `Debut arrival ${event}`, songNumber: '2', songNumber2: '', table: `new-${event}` })
    }

    if (event === 10 || event === 29) {
      const cancellable = app.state.queue.find(entry => entry.id !== app.state.currentTurnId &&
        entry.id !== 'debut-1' && entry.id !== 'debut-2' && entry.id !== 'debut-3')
      if (cancellable) (await app.cancelEntry(cancellable.id, now + event))
    }

    await app.ensureCurrentTurn()
    const currentId = app.state.currentTurnId
    assert.ok(currentId, `presentation ${event + 1} should be selected`)
    await app.markDone(currentId!, now + event + 100)
    completions++
    if (firstDebutIds.includes(currentId!)) debutCompletionIndex.set(currentId!, completions)
  }

  assert.equal(completions, 50)
  assert.equal(debutCompletionIndex.size, 3, 'the first waiting debuts all progress despite continuous arrivals')
  assert.ok(Math.max(...debutCompletionIndex.values()) <= 8,
    `initial debuts should not be indefinitely displaced: ${JSON.stringify([...debutCompletionIndex])}`)
  assert.deepEqual([...debutCompletionIndex.keys()], firstDebutIds,
    'the original debut opportunities retain their arrival order')
})

test('recupera pelo SQLite a ordem operacional após cadastro e reinício do controlador', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-operational-order-'))
  let database = createKaraokeDatabase(directory)
  const makeRepository = (): StateRepository => createStateRepository({
    async load() { return database.loadState() },
    async save(state) { database.saveState(state); return true }
  })
  const now = Date.now()
  const seed: AppState = {
    queue: [scheduledEntry('yas', '6', now - 3000), scheduledEntry('opa', '22', now - 2000),
      scheduledEntry('cristian', '18', now - 1000)],
    history: [completedEntry('mesa1-done', '1', now - 100_000, now - 50_000),
      completedEntry('mesa6-done', '6', now - 5_000_000, now - 4_000_000)],
    sessions: [{ id: 's1', startedAt: now - 86_400_000, endedAt: null }], currentSessionId: 's1',
    priorityIds: [], fixedTurnPositions: {}, frozenTurnIds: [], queueOrderPolicyVersion: 1,
    regularsSinceDebut: 1, currentTurnAutomatic: false, nextTurnId: null, currentTurnId: null,
    lastReset: null, trialStartedAt: now, licenseActivated: false
  }
  try {
    database.saveState(seed)
    let app = new KaraokeApplication(makeRepository())
    await app.load()
    const duda = (await app.addEntry({ name: 'Duda', songNumber: '7', songNumber2: '', table: '1' }))
    const expected = ['yas', 'opa', 'cristian', duda.id]
    assert.deepEqual(app.getPlayOrder().map(entry => entry.id), expected)
    await app.flush()
    database.close()
    database = createKaraokeDatabase(directory)

    app = new KaraokeApplication(makeRepository())
    await app.load()
    assert.deepEqual(app.getPlayOrder().map(entry => entry.id), expected)
    assert.equal(app.state.regularsSinceDebut, 1)
    assert.equal(app.state.queueOrderPolicyVersion, 2)
    await app.flush()

    const raw = new DatabaseSync(path.join(directory, 'karaoke.sqlite'), { readOnly: true })
    try {
      assert.deepEqual(raw.prepare('SELECT id FROM entries WHERE status = ? ORDER BY queue_order').all('pending')
        .map((row: any) => row.id), expected)
      const cadence = raw.prepare('SELECT regulars_since_debut FROM app_state WHERE singleton = 1').get() as any
      assert.equal(cadence.regulars_since_debut, 1)
    } finally { raw.close() }
  } finally {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
