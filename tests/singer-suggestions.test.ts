import test from 'node:test'
import assert from 'node:assert/strict'
import { singerSuggestions } from '../src/singer-suggestions'

function entry(id: string, name: string, table: string, status: EntryStatus, sessionId: string,
  insertedAt: number, doneAt?: number): QueueEntry {
  return { id, name, table, status, sessionId, insertedAt, songNumber: '123', songNumber2: '',
    ...(doneAt === undefined ? {} : { doneAt }) }
}

test('suggestions match accent/case/space variations and deduplicate by normalized name plus table', () => {
  const queue = [
    entry('pending-1', '  JOAO   SILVA ', '5', 'pending', 'active', 50),
    entry('pending-2', 'joão silva', '5', 'pending', 'active', 60)
  ]
  const history = [entry('done-1', 'João Silva', '5', 'done', 'active', 10, 40)]
  const suggestions = singerSuggestions(queue, history, 'active', '05', 'jo', 6)
  assert.equal(suggestions.length, 1)
  assert.equal(suggestions[0].name, 'joão silva')
  assert.equal(suggestions[0].lastUsedAt, 60)
})

test('filters by the active table and excludes cancelled and previous-session singers', () => {
  const queue = [
    entry('same-active', 'João', '5', 'pending', 'active', 20),
    entry('other-table', 'Jorge', '6', 'pending', 'active', 30),
    entry('old-session', 'Joana', '5', 'pending', 'old', 100)
  ]
  const history = [
    entry('cancelled', 'Juliana', '5', 'cancelled', 'active', 200),
    entry('old-done', 'Joaquim', '5', 'done', 'old', 300, 400)
  ]
  assert.deepEqual(singerSuggestions(queue, history, 'active', '5', 'j').map(item => item.name), ['João'])
  assert.deepEqual(singerSuggestions(queue, history, 'active', '6', 'j').map(item => item.name), ['Jorge'])
})

test('includes pending and completed singers, ordered by most recent use and capped', () => {
  const queue = [entry('pending', 'Júlia', '2', 'pending', 'active', 40)]
  const history = [
    entry('done-old', 'João', '2', 'done', 'active', 5, 10),
    entry('done-new', 'José', '2', 'done', 'active', 20, 30),
    entry('done-mid', 'Jorge', '2', 'done', 'active', 15, 25)
  ]
  assert.deepEqual(singerSuggestions(queue, history, 'active', '2', 'j', 3).map(item => item.name),
    ['Júlia', 'José', 'Jorge'])
  assert.equal(singerSuggestions(queue, history, 'active', '2', 'j', 2).length, 2)
})

test('does not suggest without a valid table, session, or query', () => {
  const queue = [entry('pending', 'João', '1', 'pending', 'active', 1)]
  assert.deepEqual(singerSuggestions(queue, [], 'active', '', 'j'), [])
  assert.deepEqual(singerSuggestions(queue, [], 'active', '0', 'j'), [])
  assert.deepEqual(singerSuggestions(queue, [], null, '1', 'j'), [])
  assert.deepEqual(singerSuggestions(queue, [], 'active', '1', '   '), [])
})
