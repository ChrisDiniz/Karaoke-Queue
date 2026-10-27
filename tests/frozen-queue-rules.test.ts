import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFrozenQueueOrder, normalizeFrozenTurnIds } from '../src/frozen-queue-rules'

const turns = ['current', 'a', 'b', 'c', 'd', 'e'].map(id => ({ id }))

test('frozen IDs remain an ordered prefix ahead of individual pins', () => {
  const result = applyFrozenQueueOrder(turns, 'current', ['b', 'a'], { c: 1, e: 2 })
  assert.deepEqual(result.map(turn => turn.id), ['current', 'b', 'a', 'c', 'e', 'd'])
})

test('new turns stay outside the block and releasing it restores individual pins', () => {
  const withArrival = [...turns, { id: 'new' }]
  const frozen = applyFrozenQueueOrder(withArrival, 'current', ['a', 'b'], { d: 4 })
  assert.deepEqual(frozen.slice(1, 3).map(turn => turn.id), ['a', 'b'])
  const released = applyFrozenQueueOrder(withArrival, 'current', [], { d: 4 })
  assert.deepEqual(released.map(turn => turn.id), ['current', 'a', 'b', 'c', 'd', 'e', 'new'])
})

test('normalization retains order, removes duplicates, completed IDs and current ID', () => {
  assert.deepEqual(normalizeFrozenTurnIds(['b', 'a', 'b', 'current', 'missing'], turns, 'current'), ['b', 'a'])
})

test('a block of 1, 3 or 10 turns remains an exact prefix when new entries arrive', () => {
  const initial = Array.from({ length: 13 }, (_, index) => ({ id: `turn-${index}` }))
  for (const count of [1, 3, 10]) {
    const frozenIds = initial.slice(0, count).map(turn => turn.id)
    const order = applyFrozenQueueOrder([...initial, { id: `arrival-${count}` }], null, frozenIds, {})
    assert.deepEqual(order.slice(0, count).map(turn => turn.id), frozenIds)
    assert.equal(order.at(-1)?.id, `arrival-${count}`)
  }
})
