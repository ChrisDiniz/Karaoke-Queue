import test from 'node:test'
import assert from 'node:assert/strict'
import { validateAppStatePayload } from '../src/app-state-validation'

function validState(): AppState {
  return {
    queue: [{
      id: 'pending-1', name: 'Singer', songNumber: '123', songNumber2: '', table: '1',
      insertedAt: 10, status: 'pending', sessionId: 'session-1'
    }],
    history: [{
      id: 'done-1', name: 'Former singer', songNumber: '456', songNumber2: '789', table: '2',
      insertedAt: 1, status: 'done', sessionId: 'session-1', doneAt: 20
    }],
    sessions: [{ id: 'session-1', startedAt: 1, endedAt: null }],
    currentSessionId: 'session-1',
    priorityIds: [],
    fixedTurnPositions: { 'pending-1': 1 },
    frozenTurnIds: ['pending-1'],
    queueOrderPolicyVersion: 2,
    regularsSinceDebut: 1,
    currentTurnAutomatic: true,
    nextTurnId: null,
    currentTurnId: 'pending-1',
    lastReset: null
  }
}

test('validates a complete app-state snapshot without changing its structure', () => {
  const state = validState()
  assert.deepEqual(validateAppStatePayload(state), state)
})

test('accepts an intentionally empty app-state snapshot', () => {
  const state: AppState = {
    queue: [], history: [], sessions: [], currentSessionId: null,
    priorityIds: [], fixedTurnPositions: {}, frozenTurnIds: [], queueOrderPolicyVersion: 2,
    regularsSinceDebut: 0, currentTurnAutomatic: false, nextTurnId: null, currentTurnId: null,
    lastReset: null
  }
  assert.deepEqual(validateAppStatePayload(state), state)
})

test('rejects every missing required top-level field', () => {
  const requiredFields: (keyof AppState)[] = [
    'queue', 'history', 'sessions', 'currentSessionId', 'priorityIds', 'fixedTurnPositions',
    'frozenTurnIds', 'queueOrderPolicyVersion', 'regularsSinceDebut', 'currentTurnAutomatic',
    'nextTurnId', 'currentTurnId', 'lastReset'
  ]
  for (const field of requiredFields) {
    const state = { ...validState() } as Record<string, unknown>
    delete state[field]
    assert.throws(() => validateAppStatePayload(state), /INVALID_APP_STATE_PAYLOAD/, `must reject missing ${field}`)
  }
})

test('rejects null, undefined, and array roots', () => {
  for (const payload of [null, undefined, []]) {
    assert.throws(() => validateAppStatePayload(payload))
  }
})

test('rejects incompatible top-level collection and scalar types', () => {
  const invalidSnapshots: unknown[] = [
    { ...validState(), queue: {} },
    { ...validState(), history: {} },
    { ...validState(), sessions: {} },
    { ...validState(), priorityIds: 'pending-1' },
    { ...validState(), fixedTurnPositions: [] },
    { ...validState(), frozenTurnIds: {} },
    { ...validState(), currentSessionId: 1 },
    { ...validState(), queueOrderPolicyVersion: '2' },
    { ...validState(), regularsSinceDebut: '1' },
    { ...validState(), currentTurnAutomatic: 1 },
    { ...validState(), nextTurnId: {} },
    { ...validState(), currentTurnId: [] },
    { ...validState(), lastReset: false }
  ]
  for (const payload of invalidSnapshots) assert.throws(() => validateAppStatePayload(payload))
})

test('rejects invalid nested entries, sessions, and fixed positions', () => {
  const state = validState()
  const sparseQueue = new Array(1)
  const sparseIds = new Array(1)
  const invalidSnapshots: unknown[] = [
    { ...state, queue: [{}] },
    { ...state, queue: sparseQueue },
    { ...state, priorityIds: sparseIds },
    { ...state, queue: [{ ...state.queue[0], status: 'done' }] },
    { ...state, history: [{ ...state.history[0], status: 'unknown' }] },
    { ...state, sessions: [{}] },
    { ...state, fixedTurnPositions: { 'pending-1': '1' } },
    { ...state, fixedTurnPositions: { 'pending-1': Number.NaN } }
  ]
  for (const payload of invalidSnapshots) assert.throws(() => validateAppStatePayload(payload))
})

test('rejects invalid entry and session identifiers or timestamps', () => {
  const state = validState()
  const invalidSnapshots: unknown[] = [
    { ...state, queue: [{ ...state.queue[0], id: '' }] },
    { ...state, queue: [{ ...state.queue[0], id: 7 }] },
    { ...state, queue: [{ ...state.queue[0], insertedAt: Number.NaN }] },
    { ...state, queue: [{ ...state.queue[0], insertedAt: Number.POSITIVE_INFINITY }] },
    { ...state, history: [{ ...state.history[0], doneAt: '20' }] },
    { ...state, sessions: [{ ...state.sessions[0], id: '' }] },
    { ...state, sessions: [{ ...state.sessions[0], startedAt: '1' }] },
    { ...state, sessions: [{ ...state.sessions[0], endedAt: Number.POSITIVE_INFINITY }] }
  ]
  for (const payload of invalidSnapshots) assert.throws(() => validateAppStatePayload(payload))
})

test('accepts supported optional deprecated licensing fields without trusting them as required state', () => {
  const state = { ...validState(), trialStartedAt: 100, licenseActivated: true }
  assert.deepEqual(validateAppStatePayload(state), state)
  const withoutDeprecatedFields = validState()
  assert.deepEqual(validateAppStatePayload(withoutDeprecatedFields), withoutDeprecatedFields)
})

