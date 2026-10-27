import test from 'node:test'
import assert from 'node:assert/strict'
import { debutBalancedOrder, debutTurnIds, fairOrder, longWaitAlertEligibleIds, maxWaitMinutes, playOrder, queuePositionReason, queueTurnPositions, resolveCurrentTurn } from '../src/queue-rules'
import { completedTurnCountsByTable, normalizeSingerName, sessionHistory, sessionSingerSummaries, sessionSummary, sessionTableSummaries, sessionWasActiveOnLocalDate, tableActivitySummary, tableHistorySummary } from '../src/history-rules'

process.env.TZ = 'America/Sao_Paulo'

const now = 10_000_000
function entry(id: string, table: string, insertedAt: number, extra: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id, table, insertedAt, name: id, songNumber: '1', songNumber2: '',
    status: 'pending', sessionId: 's1', ...extra
  }
}
function sung(id: string, table: string, doneAt: number, sessionId = 's1'): QueueEntry {
  return entry(id, table, doneAt - 60_000, { status: 'done', doneAt, sessionId })
}

test('roda entre mesas e espalha solicitações da mesma mesa', () => {
  const queue = [entry('a1', '1', 1), entry('a2', '1', 2), entry('b1', '2', 3), entry('c1', '3', 4)]
  assert.deepEqual(fairOrder(queue, [], 's1', null, now).map(e => e.id), ['a1', 'b1', 'c1', 'a2'])
})

test('intercala dois turnos regulares para um turno de estreia', () => {
  const regular = Array.from({ length: 7 }, (_, index) => String(index + 1))
  const history = regular.map((table, index) => sung(`done-${table}`, table, now - (index + 1)))
  const queue = [
    ...regular.map((table, index) => entry(`regular-${table}`, table, index + 1)),
    ...['8', '9', '10'].map((table, index) => entry(`debut-${table}`, table, index + 8))
  ]
  assert.deepEqual(debutBalancedOrder(queue, history, 's1', '7', now).map(item => item.id), [
    'regular-1', 'regular-2', 'debut-8', 'regular-3', 'regular-4',
    'debut-9', 'regular-5', 'regular-6', 'debut-10', 'regular-7'
  ])
})

test('novas estreias progressivas entram em FIFO sem empurrar os turnos existentes', () => {
  const history = ['1', '2', '3'].map(table => sung(`done-${table}`, table, now - 1))
  const queue = ['1', '2', '3'].map((table, index) => entry(`regular-${table}`, table, index + 1))
  const originalRegularOrder = debutBalancedOrder(queue, history, 's1', '3', now).map(item => item.id)
  for (let index = 1; index <= 5; index++) {
    queue.push(entry(`debut-${index}`, String(index + 3), now + index))
    const order = debutBalancedOrder(queue, history, 's1', '3', now + index)
    assert.deepEqual(order.filter(item => item.id.startsWith('regular-')).map(item => item.id), originalRegularOrder)
    assert.deepEqual(order.filter(item => item.id.startsWith('debut-')).map(item => item.id),
      Array.from({ length: index }, (_, i) => `debut-${i + 1}`))
  }
  assert.deepEqual(debutBalancedOrder(queue, history, 's1', '3', now).map(item => item.id), [
    'regular-1', 'regular-2', 'debut-1', 'regular-3', 'debut-2',
    'debut-3', 'debut-4', 'debut-5'
  ])
})

test('sem grupo regular atende estreias pela ordem de chegada e sem lacunas', () => {
  const queue = Array.from({ length: 10 }, (_, index) => entry(`debut-${index + 1}`, String(index + 1), index + 1))
  assert.deepEqual(debutBalancedOrder(queue, [], 's1', null, now).map(item => item.id),
    queue.map(item => item.id))
})

test('sem estreias mantém exatamente o fairOrder regular', () => {
  const queue = ['1', '2', '3', '1', '4'].map((table, index) => entry(`turn-${index}`, table, index + 1))
  const history = ['1', '2', '3', '4'].map((table, index) => sung(`done-${table}`, table, now - index))
  assert.deepEqual(debutBalancedOrder(queue, history, 's1', '4', now).map(item => item.id),
    fairOrder(queue, history, 's1', '4', now).map(item => item.id))
})

