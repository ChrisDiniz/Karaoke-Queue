import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFixedTurnPositions, consumeFirstQueuePosition, moveTurnAndFix, removeTurnFromFixedPositions } from '../src/fixed-turn-rules'

const rows = (...ids: string[]) => ids.map(id => ({ id }))

test('moves a turn up/down by one insertion and fixes only that turn', () => {
  const initial = rows('A', 'B', 'C', 'D', 'E')
  const up = moveTurnAndFix(initial, {}, 'E', 2)
  assert.ok(up)
  assert.deepEqual(up.order.map(row => row.id), ['A', 'E', 'B', 'C', 'D'])
  assert.deepEqual(up.fixedPositions, { E: 2 })

  const down = moveTurnAndFix(up.order, up.fixedPositions, 'E', 5)
  assert.ok(down)
  assert.deepEqual(down.order.map(row => row.id), ['A', 'B', 'C', 'D', 'E'])
  assert.deepEqual(down.fixedPositions, { E: 5 })
})

test('keeps multiple fixed turns distinct when moving across occupied positions', () => {
  const before = rows('A', 'B', 'C', 'D', 'E', 'F')
  const first = moveTurnAndFix(before, {}, 'B', 1)
  assert.ok(first)
  const second = moveTurnAndFix(first.order, first.fixedPositions, 'D', 3)
  assert.ok(second)
  const moveAcross = moveTurnAndFix(second.order, second.fixedPositions, 'F', 3)
  assert.ok(moveAcross)
  assert.deepEqual(moveAcross.order.map(row => row.id), ['B', 'A', 'F', 'D', 'C', 'E'])
  assert.deepEqual(moveAcross.fixedPositions, { B: 1, D: 4, F: 3 })
  assert.equal(new Set(Object.values(moveAcross.fixedPositions)).size, 3)
})

test('merges fixed turns into recalculated automatic order and preserves fixed rank on arrivals', () => {
  const baseOrder = rows('A', 'B', 'C', 'D', 'E', 'NEW')
  assert.deepEqual(applyFixedTurnPositions(baseOrder, null, { E: 2 }).map(row => row.id),
    ['A', 'E', 'B', 'C', 'D', 'NEW'])
  assert.deepEqual(applyFixedTurnPositions(rows('C', 'NEW', 'B', 'A', 'E'), null, { E: 2 }).map(row => row.id),
    ['C', 'E', 'NEW', 'B', 'A'], 'automatic entries may reorder while the fixed turn keeps its position')
})

test('removing a turn closes later fixed slots; consuming current advances all later pins', () => {
  const afterRemoval = removeTurnFromFixedPositions({ B: 2, D: 4, E: 5 }, 'A', 1)
  assert.deepEqual(afterRemoval, { B: 1, D: 3, E: 4 })
  assert.deepEqual(removeTurnFromFixedPositions(afterRemoval, 'B', 1), { D: 2, E: 3 })
  assert.deepEqual(consumeFirstQueuePosition({ D: 2, E: 3 }, 'C'), { D: 1, E: 2 })
})

test('rejects invalid/no-op movements and resolves duplicate legacy slots deterministically', () => {
  assert.equal(moveTurnAndFix(rows('A', 'B'), {}, 'A', 1), null)
  assert.equal(moveTurnAndFix(rows('A', 'B'), {}, 'missing', 1), null)
  assert.deepEqual(applyFixedTurnPositions(rows('A', 'B', 'C'), null, { C: 2, B: 2 }).map(row => row.id),
    ['A', 'B', 'C'])
})
