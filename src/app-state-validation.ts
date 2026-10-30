type StateRecord = Record<string, unknown>

const REQUIRED_STATE_FIELDS = [
  'queue', 'history', 'sessions', 'currentSessionId', 'priorityIds', 'fixedTurnPositions',
  'frozenTurnIds', 'queueOrderPolicyVersion', 'regularsSinceDebut', 'currentTurnAutomatic',
  'nextTurnId', 'currentTurnId', 'lastReset'
] as const

const OPTIONAL_STATE_FIELDS = ['trialStartedAt', 'licenseActivated'] as const

function isRecord(value: unknown): value is StateRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(path: string): never {
  throw new Error(`INVALID_APP_STATE_PAYLOAD: ${path}`)
}

function assertKeys(record: StateRecord, required: readonly string[], allowed: readonly string[], path: string): void {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) invalid(`${path}.${key} is required`)
  }
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) invalid(`${path} contains an unsupported field`)
  }
}

function assertString(value: unknown, path: string, identifier = false): asserts value is string {
  if (typeof value !== 'string' || (identifier && value.trim().length === 0)) invalid(`${path} must be a${identifier ? ' non-empty' : ''} string`)
}

function assertNullableString(value: unknown, path: string): asserts value is string | null {
  if (value !== null) assertString(value, path)
}

function assertNullableIdentifier(value: unknown, path: string): asserts value is string | null {
  if (value !== null) assertString(value, path, true)
}

function assertFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${path} must be a finite number`)
}

function assertTimestamp(value: unknown, path: string): asserts value is number | null {
  if (value !== null) assertFiniteNumber(value, path)
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`)
  for (let index = 0; index < value.length; index++) {
    assertString(value[index], `${path}[${index}]`, true)
  }
}

function validateSession(value: unknown, path: string): asserts value is KaraokeSession {
  if (!isRecord(value)) invalid(`${path} must be an object`)
  assertKeys(value, ['id', 'startedAt', 'endedAt'], ['id', 'startedAt', 'endedAt'], path)
  assertString(value.id, `${path}.id`, true)
  assertFiniteNumber(value.startedAt, `${path}.startedAt`)
  assertTimestamp(value.endedAt, `${path}.endedAt`)
}

function validateEntry(value: unknown, path: string, allowedStatuses: readonly EntryStatus[]): asserts value is QueueEntry {
  if (!isRecord(value)) invalid(`${path} must be an object`)
  const required = ['id', 'name', 'songNumber', 'songNumber2', 'table', 'insertedAt', 'status', 'sessionId']
  const allowed = [...required, 'doneAt', 'cancelledAt']
  assertKeys(value, required, allowed, path)
  assertString(value.id, `${path}.id`, true)
  assertString(value.name, `${path}.name`)
  assertString(value.songNumber, `${path}.songNumber`)
  assertString(value.songNumber2, `${path}.songNumber2`)
  assertString(value.table, `${path}.table`)
  assertFiniteNumber(value.insertedAt, `${path}.insertedAt`)
  if (typeof value.status !== 'string' || !allowedStatuses.includes(value.status as EntryStatus)) {
    invalid(`${path}.status is invalid`)
  }
  assertNullableString(value.sessionId, `${path}.sessionId`)
  for (const field of ['doneAt', 'cancelledAt'] as const) {
    if (Object.prototype.hasOwnProperty.call(value, field) && value[field] !== undefined) {
      assertFiniteNumber(value[field], `${path}.${field}`)
    }
  }
}

/** Validates the complete renderer-to-Main save contract without applying defaults. */
export function validateAppStatePayload(value: unknown): AppState {
  if (!isRecord(value)) invalid('payload must be an object')

  const allowedFields = [...REQUIRED_STATE_FIELDS, ...OPTIONAL_STATE_FIELDS]
  assertKeys(value, REQUIRED_STATE_FIELDS, allowedFields, 'payload')

  if (!Array.isArray(value.queue)) invalid('queue must be an array')
  if (!Array.isArray(value.history)) invalid('history must be an array')
  if (!Array.isArray(value.sessions)) invalid('sessions must be an array')
  for (let index = 0; index < value.queue.length; index++) {
    validateEntry(value.queue[index], `queue[${index}]`, ['pending'])
  }
  for (let index = 0; index < value.history.length; index++) {
    validateEntry(value.history[index], `history[${index}]`, ['pending', 'done', 'cancelled'])
  }
  for (let index = 0; index < value.sessions.length; index++) {
    validateSession(value.sessions[index], `sessions[${index}]`)
  }

  const entryIds = new Set<string>()
  for (const entry of [...value.queue, ...value.history] as QueueEntry[]) {
    if (entryIds.has(entry.id)) invalid('entry ids must be unique')
    entryIds.add(entry.id)
  }
  const sessionIds = new Set<string>()
  for (const session of value.sessions as KaraokeSession[]) {
    if (sessionIds.has(session.id)) invalid('session ids must be unique')
    sessionIds.add(session.id)
  }

  assertNullableIdentifier(value.currentSessionId, 'currentSessionId')
  assertStringArray(value.priorityIds, 'priorityIds')
  assertStringArray(value.frozenTurnIds, 'frozenTurnIds')
  if (!isRecord(value.fixedTurnPositions)) invalid('fixedTurnPositions must be an object')
  for (const [id, position] of Object.entries(value.fixedTurnPositions)) {
    assertString(id, 'fixedTurnPositions key', true)
    if (typeof position !== 'number' || !Number.isFinite(position) || !Number.isInteger(position) || position < 0) {
      invalid('fixedTurnPositions values must be non-negative integers')
    }
  }

  if (typeof value.queueOrderPolicyVersion !== 'number' || !Number.isSafeInteger(value.queueOrderPolicyVersion) ||
      value.queueOrderPolicyVersion < 0) invalid('queueOrderPolicyVersion must be a non-negative integer')
  if (typeof value.regularsSinceDebut !== 'number' || !Number.isInteger(value.regularsSinceDebut) ||
      value.regularsSinceDebut < 0 || value.regularsSinceDebut > 2) invalid('regularsSinceDebut must be an integer from 0 to 2')
  if (typeof value.currentTurnAutomatic !== 'boolean') invalid('currentTurnAutomatic must be a boolean')
  assertNullableIdentifier(value.nextTurnId, 'nextTurnId')
  assertNullableIdentifier(value.currentTurnId, 'currentTurnId')
  assertNullableString(value.lastReset, 'lastReset')

  if (Object.prototype.hasOwnProperty.call(value, 'trialStartedAt') && value.trialStartedAt !== undefined) {
    assertFiniteNumber(value.trialStartedAt, 'trialStartedAt')
  }
  if (Object.prototype.hasOwnProperty.call(value, 'licenseActivated') && value.licenseActivated !== undefined &&
      typeof value.licenseActivated !== 'boolean') invalid('licenseActivated must be a boolean')

  return value as unknown as AppState
}