test('uma mesa com vários pedidos recebe apenas um token e preserva a ordem das solicitações', () => {
  const history = ['1', '2', '3'].map(table => sung(`done-${table}`, table, now - 1))
  const queue = [
    entry('lala', '6', 1), entry('yas', '6', 2), entry('joao', '6', 3),
    entry('regular-1', '1', 4), entry('regular-2', '2', 5), entry('regular-3', '3', 6)
  ]
  const order = debutBalancedOrder(queue, history, 's1', '3', now).map(item => item.id)
  assert.equal(order.filter(id => ['lala', 'yas', 'joao'].includes(id)).length, 3)
  assert.ok(order.indexOf('lala') < order.indexOf('yas'))
  assert.ok(order.indexOf('yas') < order.indexOf('joao'))
  assert.ok(order.indexOf('lala') < order.indexOf('regular-3'), 'the debut turn is not followed immediately by another turn from its table when an alternative exists')
})

test('turnos atuais, congelados ou fixados reservam a única estreia da mesa', () => {
  const queue = [entry('first', '6', 1), entry('second', '6', 2), entry('other-debut', '7', 3), entry('regular', '1', 4)]
  const history = [sung('done-1', '1', now - 1)]
  const order = debutBalancedOrder(queue.filter(item => item.id !== 'first'), history, 's1', null,
    now, ['first'], queue).map(item => item.id)
  assert.deepEqual(order, ['second', 'regular', 'other-debut'],
    'the protected first request reserves the token; the second request remains regular')
})

test('metadados de motivo respeitam precedência atual, congelamento, fixação e política automática', () => {
  const queue = [entry('current', '1', 1), entry('frozen', '2', 2), entry('fixed', '3', 3),
    entry('debut', '4', 4), entry('regular', '5', 5)]
  const history = [sung('done-5', '5', now - 1)]
  const context = { order: queue, queue, history, sessionId: 's1', currentTurnId: 'current',
    frozen: ['frozen'], fixed: { fixed: 2 } }
  const reason = (id: string) => queuePositionReason(id, context.order, context.queue, context.history,
    context.sessionId, context.currentTurnId, context.frozen, context.fixed)
  assert.deepEqual(reason('current'), { kind: 'current', position: null })
  assert.deepEqual(reason('frozen'), { kind: 'frozen', position: 1 })
  assert.deepEqual(reason('fixed'), { kind: 'manual', position: 2 })
  assert.deepEqual(reason('debut'), { kind: 'debut', position: 3 })
  assert.deepEqual(reason('regular'), { kind: 'regular', position: 4 })
})

test('cancelamento não encerra estreia e a elegibilidade passa ao próximo pedido pendente', () => {
  const cancelled = entry('cancelled-first', '6', 1, { status: 'cancelled', cancelledAt: now })
  const next = entry('next-first', '6', 2)
  const regular = entry('regular', '1', 3)
  const history = [cancelled, sung('done-1', '1', now - 1)]
  assert.deepEqual(debutBalancedOrder([next, regular], history, 's1', null, now).map(item => item.id),
    ['regular', 'next-first'])
})

test('conclusões com mais de 90 minutos ainda encerram a condição de estreia', () => {
  const oldCompletion = sung('old-done', '6', now - 3 * 60 * 60_000)
  const queue = [entry('mesa-6', '6', 1), entry('mesa-7-new', '7', 2)]
  const order = debutBalancedOrder(queue, [oldCompletion], 's1', null, now)
  assert.deepEqual(order.map(item => item.id), ['mesa-6', 'mesa-7-new'])
})

