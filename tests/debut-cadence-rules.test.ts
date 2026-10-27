import test from 'node:test'
import assert from 'node:assert/strict'
import { insertNewDebutByCadence, restoreRegularOpportunitiesAfterCancellation } from '../src/debut-cadence-rules'

const ids = (...values: string[]) => values.map(id => ({ id }))

test('nova estreia entra na próxima vaga 2:1 sem passar estreias anteriores', () => {
  const order = ids('r1', 'r2', 'd1', 'r3', 'd2', 'r4', 'd3')
  const debutIds = new Set(['d1', 'd2', 'd3', 'new-debut'])
  assert.deepEqual(insertNewDebutByCadence([...order, { id: 'new-debut' }], 'new-debut', debutIds, 0)
    .map(entry => entry.id), ['r1', 'r2', 'd1', 'r3', 'd2', 'r4', 'd3', 'new-debut'])
})

test('chegadas contínuas de estreantes não agrupam pedidos nem empurram sempre os mesmos regulares', () => {
  const order = ids('r1', 'r2', 'd1', 'r3', 'r4', 'r5', 'r6', 'new-debut')
  const result = insertNewDebutByCadence(order, 'new-debut', new Set(['d1', 'new-debut']), 0)
  assert.deepEqual(result.map(entry => entry.id), ['r1', 'r2', 'd1', 'r3', 'r4', 'new-debut', 'r5', 'r6'])
})

test('pedidos adicionais da mesa estreante não são contados como vagas regulares', () => {
  const order = [
    { id: 'regular-1', table: '1' }, { id: 'debut-a', table: '2' },
    { id: 'same-table-2', table: '2' }, { id: 'same-table-3', table: '2' },
    { id: 'regular-2', table: '3' }, { id: 'new-debut', table: '4' }
  ]
  const result = insertNewDebutByCadence(order, 'new-debut', new Set(['debut-a', 'new-debut']), 0)
  assert.deepEqual(result.map(entry => entry.id), [
    'regular-1', 'debut-a', 'same-table-2', 'same-table-3', 'regular-2', 'new-debut'
  ])
})

test('pedidos da mesma mesa continuam fora da cadência quando o turno de estreia está protegido', () => {
  const order = [
    { id: 'protected-debut', table: 'A' },
    { id: 'same-table-second', table: 'A' },
    { id: 'regular', table: 'R' },
    { id: 'new-debut', table: 'B' }
  ]
  const result = insertNewDebutByCadence(order, 'new-debut',
    new Set(['protected-debut', 'new-debut']), 0, ['protected-debut'])
  assert.deepEqual(result.map(entry => entry.id), [
    'protected-debut', 'same-table-second', 'regular', 'new-debut'
  ])
})

test('cadência avançada antecipa a estreia somente após as vagas regulares restantes', () => {
  const order = ids('r1', 'r2', 'r3', 'r4', 'new-debut')
  const debutIds = new Set(['new-debut'])
  assert.deepEqual(insertNewDebutByCadence(order, 'new-debut', debutIds, 1).map(entry => entry.id),
    ['r1', 'new-debut', 'r2', 'r3', 'r4'])
  assert.deepEqual(insertNewDebutByCadence(order, 'new-debut', debutIds, 2).map(entry => entry.id),
    ['new-debut', 'r1', 'r2', 'r3', 'r4'])
})

test('pins e bloco congelado ficam em slots intactos durante inclusão de estreia', () => {
  const order = ids('current', 'frozen', 'pin', 'r1', 'r2', 'r3', 'new-debut')
  const protectedIds = ['current', 'frozen', 'pin']
  const result = insertNewDebutByCadence(order, 'new-debut', new Set(['new-debut']), 0, protectedIds)
  assert.deepEqual(result.map(entry => entry.id), ['current', 'frozen', 'pin', 'r1', 'r2', 'new-debut', 'r3'])
  assert.deepEqual(result.slice(0, 3).map(entry => entry.id), protectedIds)
})

test('cancelar regular não consome uma oportunidade e recompõe a vaga 2:1', () => {
  const order = ids('r2', 'd1', 'r3', 'd2')
  const result = restoreRegularOpportunitiesAfterCancellation(order, new Set(['d1', 'd2']), 0)
  assert.deepEqual(result.map(entry => entry.id), ['r2', 'r3', 'd1', 'd2'])
})

test('cancelar não move posições protegidas ao recompor oportunidades', () => {
  const order = ids('frozen', 'r2', 'd1', 'r3')
  const result = restoreRegularOpportunitiesAfterCancellation(order, new Set(['d1']), 0, ['frozen'])
  assert.deepEqual(result.map(entry => entry.id), ['frozen', 'r2', 'r3', 'd1'])
})
