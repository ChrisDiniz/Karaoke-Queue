import test from 'node:test'
import assert from 'node:assert/strict'
import { roundRobinOrder } from '../src/round-robin-rules'

const entries = (tables: string[]) => tables.map((table, index) => ({ id: String(index), table }))
const order = (tables: string[], previous: string | null = null) =>
  roundRobinOrder(entries(tables), previous, new Set(), new Set()).map(entry => entry.table)

test('Round Robin distribui uma oportunidade por mesa, não apenas alternância adjacente', () => {
  assert.deepEqual(order(['1', '1', '2']), ['1', '2', '1'])
  assert.deepEqual(order(['1', '2', '1', '2', '3']), ['1', '2', '3', '1', '2'])
  assert.deepEqual(order(['1', '1', '1', '1', '1', '2', '2', '2', '3', '3']),
    ['1', '2', '3', '1', '2', '3', '1', '2', '1', '1'])
  assert.deepEqual(order(['1', '1', '1', '1', '1']), ['1', '1', '1', '1', '1'])
  assert.deepEqual(order(['1', '2', '3'], '1'), ['2', '3', '1'])
})

test('reparo é puro, idempotente e preserva ordem interna das mesas e slots protegidos', () => {
  for (let seed = 0; seed < 150; seed++) {
    const input = entries(Array.from({ length: 18 }, (_, i) => String((seed * 17 + i * i + i * seed) % 5)))
    const original = structuredClone(input)
    const protectedIds = new Set(input.filter((_, i) => (i + seed) % 7 === 0).map(entry => entry.id))
    const debuts = new Set(input.filter((entry, i) => input.findIndex(item => item.table === entry.table) === i && i % 2 === 0).map(entry => entry.id))
    const result = roundRobinOrder(input, String(seed % 5), debuts, protectedIds)
    assert.deepEqual(input, original)
    assert.deepEqual(roundRobinOrder(result, String(seed % 5), debuts, protectedIds), result)
    assert.deepEqual([...result.map(entry => entry.id)].sort(), input.map(entry => entry.id).sort())
    for (const id of protectedIds) assert.equal(result.findIndex(entry => entry.id === id), input.findIndex(entry => entry.id === id))
    for (const table of new Set(input.map(entry => entry.table))) {
      assert.deepEqual(result.filter(entry => entry.table === table), input.filter(entry => entry.table === table))
    }
    assert.deepEqual(result.filter(entry => debuts.has(entry.id)), input.filter(entry => debuts.has(entry.id)))
  }
})

test('estreias estabelecidas são barreiras para regulares posteriores; estreia pode evitar monopólio', () => {
  const input = entries(['6', '22', '18', '1'])
  assert.deepEqual(roundRobinOrder(input, null, new Set(['1', '2']), new Set()), input, 'Duda não passa Opa/Cristian')
  const repeated = entries(['1', '1', '2'])
  assert.deepEqual(roundRobinOrder(repeated, null, new Set(['0', '2']), new Set()).map(entry => entry.id), ['0', '2', '1'])
  const protectedDebut = entries(['1', '2', '1'])
  assert.deepEqual(roundRobinOrder(protectedDebut, '1', new Set(['0', '1']), new Set(['0'])), protectedDebut)
  const cadence = entries(['1', '2', '10', '3', '1', '11', '2', '3', '12'])
  assert.deepEqual(roundRobinOrder(cadence, null, new Set(['2', '5', '8']), new Set()), cadence,
    'contagem zero de uma estreia não esvazia as vagas regulares 2:1')
})