test('simulação por eventos mantém turnos antigos progredindo com chegadas sucessivas', () => {
  let clock = now
  let history = ['1', '2', '3'].map((table, index) => sung(`old-done-${table}`, table, now - index))
  let queue = [
    entry('old-1a', '1', ++clock), entry('old-1b', '1', ++clock),
    entry('old-2a', '2', ++clock), entry('old-2b', '2', ++clock),
    entry('old-3a', '3', ++clock), entry('old-3b', '3', ++clock)
  ]
  let lastTable: string | null = '3'
  const oldIds = new Set(queue.map(item => item.id))
  const waitCounts = new Map([...oldIds].map(id => [id, 0]))
  const completedOld: string[] = []

  for (let turn = 0; turn < 45; turn++) {
    if (turn > 0 && turn % 2 === 0 && turn <= 30) {
      const table = String(10 + turn / 2)
      queue.push(entry(`new-${table}`, table, ++clock))
    }
    if (!queue.length) continue
    const order = debutBalancedOrder(queue, history, 's1', lastTable, clock)
    assert.ok(order.length)
    const selected = order[0]
    for (const pending of queue) {
      if (pending.id !== selected.id && oldIds.has(pending.id)) {
        waitCounts.set(pending.id, (waitCounts.get(pending.id) || 0) + 1)
      }
    }
    queue = queue.filter(item => item.id !== selected.id)
    history.unshift({ ...selected, status: 'done', doneAt: ++clock })
    lastTable = selected.table
    if (oldIds.has(selected.id)) completedOld.push(selected.id)
  }

  assert.deepEqual(new Set(completedOld), oldIds, 'all requests that were already waiting eventually complete')
  assert.ok(Math.max(...waitCounts.values()) < 15, 'successive arrivals do not keep old turns at the end indefinitely')
})

test('usa apresentações dos últimos 90 minutos e ignora as anteriores ao limite', () => {
  const queue = [entry('a', '1', 1), entry('b', '2', 2)]
  const atBoundary = sung('recent', '1', now - 90 * 60_000)
  const tooOld = sung('old', '1', now - 90 * 60_000 - 1)
  assert.equal(fairOrder(queue, [atBoundary], 's1', null, now)[0].id, 'b')
  assert.equal(fairOrder(queue, [tooOld], 's1', null, now)[0].id, 'a')
  assert.equal(fairOrder(queue, [sung('other-session', '1', now, 's2')], 's1', null, now)[0].id, 'a')
})

test('pins mantêm a ordem manual e nextTurnId fica à frente dos pins', () => {
  const queue = ['a', 'b', 'c', 'd'].map((id, i) => entry(id, id, i + 1))
  const result = playOrder(queue, [], 's1', ['c', 'b', 'missing'], 'd', now)
  assert.deepEqual(result.map(e => e.id), ['d', 'c', 'b', 'a'])
})

test('desempata por chegada e usa timestamp estritamente crescente para mesma mesa', () => {
  const queue = [entry('later', '1', 20), entry('earlier', '2', 10), entry('same-table-later', '1', 30)]
  assert.deepEqual(fairOrder(queue, [], 's1', null, now).map(e => e.id), ['earlier', 'later', 'same-table-later'])
})

test('mesa que chegou primeiro mantém a primeira oportunidade após espera longa sem histórico', () => {
  const current = entry('current', '99', now - 60 * 60_000 - 1)
  const firstTable = entry('mesa-1', '1', now - 60 * 60_000)
  const newTable = entry('mesa-2', '2', now)
  const order = playOrder([current, firstTable, newTable], [], 's1', [], null, now, ['current'])
  assert.deepEqual(order.filter(item => item.id !== current.id).map(item => item.id), ['mesa-1', 'mesa-2'])
})

test('ordem de chegada vence entre mesas sem apresentações concluídas', () => {
  const current = entry('current', '99', now - 5 * 60_000 - 1)
  const queue = [current, entry('mesa-1', '1', now - 5 * 60_000), entry('mesa-2', '2', now)]
  assert.deepEqual(playOrder(queue, [], 's1', [], null, now, ['current'])
    .filter(item => item.id !== current.id).map(item => item.id), ['mesa-1', 'mesa-2'])
})

test('mesas novas não ultrapassam a primeira entrada antiga quando todas têm round zero', () => {
  const current = entry('current', '99', now - 10 * 60_000 - 1)
  const queue = [current,
    entry('mesa-1', '1', now - 10 * 60_000),
    entry('mesa-2', '2', now - 5 * 60_000),
    entry('mesa-3', '3', now)]
  assert.deepEqual(playOrder(queue, [], 's1', [], null, now, ['current'])
    .filter(item => item.id !== current.id).map(item => item.id), ['mesa-1', 'mesa-2', 'mesa-3'])
})

