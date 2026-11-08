import test from 'node:test'
import assert from 'node:assert/strict'
import { ManagementClient } from '../src/management-client'
import type { ManagementCommandRequest, ManagementRendererBridge, ManagementSnapshot } from '../src/management-contracts'

function state(count = 0) {
  return {
    queue: Array.from({ length: count }, (_, index) => ({ id: `id-${index}`, name: `Singer ${index}`, songNumber: '1',
      songNumber2: '', table: String(index), insertedAt: index, status: 'pending' as const, sessionId: 'session-1' })),
    history: [], sessions: [{ id: 'session-1', startedAt: 1, endedAt: null }], currentSessionId: 'session-1',
    priorityIds: [], fixedTurnPositions: {}, frozenTurnIds: [], queueOrderPolicyVersion: 2,
    regularsSinceDebut: 0, currentTurnAutomatic: false, nextTurnId: null, currentTurnId: null, lastReset: null
  }
}

const snapshot = (revision: number, count = 0, hostEpoch = 'epoch-1'): ManagementSnapshot => ({
  hostEpoch, revision, state: state(count), didRecoverEndedSession: false, didStartFreshSessionOnLoad: false,
  didImportLegacyStorage: false
})

function bridgeSetup() {
  let listener: ((value: ManagementSnapshot) => void) | undefined
  let current = snapshot(1)
  const requests: ManagementCommandRequest[] = []
  let committed = 0
  const bridge: ManagementRendererBridge = {
    initialize: async () => structuredClone(current),
    getSnapshot: async () => structuredClone(current),
    acknowledge: async () => undefined,
    onStateChanged(callback) { listener = callback; return () => { listener = undefined } },
    flush: async () => undefined,
    command: async request => {
      requests.push(structuredClone(request))
      if (committed === 0) {
        committed++
        current = snapshot(2, 1)
        listener?.(structuredClone(current))
        throw new Error('reply lost after confirmed write')
      }
      return { operationId: request.operationId, result: [{ id: 'id-0' }], snapshot: structuredClone(current) }
    }
  }
  return { bridge, requests, emit: (value: ManagementSnapshot) => listener?.(structuredClone(value)), setCurrent: (value: ManagementSnapshot) => { current = value } }
}

test('legacy localStorage keys are cleared only after Main confirms the imported commit', async () => {
  const values = { 'kshake_queue': '[legacy]', 'kshake_history': null, 'kshake_sessions': null,
    'kshake_current_session': null, 'kshake_priority': null, 'kshake_fixed_turn_positions': null,
    'kshake_frozen_turn_ids': null, 'kshake_current_turn': null, 'kshake_last_reset': null }
  let cleared = false
  const context = bridgeSetup()
  context.bridge.initialize = async () => ({ ...snapshot(1), didImportLegacyStorage: true })
  const client = new ManagementClient(context.bridge, {
    read: () => values,
    clearImported: imported => { assert.deepEqual(imported, values); cleared = true }
  })
  await client.connect()
  assert.equal(cleared, true)
})

test('subscribe-before-snapshot retains an update racing with the initial snapshot', async () => {
  const context = bridgeSetup()
  let resolveSnapshot!: (value: ManagementSnapshot) => void
  context.bridge.initialize = () => new Promise(resolve => { resolveSnapshot = resolve })
  const client = new ManagementClient(context.bridge)
  const connecting = client.connect()
  context.emit(snapshot(2, 2))
  resolveSnapshot(snapshot(1, 1))
  await connecting
  assert.equal(client.state.queue.length, 2)
  assert.equal(client.subscribe(() => {}).constructor, Function)
})

test('stale revisions and wrong-epoch events cannot roll back the confirmed projection', async () => {
  const context = bridgeSetup()
  const client = new ManagementClient(context.bridge)
  await client.connect()
  context.emit(snapshot(3, 3))
  context.emit(snapshot(2, 2))
  context.emit(snapshot(99, 0, 'old-epoch'))
  assert.equal(client.state.queue.length, 3)
  assert.throws(() => (client.state.queue as unknown as QueueEntry[]).push({} as QueueEntry), TypeError)
})

test('a lost reply reconciles confirmed state and reuses operation ID on explicit retry', async () => {
  const context = bridgeSetup()
  const client = new ManagementClient(context.bridge)
  await client.connect()
  const command = [{ name: 'New singer', songNumber: '123', songNumber2: '', table: '8' }]
  await assert.rejects(client.addEntries(command, true), /reply lost/)
  assert.equal(client.state.queue.length, 1)
  const result = await client.addEntries(command, true)
  assert.deepEqual(result, [{ id: 'id-0' }])
  assert.equal(context.requests.length, 2)
  assert.equal(context.requests[0].operationId, context.requests[1].operationId)
})