test('rounds por entrada distribuem pedidos repetidos sem concluir apresentações', () => {
  const current = entry('current', '99', now - 60 * 60_000 - 1)
  const queue = [current,
    entry('mesa-1-primeira', '1', now - 60 * 60_000),
    entry('mesa-1-segunda', '1', now - 60 * 60_000 + 1),
    entry('mesa-1-terceira', '1', now - 60 * 60_000 + 2),
    entry('mesa-2-primeira', '2', now)]
  assert.deepEqual(playOrder(queue, [], 's1', [], null, now)
    .filter(item => item.id !== current.id).map(item => item.id), [
    'mesa-1-primeira', 'mesa-2-primeira', 'mesa-1-segunda', 'mesa-1-terceira'
  ])
})

test('um turno atual ainda não concluído conta como entrada anterior da mesma mesa', () => {
  const current = entry('mesa-1-atual', '1', now - 60 * 60_000)
  const queue = [current,
    entry('mesa-1-aguardando', '1', now - 60 * 60_000 + 1),
    entry('mesa-2-nova', '2', now)]
  assert.deepEqual(playOrder(queue, [], 's1', [], null, now, ['mesa-1-atual'])
    .filter(item => item.id !== current.id).map(item => item.id), ['mesa-1-aguardando', 'mesa-2-nova'])
})

test('insertedAt menor por relógio retrocedido pode fazer uma solicitação nova parecer mais antiga', () => {
  const current = entry('current', '99', now - 10)
  const older = entry('mesa-1-antiga', '1', now - 5)
  const newWithBackdatedClock = entry('mesa-2-nova', '2', now - 8)
  assert.deepEqual(playOrder([current, older, newWithBackdatedClock], [], 's1', [], null, now, ['current'])
    .filter(item => item.id !== current.id).map(item => item.id), ['mesa-2-nova', 'mesa-1-antiga'])
})

test('mesas sem histórico recente precedem uma mesa com apresentação concluída na janela', () => {
  const current = entry('current', '99', now - 60 * 60_000 - 1)
  const queue = [current,
    entry('mesa-1-sem-historico', '1', now - 60 * 60_000),
    entry('mesa-2-ja-cantou', '2', now - 45 * 60_000),
    entry('mesa-3-nova', '3', now)]
  const history = [sung('mesa-2-concluida', '2', now - 50 * 60_000)]
  assert.deepEqual(playOrder(queue, history, 's1', [], null, now, ['current'])
    .filter(item => item.id !== current.id).map(item => item.id), [
    'mesa-2-ja-cantou', 'mesa-1-sem-historico', 'mesa-3-nova'
  ])
})

test('preserva a apresentação atual apesar da ordem recomendada e troca referência inválida', () => {
  const queue = [entry('current', '1', 1), entry('recommended', '2', 2)]
  assert.deepEqual(resolveCurrentTurn(queue, [queue[1], queue[0]], 'current', null), {
    current: queue[0], currentTurnId: 'current', nextTurnId: null
  })
  assert.deepEqual(resolveCurrentTurn(queue, [queue[1]], 'removed', 'recommended'), {
    current: queue[1], currentTurnId: 'recommended', nextTurnId: null
  })
})

test('permite sequência da mesma mesa quando não há alternativa', () => {
  const queue = [entry('a', '1', 1), entry('b', '1', 2), entry('c', '1', 3)]
  assert.deepEqual(fairOrder(queue, [], 's1', '1', now).map(e => e.id), ['a', 'b', 'c'])
})

test('resolve conflitos de prioridade, IDs expirados e nextTurn repetido', () => {
  const queue = [entry('a', '1', 1), entry('b', '2', 2), entry('c', '3', 3)]
  const result = playOrder(queue, [], 's1', ['b', 'a', 'b', 'expired'], 'b', now)
  assert.deepEqual(result.map(e => e.id), ['b', 'a', 'c'])
})

test('posições contínuas seguem toda a ordem calculada após apresentação atual, pins e nextTurn', () => {
  const queue = [
    entry('current', '8', 1), entry('forced-next', '7', 2),
    entry('pin-2', '6', 3), entry('pin-3', '5', 4),
    entry('wait-4', '1', 5), entry('wait-5', '2', 6),
    entry('wait-6', '3', 7), entry('wait-7', '4', 8)
  ]
  const history = [
    sung('recent-4', '4', now - 10),
    sung('recent-3a', '3', now - 9), sung('recent-3b', '3', now - 8),
    sung('recent-2a', '2', now - 7), sung('recent-2b', '2', now - 6), sung('recent-2c', '2', now - 5),
    sung('recent-1a', '1', now - 4), sung('recent-1b', '1', now - 3),
    sung('recent-1c', '1', now - 2), sung('recent-1d', '1', now - 1)
  ]
  const order = playOrder(queue, history, 's1', ['pin-2', 'pin-3', 'forced-next'], 'forced-next', now,
    ['current', 'pin-2', 'pin-3'])
  const positions = queueTurnPositions(order, 'current')
  assert.deepEqual(positions.get('current'), { kind: 'current' })
  assert.deepEqual(positions.get('forced-next'), { kind: 'waiting', position: 1 })
  assert.deepEqual(positions.get('pin-2'), { kind: 'waiting', position: 2 })
  assert.deepEqual(positions.get('pin-3'), { kind: 'waiting', position: 3 })
  assert.deepEqual(positions.get('wait-7'), { kind: 'waiting', position: 4 })
  assert.deepEqual(positions.get('wait-4'), { kind: 'waiting', position: 7 },
    'when there are no debut candidates, positions follow the existing recent-turn rotation')
  assert.deepEqual(queueTurnPositions(order, null).get('current'), { kind: 'waiting', position: order.length })
  assert.equal(positions.size, order.length)
})

test('calcula limite mínimo de espera pelo número de mesas distintas', () => {
  assert.equal(maxWaitMinutes([]), 30)
  assert.equal(maxWaitMinutes([entry('a', '1', 1), entry('b', '1', 2)]), 30)
  assert.equal(maxWaitMinutes(['1', '2', '3', '4'].map((table, i) => entry(table, table, i))), 36)
})

test('alertas de espera ignoram a vez atual, as três primeiras posições e turnos congelados', () => {
  const order = ['current', 'a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => entry(id, String(index + 1), index))
  assert.deepEqual(longWaitAlertEligibleIds(order, 'current', []), ['d', 'e', 'f'])
  assert.deepEqual(longWaitAlertEligibleIds(order, 'current', ['d', 'e']), ['f'])
  assert.deepEqual(longWaitAlertEligibleIds(order, 'current', ['a', 'b', 'c', 'd']), ['e', 'f'],
    'dynamic turns after the frozen prefix remain eligible at their current positions')
  assert.deepEqual(longWaitAlertEligibleIds(order, 'current', [], id => id !== 'd'), ['e', 'f'],
    'a turn is not eligible when the real priority operation would leave it in the same position')
  assert.deepEqual(longWaitAlertEligibleIds(order, 'current', order.map(item => item.id)), [])
})

test('isola histórico por sessão e calcula resumo de mesa', () => {
  const entries = [
    sung('one', '7', now, 's1'),
    sung('two', '7', now + 60_000, 's1'),
    sung('other', '7', now + 120_000, 's2')
  ]
  const active = sessionHistory(entries, 's1')
  assert.equal(active.length, 2)
  const summary = tableHistorySummary(active)
  assert.equal(summary.totalSongs, 2)
  assert.deepEqual(summary.uniqueSingers, ['one', 'two'])
  assert.equal(summary.currentRound, 3)
  assert.equal(summary.durationMinutes, 2)
})

test('resumo da sessão conta músicas individuais concluídas e exclui cancelamentos e outras sessões', () => {
  const history = [
    sung('done-two-songs', '4', now, 's1'),
    sung('done-one-song', '8', now + 60_000, 's1'),
    entry('cancelled', '9', now, { status: 'cancelled', cancelledAt: now + 1 }),
    sung('another-session', '10', now, 's2')
  ]
  history[0].songNumber2 = '2'
  const summary = sessionSummary(history, { id: 's1', startedAt: now - 125 * 60_000, endedAt: null }, now)
  assert.deepEqual(summary, { sungSongs: 3, singers: 2, tables: 2, durationMinutes: 125 })
})

test('conta rodadas por apresentação concluída, não por música, e isola sessão', () => {
  const twoSongs = sung('two-songs', '4', now, 's1')
  twoSongs.songNumber2 = '2'
  const cancelled = entry('cancelled-turn', '4', now, { status: 'cancelled', cancelledAt: now + 1 })
  const otherSession = sung('other-session', '4', now + 2, 's2')
  assert.deepEqual([...completedTurnCountsByTable([twoSongs, cancelled, otherSession], 's1')], [['4', 1]])
})

test('badge de estreia é um único pedido pendente por mesa e transfere após cancelamento', () => {
  const first = entry('first', '6', 1)
  const second = entry('second', '6', 2)
  const cancelled = entry('cancelled', '7', 0, { status: 'cancelled', cancelledAt: now })
  const next = entry('next', '7', 3)
  const history = [cancelled, sung('done-8', '8', now - 1)]
  assert.deepEqual([...debutTurnIds([first, second, next], history, 's1')], ['first', 'next'])
})

test('identifica cantores por nome normalizado e mesa dentro da sessão', () => {
  const sameSinger = sung('same-singer-again', '1', now + 1)
  sameSinger.name = '  JOÃO   SILVA '
  const sameSingerFirst = sung('same-singer-first', '1', now)
  sameSingerFirst.name = 'João Silva'
  sameSingerFirst.songNumber2 = '2'
  const otherTable = sung('same-name-other-table', '3', now + 2)
  otherTable.name = 'joão silva'
  const maria = sung('maria', '1', now + 3)
  maria.name = 'Maria'
  const oldSession = sung('old-session-same-person', '1', now + 4, 's2')
  oldSession.name = 'João Silva'
  const cancelled = entry('cancelled-same-person', '1', now, {
    name: 'João Silva', status: 'cancelled', cancelledAt: now + 5
  })
  const pending = entry('pending-same-person', '1', now + 5, { name: 'João Silva' })
  const history = [sameSingerFirst, sameSinger, otherTable, maria, oldSession, cancelled, pending]
  const session = sessionSummary(history, { id: 's1', startedAt: now - 1, endedAt: null }, now)
  assert.equal(session.sungSongs, 5)
  assert.equal(session.singers, 3)
  assert.deepEqual(sessionSingerSummaries(history, 's1').map(singer => [singer.name, singer.table, singer.sungSongs]), [
    ['João Silva', '1', 3], ['joão silva', '3', 1], ['Maria', '1', 1]
  ])
  assert.equal(normalizeSingerName('  JOÃO   Silva  '), normalizeSingerName('João Silva'))
  assert.equal(sessionSingerSummaries(history, 's2').length, 1)
})

test('detalhes da mesa agrupam concluídas e pendentes por nome sem misturar sessões ou cancelamentos', () => {
  const completed = sung('same-id', '3', now)
  completed.name = 'João'
  completed.songNumber = '111'
  completed.songNumber2 = '222'
  const cancelled = entry('cancelled', '3', now, {
    name: 'João', status: 'cancelled', cancelledAt: now + 1
  })
  const otherSession = sung('other-session', '3', now, 's2')
  otherSession.name = 'Outro'
  const queue = [
    entry('same-id', '3', now, { name: 'João', songNumber: '111' }),
    entry('joao-pending', '3', now + 1, { name: '  JOÃO  ', songNumber: '333', songNumber2: '444' }),
    entry('joao-pending-again', '3', now + 2, { name: 'joão', songNumber: '777' }),
    entry('new-singer', '3', now + 2, { name: 'Maria', songNumber: '555', songNumber2: '666' }),
    entry('same-name-other-table', '7', now + 2, { name: 'joão' }),
    entry('other-table', '7', now + 3, { name: 'Outro' }),
    entry('other-session-pending', '3', now + 4, { name: 'Outro', sessionId: 's2' })
  ]
  const result = tableActivitySummary([completed, cancelled, otherSession], queue, 's1', '3')
  assert.equal(result.sungSongs, 2)
  assert.equal(result.pendingSongs, 5)
  assert.equal(result.singerCount, 2)
  assert.deepEqual(result.singers.map(singer => singer.name), ['João', 'Maria'])
  assert.equal(result.singers[0].sung.length, 1)
  assert.equal(result.singers[0].pending.length, 2)
  assert.equal(result.singers[1].sung.length, 0)
  assert.equal(result.singers[1].pending.length, 1)
  assert.equal(result.pendingEntries.some(entry => entry.id === 'same-id'), false)
  assert.equal(tableHistorySummary([]).durationMinutes, 0)
  assert.deepEqual(tableHistorySummary([completed, { ...completed, id: 'normalized-copy', name: '  JOÃO ' }]).uniqueSingers,
    ['João'])
})

test('lista mesas do histórico e da fila, incluindo mesas somente pendentes e ordenando numericamente', () => {
  const completed = sung('table-3', '3', now)
  completed.songNumber2 = '2'
  const cancelled = entry('table-7-cancelled', '7', now, { status: 'cancelled', cancelledAt: now + 1 })
  const summaries = sessionTableSummaries([completed, cancelled, sung('old-session', '1', now, 's2')], [
    entry('pending-table-2', '2', now, { songNumber2: 'two' }),
    entry('pending-table-10', '10', now + 1),
    entry('other-session', '1', now + 2, { sessionId: 's2' })
  ], 's1')
  assert.deepEqual(summaries, [
    { table: '2', sungSongs: 0, pendingSongs: 2 },
    { table: '3', sungSongs: 2, pendingSongs: 0 },
    { table: '7', sungSongs: 0, pendingSongs: 0 },
    { table: '10', sungSongs: 0, pendingSongs: 1 }
  ])
})

function localTimestamp(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime()
}
function testSession(id: string, startedAt: number, endedAt: number | null): KaraokeSession {
  return { id, startedAt, endedAt }
}
function sessionEntry(id: string, sessionId: string, insertedAt: number, extra: Partial<QueueEntry> = {}): QueueEntry {
  return entry(id, '1', insertedAt, { sessionId, ...extra })
}

test('filtro de sessões usa interseção local e cobre mesmo dia, madrugada e mais de 24 horas', () => {
  const sameDay = testSession('same', localTimestamp(2026, 10, 19, 19, 10), localTimestamp(2026, 10, 19, 23, 59))
  const overnight = testSession('overnight', localTimestamp(2026, 10, 19, 19, 10), localTimestamp(2026, 10, 20, 4, 25))
  const long = testSession('long', localTimestamp(2026, 10, 18, 21), localTimestamp(2026, 10, 21, 6))
  assert.equal(sessionWasActiveOnLocalDate(sameDay, [], '2026-10-19'), true)
  assert.equal(sessionWasActiveOnLocalDate(sameDay, [], '2026-10-20'), false)
  assert.equal(sessionWasActiveOnLocalDate(overnight, [], '2026-10-19'), true)
  assert.equal(sessionWasActiveOnLocalDate(overnight, [], '2026-10-20'), true)
  assert.equal(sessionWasActiveOnLocalDate(long, [], '2026-10-19'), true)
  assert.equal(sessionWasActiveOnLocalDate(long, [], '2026-10-20'), true)
})

test('filtro cobre virada de mês e ano, início exato do dia e encerramento exato à meia-noite', () => {
  const month = testSession('month', localTimestamp(2026, 1, 31, 22), localTimestamp(2026, 2, 1, 3))
  const year = testSession('year', localTimestamp(2025, 12, 31, 23), localTimestamp(2026, 1, 1, 2))
  const endsAtMidnight = testSession('end-boundary', localTimestamp(2026, 10, 19, 23), localTimestamp(2026, 10, 20))
  const startsAtMidnight = testSession('start-boundary', localTimestamp(2026, 10, 20), localTimestamp(2026, 10, 20, 1))
  assert.equal(sessionWasActiveOnLocalDate(month, [], '2026-01-31'), true)
  assert.equal(sessionWasActiveOnLocalDate(month, [], '2026-02-01'), true)
  assert.equal(sessionWasActiveOnLocalDate(year, [], '2025-12-31'), true)
  assert.equal(sessionWasActiveOnLocalDate(year, [], '2026-01-01'), true)
  assert.equal(sessionWasActiveOnLocalDate(endsAtMidnight, [], '2026-10-20'), false)
  assert.equal(sessionWasActiveOnLocalDate(startsAtMidnight, [], '2026-10-20'), true)
})

test('sessões sobrepostas são localizadas por qualquer dia ativo e continuam separadas por ID', () => {
  const a = testSession('a', localTimestamp(2026, 10, 19, 19), localTimestamp(2026, 10, 20, 4))
  const b = testSession('b', localTimestamp(2026, 10, 20, 19), localTimestamp(2026, 10, 21, 4))
  assert.equal(sessionWasActiveOnLocalDate(a, [], '2026-10-20'), true)
  assert.equal(sessionWasActiveOnLocalDate(b, [], '2026-10-20'), true)
  const doneA = sessionEntry('done-a', 'a', localTimestamp(2026, 10, 20, 1), { status: 'done', doneAt: localTimestamp(2026, 10, 20, 2), songNumber2: '2' })
  const doneB = sessionEntry('done-b', 'b', localTimestamp(2026, 10, 20, 20), { status: 'done', doneAt: localTimestamp(2026, 10, 20, 21) })
  assert.equal(sessionSummary([doneA, doneB], a).sungSongs, 2)
  assert.equal(sessionSummary([doneA, doneB], a).tables, 1)
})

test('sessão sem encerramento só corresponde à data de início e às datas comprovadas por atividade', () => {
  const session = testSession('legacy', localTimestamp(2026, 10, 19, 21), null)
  const done = sessionEntry('legacy-done', 'legacy', localTimestamp(2026, 10, 20, 1), { status: 'done', doneAt: localTimestamp(2026, 10, 20, 2) })
  const pending = sessionEntry('legacy-pending', 'legacy', localTimestamp(2026, 10, 21, 3))
  assert.equal(sessionWasActiveOnLocalDate(session, [], '2026-10-19'), true)
  assert.equal(sessionWasActiveOnLocalDate(session, [done], '2026-10-20'), true)
  assert.equal(sessionWasActiveOnLocalDate(session, [pending], '2026-10-21'), true)
  assert.equal(sessionWasActiveOnLocalDate(session, [done], '2026-10-22'), false)
  assert.equal(sessionWasActiveOnLocalDate(session, [], 'invalid'), false)
  assert.equal(sessionWasActiveOnLocalDate(session, [], '2026-02-30'), false)
})

test('estatísticas anteriores contam turnos, músicas e mesas sem cancelamentos ou outras sessões', () => {
  const session = testSession('stats', localTimestamp(2026, 10, 19, 18), localTimestamp(2026, 10, 20, 3))
  const records = [
    sessionEntry('two-songs', 'stats', localTimestamp(2026, 10, 19, 19), { status: 'done', doneAt: localTimestamp(2026, 10, 19, 20), songNumber2: '2' }),
    sessionEntry('one-song', 'stats', localTimestamp(2026, 10, 19, 21), { name: 'Maria', table: '2', status: 'done', doneAt: localTimestamp(2026, 10, 19, 22) }),
    sessionEntry('cancelled', 'stats', localTimestamp(2026, 10, 19, 23), { status: 'cancelled', cancelledAt: localTimestamp(2026, 10, 19, 23) }),
    sessionEntry('other-session', 'other', localTimestamp(2026, 10, 19, 23), { status: 'done', doneAt: localTimestamp(2026, 10, 19, 23) })
  ]
  const summary = sessionSummary(records, session)
  assert.deepEqual([summary.sungSongs, summary.singers, summary.tables], [3, 2, 2])
  assert.equal(sessionHistory(records, 'stats').length, 3)
})
