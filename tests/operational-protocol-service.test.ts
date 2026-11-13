import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { createKaraokeDatabase } from '../database'
import type { RemoteAuthorizationPort, RemoteTransportMessageContext } from '../src/remote-contracts'
import { ManagementRemoteOutbox } from '../src/management-remote-outbox'
import { OperationalProtocolService } from '../src/operational-protocol-service'
import { PlayerOperationalStore, type PlayerOperationalStoreOptions } from '../src/player-operational-store'
import type { OperationalMessage } from '../src/operational-protocol-contracts'
import { parseOperationalMessageObject } from '../src/operational-protocol-validation'

const valid = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/operational-v1/valid-messages.json'), 'utf8')) as OperationalMessage[]
const commandTemplate = valid.find((item): item is Extract<OperationalMessage, { kind: 'command' }> =>
  item.kind === 'command' && item.body.type === 'pause')!
const controllerId = commandTemplate.controllerId
const deviceId = commandTemplate.deviceId
const playerEpoch = 'player-epoch-test'

function temp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'kq-g33-')) }
function command(operationId: string, changes: Partial<Extract<OperationalMessage, { kind: 'command' }>['body']> = {}):
  Extract<OperationalMessage, { kind: 'command' }> {
  const message = structuredClone(commandTemplate)
  message.messageId = 'message-' + operationId
  message.body.operationId = operationId
  message.body.target.playerEpoch = playerEpoch
  message.body.target.controlEpoch = '3'
  Object.assign(message.body, changes)
  return message
}
function storeOptions(directory: string, extra: Partial<PlayerOperationalStoreOptions> = {}): PlayerOperationalStoreOptions {
  return { userDataDirectory: directory, journalId: 'journal-' + deviceId, deviceId, initializeIfMissing: true, ...extra }
}
function authorization(check: (count: number) => boolean = () => true): RemoteAuthorizationPort {
  let count = 0
  return { async authorizeBearer() { return null }, async isCurrent() { return check(++count) } }
}
type TestContext = RemoteTransportMessageContext & { out: OperationalMessage[]; closed: unknown[];
  waitForMessage(predicate: (message: OperationalMessage) => boolean): Promise<OperationalMessage> }
function context(id: string, auth: RemoteAuthorizationPort = authorization()): TestContext {
  const out: OperationalMessage[] = []
  const closed: unknown[] = []
  const waiters = new Set<{ predicate: (message: OperationalMessage) => boolean; resolve: (message: OperationalMessage) => void }>()
  const peer = { controllerId, credentialGeneration: 3, scopes: ['transport:control'] }
  const channel = { connectionId: id, peer, signal: new AbortController().signal,
    send(value: string | Uint8Array) {
      const message = parseOperationalMessageObject(typeof value === 'string' ? JSON.parse(value) : JSON.parse(Buffer.from(value).toString('utf8'))) as OperationalMessage
      out.push(message)
      for (const waiter of waiters) if (waiter.predicate(message)) { waiters.delete(waiter); waiter.resolve(message) }
      return true
    },
    close(code?: number, reason?: string) { closed.push({ code, reason }) } }
  void auth
  return { channel, payload: undefined, out, closed, waitForMessage(predicate) {
    const prior = out.find(predicate)
    if (prior) return Promise.resolve(prior)
    return new Promise(resolve => waiters.add({ predicate, resolve }))
  } }
}
async function greet(service: OperationalProtocolService, ctx: ReturnType<typeof context>): Promise<void> {
  await service.onMessage({ channel: ctx.channel, payload: { ...valid.find(item => item.kind === 'hello')!,
    deviceId, controllerId, messageId: 'hello-' + ctx.channel.connectionId } })
  assert.equal(ctx.out.at(-1)?.kind, 'ready')
}
function eventStatuses(ctx: ReturnType<typeof context>): string[] {
  return ctx.out.filter((item): item is Extract<OperationalMessage, { kind: 'event' }> => item.kind === 'event' &&
    item.body.type === 'operation-result').map(item => (item.body as { type: 'operation-result';
      payload: { status: string } }).payload.status)
}

test('dispatcher persists before synthetic execution and deduplicates concurrent sockets and retries', async () => {
  const directory = temp()
  const store = new PlayerOperationalStore(storeOptions(directory))
  let executions = 0
  let release!: (value: { status: 'completed'; state: string }) => void
  const service = new OperationalProtocolService({ store, authorization: authorization(), deviceId, playerEpoch,
    isTargetCurrent: () => true,
    executionPort: { execute: async () => { executions++; return new Promise(resolve => { release = resolve }) } } })
  const first = context('socket-a'), second = context('socket-b')
  try {
    await Promise.all([greet(service, first), greet(service, second)])
    const initial = command('same-intent')
    await Promise.all([service.onMessage({ channel: first.channel, payload: initial }),
      service.onMessage({ channel: second.channel, payload: { ...initial, messageId: 'message-retry' } })])
    assert.equal(executions, 1)
    assert.equal(store.lookupOperation(controllerId, 'same-intent')?.status, 'accepted')
    assert.ok(eventStatuses(first).includes('accepted'))
    assert.ok(second.out.some(item => item.kind === 'response' && item.body.type === 'operation-status'))
    release({ status: 'completed', state: 'synthetic-complete' })
    await service.waitForIdle()
    assert.equal(store.lookupOperation(controllerId, 'same-intent')?.status, 'completed')
    assert.ok(eventStatuses(first).includes('completed'))

    const conflict = command('same-intent', { target: { ...initial.body.target, stateRevision: 99 } })
    await service.onMessage({ channel: second.channel, payload: conflict })
    assert.ok(second.out.some(item => item.kind === 'error' && item.body.code === 'OPERATION_ID_CONFLICT'))
    assert.equal(executions, 1)
  } finally {
    await service.close()
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('authorization is rechecked at admission and generation fences stale commands', async () => {
  const directory = temp()
  const store = new PlayerOperationalStore(storeOptions(directory))
  const revokedService = new OperationalProtocolService({ store, authorization: authorization(count => count < 4),
    deviceId, playerEpoch, executionPort: { async execute() { throw new Error('MUST_NOT_EXECUTE') } } })
  const revoked = context('revoked')
  try {
    await greet(revokedService, revoked)
    await revokedService.onMessage({ channel: revoked.channel, payload: command('revoked-at-admission') })
    assert.deepEqual(revoked.closed.at(-1), { code: 1008, reason: 'REVOKED' })
    assert.equal(store.lookupOperation(controllerId, 'revoked-at-admission'), null)
    await revokedService.close()

    const staleService = new OperationalProtocolService({ store, authorization: authorization(), deviceId, playerEpoch,
      executionPort: { async execute() { throw new Error('STALE_TARGET_MUST_NOT_EXECUTE') } } })
    const stale = context('stale-generation')
    await greet(staleService, stale)
    const staleCommand = command('old-generation')
    staleCommand.body.target.controlEpoch = '2'
    await staleService.onMessage({ channel: stale.channel, payload: staleCommand })
    const record = store.lookupOperation(controllerId, 'old-generation')
    assert.equal(record?.status, 'rejected')
    assert.deepEqual(eventStatuses(stale), ['rejected'])
    await staleService.close()
  } finally {
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('not-found status is explicit and malformed/unauthorized messages never execute', async () => {
  const directory = temp()
  const store = new PlayerOperationalStore(storeOptions(directory))
  let executions = 0
  const service = new OperationalProtocolService({ store, authorization: authorization(), deviceId, playerEpoch,
    executionPort: { async execute() { executions++; return { status: 'completed', state: 'done' } } } })
  const ctx = context('queries')
  const denied = context('denied')
  try {
    await greet(service, ctx)
    const query = valid.find(item => item.kind === 'query' && item.body.type === 'operation-status') as Extract<OperationalMessage, { kind: 'query' }>
    await service.onMessage({ channel: ctx.channel, payload: { ...query, deviceId, controllerId, messageId: 'status-query', body: {
      ...query.body, queryId: 'query-absent', payload: { operationId: 'absent-op' } } } })
    const notFound = ctx.out.at(-1)!
    assert.equal(notFound.kind, 'response')
    if (notFound.kind === 'response') {
      assert.equal(notFound.body.payload.status, 'not-found')
      assert.equal(notFound.body.payload.fingerprint, null)
      parseOperationalMessageObject(notFound)
    }
    const malformed = { ...command('invalid'), unexpected: true }
    await service.onMessage({ channel: ctx.channel, payload: malformed })
    assert.equal(executions, 0)
    const denyService = new OperationalProtocolService({ store, authorization: authorization(() => false), deviceId, playerEpoch,
      executionPort: { async execute() { executions++; return { status: 'completed', state: 'done' } } } })
    await denyService.onMessage({ channel: denied.channel, payload: command('unauthorized') })
    assert.equal(store.lookupOperation(controllerId, 'unauthorized'), null)
    assert.equal(executions, 0)
    await denyService.close()
  } finally {
    await service.close()
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('restart converts an accepted but unfinished operation to unknown without re-execution', async () => {
  const directory = temp()
  let resolveOld!: (value: { status: 'completed'; state: string }) => void
  let executions = 0
  const store = new PlayerOperationalStore(storeOptions(directory))
  const oldService = new OperationalProtocolService({ store, authorization: authorization(), deviceId, playerEpoch,
    isTargetCurrent: () => true,
    executionTimeoutMs: 10_000,
    executionPort: { async execute() { executions++; return new Promise(resolve => { resolveOld = resolve }) } } })
  const oldChannel = context('before-restart')
  try {
    await greet(oldService, oldChannel)
    await oldService.onMessage({ channel: oldChannel.channel, payload: command('restart-unknown') })
    assert.equal(store.lookupOperation(controllerId, 'restart-unknown')?.status, 'accepted')
    store.close()

    const restarted = new PlayerOperationalStore({ ...storeOptions(directory), initializeIfMissing: false })
    const afterRestart = new OperationalProtocolService({ store: restarted, authorization: authorization(), deviceId, playerEpoch: 'next-player-epoch',
      executionPort: { async execute() { executions++; return { status: 'completed', state: 'must-not-run' } } } })
    const retryChannel = context('after-restart')
    await greet(afterRestart, retryChannel)
    const retry = command('restart-unknown')
    retry.body.target.playerEpoch = 'player-epoch-test'
    await afterRestart.onMessage({ channel: retryChannel.channel, payload: retry })
    assert.equal(restarted.lookupOperation(controllerId, 'restart-unknown')?.status, 'unknown')
    assert.equal(executions, 1)
    resolveOld({ status: 'completed', state: 'late' })
    await oldService.waitForIdle()
    assert.equal(restarted.lookupOperation(controllerId, 'restart-unknown')?.status, 'unknown')
    await afterRestart.close()
    restarted.close()
  } finally {
    resolveOld?.({ status: 'completed', state: 'cleanup' })
    await oldService.waitForIdle().catch(() => undefined)
    try { store.close() } catch {}
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('timeout keeps the live handler fenced, reports blocked drains, and leaves the operation unknown', async () => {
  const directory = temp()
  const store = new PlayerOperationalStore(storeOptions(directory))
  let release!: (value: { status: 'completed'; state: string }) => void
  const service = new OperationalProtocolService({ store, authorization: authorization(), deviceId, playerEpoch,
    isTargetCurrent: () => true, maxConcurrentExecutions: 1, executionTimeoutMs: 10_000,
    executionPort: { execute: async () => new Promise(resolve => { release = resolve }) } })
  const ctx = context('backpressure')
  try {
    await greet(service, ctx)
    await service.onMessage({ channel: ctx.channel, payload: command('accepted-under-limit') })
    await service.onMessage({ channel: ctx.channel, payload: command('busy-under-load') })
    assert.ok(ctx.out.some(item => item.kind === 'error' && item.body.code === 'BUSY'))
    assert.equal(store.lookupOperation(controllerId, 'busy-under-load'), null)
    release({ status: 'completed', state: 'done' })
    await service.waitForIdle()
  } finally { await service.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }) }

  const timeoutDirectory = temp()
  const timeoutStore = new PlayerOperationalStore(storeOptions(timeoutDirectory))
  let start!: () => void
  let resolveFirst!: (value: { status: 'completed'; state: string }) => void
  let executions = 0
  let authorizationCurrent = true
  const started = new Promise<void>(resolve => { start = resolve })
  const timeoutService = new OperationalProtocolService({ store: timeoutStore, authorization: authorization(() => authorizationCurrent), deviceId, playerEpoch,
    isTargetCurrent: () => true, maxConcurrentExecutions: 1, executionTimeoutMs: 15, shutdownTimeoutMs: 20,
    executionPort: { execute() { executions++; start(); return new Promise(resolve => { resolveFirst = resolve }) } } })
  const timeoutContext = context('execution-timeout')
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await greet(timeoutService, timeoutContext)
    await timeoutService.onMessage({ channel: timeoutContext.channel, payload: command('timeout-unknown') })
    await started
    const timedOut = timeoutContext.waitForMessage(item => item.kind === 'event' && item.body.type === 'operation-result' &&
      item.body.payload.status === 'unknown')
    mock.timers.tick(15)
    await timedOut
    assert.equal(timeoutStore.lookupOperation(controllerId, 'timeout-unknown')?.status, 'unknown')
    assert.deepEqual(eventStatuses(timeoutContext), ['accepted', 'unknown'])
    const idleWait = timeoutService.waitForIdle(20)
    mock.timers.tick(20)
    assert.deepEqual(await idleWait, { state: 'blocked', activeExecutions: 1, pendingAdmissions: 0 })
    await timeoutService.onMessage({ channel: timeoutContext.channel, payload: command('still-busy') })
    assert.equal(executions, 1)
    assert.equal(timeoutStore.lookupOperation(controllerId, 'still-busy'), null)
    assert.ok(timeoutContext.out.some(item => item.kind === 'error' && item.body.code === 'BUSY'))
    authorizationCurrent = false
    await timeoutService.onMessage({ channel: timeoutContext.channel, payload: command('revoked-during-execution') })
    assert.equal(timeoutStore.lookupOperation(controllerId, 'revoked-during-execution'), null)
    assert.deepEqual(timeoutContext.closed.at(-1), { code: 1008, reason: 'REVOKED' })
    assert.equal(executions, 1)
    const shutdown = timeoutService.close()
    mock.timers.tick(20)
    assert.deepEqual(await shutdown, { state: 'blocked', activeExecutions: 1, pendingAdmissions: 0 })
    resolveFirst({ status: 'completed', state: 'late-result-must-not-replace-unknown' })
    assert.deepEqual(await timeoutService.waitForIdle(20), { state: 'closed', activeExecutions: 0, pendingAdmissions: 0 })
    assert.equal(timeoutStore.lookupOperation(controllerId, 'timeout-unknown')?.status, 'unknown')
  } finally { mock.timers.reset(); await timeoutService.close(); timeoutStore.close(); fs.rmSync(timeoutDirectory, { recursive: true, force: true }) }
})

test('a handler rejection after response timeout remains tracked until rejection settles', async () => {
  const directory = temp()
  const store = new PlayerOperationalStore(storeOptions(directory))
  let rejectHandler!: (error: Error) => void
  let started!: () => void
  const executionStarted = new Promise<void>(resolve => { started = resolve })
  const service = new OperationalProtocolService({ store, authorization: authorization(), deviceId, playerEpoch,
    isTargetCurrent: () => true, maxConcurrentExecutions: 1, executionTimeoutMs: 10, shutdownTimeoutMs: 20,
    executionPort: { execute() { started(); return new Promise((_resolve, reject) => { rejectHandler = reject }) } } })
  const ctx = context('late-rejection')
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await greet(service, ctx)
    await service.onMessage({ channel: ctx.channel, payload: command('late-rejection') })
    await executionStarted
    const unknown = ctx.waitForMessage(message => message.kind === 'event' && message.body.type === 'operation-result' &&
      message.body.payload.status === 'unknown')
    mock.timers.tick(10)
    await unknown
    const drain = service.waitForIdle(20)
    mock.timers.tick(20)
    assert.deepEqual(await drain, { state: 'blocked', activeExecutions: 1, pendingAdmissions: 0 })
    rejectHandler(new Error('executor-rejected-after-timeout'))
    assert.deepEqual(await service.waitForIdle(20), { state: 'idle', activeExecutions: 0, pendingAdmissions: 0 })
    assert.equal(store.lookupOperation(controllerId, 'late-rejection')?.status, 'unknown')
    assert.deepEqual(eventStatuses(ctx), ['accepted', 'unknown'])
    assert.equal((await service.close()).state, 'closed')
  } finally { mock.timers.reset(); await service.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('failed transport sends cannot release a timed-out live handler slot', async () => {
  const directory = temp()
  const store = new PlayerOperationalStore(storeOptions(directory))
  let release!: (value: { status: 'completed'; state: string }) => void
  let started!: () => void
  let persistUnknown!: () => void
  const executionStarted = new Promise<void>(resolve => { started = resolve })
  const unknownPersisted = new Promise<void>(resolve => { persistUnknown = resolve })
  const originalFinish = store.finishOperation.bind(store)
  store.finishOperation = (input => {
    const result = originalFinish(input)
    if (input.status === 'unknown') persistUnknown()
    return result
  }) as typeof store.finishOperation
  const service = new OperationalProtocolService({ store, authorization: authorization(), deviceId, playerEpoch,
    isTargetCurrent: () => true, maxConcurrentExecutions: 1, executionTimeoutMs: 10, shutdownTimeoutMs: 20,
    executionPort: { execute() { started(); return new Promise(resolve => { release = resolve }) } } })
  const ctx = context('failed-timeout-send')
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await greet(service, ctx)
    await service.onMessage({ channel: ctx.channel, payload: command('failed-timeout-send') })
    await executionStarted
    ctx.channel.send = () => { throw new Error('transport-closed') }
    mock.timers.tick(10)
    await unknownPersisted
    const drain = service.waitForIdle(20)
    mock.timers.tick(20)
    assert.deepEqual(await drain, { state: 'blocked', activeExecutions: 1, pendingAdmissions: 0 })
    await service.onMessage({ channel: ctx.channel, payload: command('cannot-overtake-live-handler') })
    assert.equal(store.lookupOperation(controllerId, 'cannot-overtake-live-handler'), null)
    assert.equal(store.lookupOperation(controllerId, 'failed-timeout-send')?.status, 'unknown')
    release({ status: 'completed', state: 'late-result' })
    assert.deepEqual(await service.waitForIdle(20), { state: 'idle', activeExecutions: 0, pendingAdmissions: 0 })
    assert.equal(store.lookupOperation(controllerId, 'failed-timeout-send')?.status, 'unknown')
  } finally { mock.timers.reset(); release?.({ status: 'completed', state: 'cleanup' }); await service.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('quota failure blocks new execution while accepted operations retain terminal reservation', async () => {
  const directory = temp()
  const store = new PlayerOperationalStore(storeOptions(directory, { maxRecords: 16 }))
  const activation = structuredClone(valid.find((item): item is Extract<OperationalMessage, { kind: 'command' }> =>
    item.kind === 'command' && item.body.type === 'activate-turn')!)
  let executions = 0
  const service = new OperationalProtocolService({ store, authorization: authorization(), deviceId, playerEpoch,
    isTargetCurrent: () => true,
    executionPort: { async execute() { executions++; return { status: 'completed', state: 'synthetic-complete' } } } })
  const ctx = context('quota')
  try {
    await greet(service, ctx)
    for (const id of ['quota-a', 'quota-b', 'quota-c']) {
      const item = structuredClone(activation)
      item.messageId = 'msg-' + id
      item.body.operationId = id
      item.body.target.playerEpoch = playerEpoch
      item.body.target.controlEpoch = '3'
      item.body.target.turnId = 'LOG-' + id + '-AB12'
      await service.onMessage({ channel: ctx.channel, payload: item })
      await service.waitForIdle()
    }
    assert.equal(executions, 2)
    assert.equal(store.lookupOperation(controllerId, 'quota-a')?.status, 'completed')
    assert.equal(store.lookupOperation(controllerId, 'quota-b')?.status, 'completed')
    assert.equal(store.lookupOperation(controllerId, 'quota-c'), null)
    assert.ok(ctx.out.some(item => item.kind === 'error' && item.body.code === 'STORAGE_UNAVAILABLE'))
  } finally { await service.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('Management outbox commits before send, survives restart, and retries the same operationId', () => {
  const directory = temp()
  let database = createKaraokeDatabase(directory)
  let outbox = new ManagementRemoteOutbox(database, { deviceId: controllerId, controllerId })
  const intent = command('outbox-retry')
  try {
    const first = outbox.prepare(deviceId, intent)
    assert.equal(first.record.status, 'not-sent')
    assert.equal(outbox.prepare(deviceId, { ...intent, messageId: 'different-message-id' }).duplicate, true)
    const conflict = command('outbox-retry', { target: { ...intent.body.target, stateRevision: 99 } })
    assert.throws(() => outbox.prepare(deviceId, conflict), /MANAGEMENT_OUTBOX_CONFLICT/)
    const falsePort = { send() { return false } }
    const afterSendAttempt = outbox.transmit(deviceId, 'outbox-retry', falsePort)
    assert.equal(afterSendAttempt.status, 'unknown')
    database.close()

    database = createKaraokeDatabase(directory)
    outbox = new ManagementRemoteOutbox(database, { deviceId: controllerId, controllerId })
    assert.equal(outbox.get(deviceId, 'outbox-retry')?.status, 'unknown')
    let transmitted: OperationalMessage | undefined
    outbox.transmit(deviceId, 'outbox-retry', { send(message) { transmitted = message; return true } })
    assert.equal(transmitted?.kind, 'command')
    if (transmitted?.kind === 'command') assert.equal(transmitted.body.operationId, 'outbox-retry')
    assert.notEqual(transmitted?.messageId, intent.messageId)
    assert.equal(outbox.recoverable(deviceId).length, 1)

    const completed = parseOperationalMessageObject({ protocolVersion: 1, schemaVersion: 1, kind: 'response',
      messageId: 'status-result', deviceId, controllerId, body: { correlationId: 'query-1', type: 'operation-status',
        payload: { operationId: 'outbox-retry', fingerprint: first.record.fingerprint, status: 'completed',
          result: { status: 'completed' }, eventSequence: 2 } } })
    assert.equal(outbox.acceptStatus(deviceId, completed)?.status, 'completed')
    assert.equal(outbox.recoverable(deviceId).length, 0)
  } finally {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Management outbox rejects unauthenticated status identity and retains terminal outcomes', () => {
  const directory = temp()
  const database = createKaraokeDatabase(directory)
  const outbox = new ManagementRemoteOutbox(database, { deviceId: controllerId, controllerId })
  try {
    outbox.prepare(deviceId, command('outbox-status'))
    outbox.transmit(deviceId, 'outbox-status', { send() { return true } })
    const wrongIdentity = { protocolVersion: 1, schemaVersion: 1, kind: 'event', messageId: 'e',
      deviceId: 'other-player', controllerId, body: { journalId: 'j', eventSequence: 1, schemaVersion: 1,
        causationOperationId: 'outbox-status', stateRevision: 0, type: 'operation-result',
        payload: { operationId: 'outbox-status', status: 'completed' } } }
    assert.throws(() => outbox.acceptStatus(deviceId, wrongIdentity), /IDENTITY_MISMATCH/)
    const record = outbox.get(deviceId, 'outbox-status')!
    database.remoteOutbox.recordRemoteStatus({ playerDeviceId: deviceId, controllerId, operationId: 'outbox-status',
      fingerprint: record.fingerprint, status: 'completed', detail: { status: 'completed' } })
    assert.throws(() => database.remoteOutbox.recordRemoteStatus({ playerDeviceId: deviceId, controllerId,
      operationId: 'outbox-status', fingerprint: record.fingerprint, status: 'rejected', detail: { status: 'rejected' } }),
    /TERMINAL_CONFLICT/)
  } finally { database.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('Management outbox accepts identical accepted and completed status retries across restart, but rejects conflicts', () => {
  const directory = temp()
  let database = createKaraokeDatabase(directory)
  let outbox = new ManagementRemoteOutbox(database, { deviceId: controllerId, controllerId })
  try {
    const intent = command('outbox-duplicate-status')
    const record = outbox.prepare(deviceId, intent).record
    outbox.transmit(deviceId, intent.body.operationId, { send() { return true } })
    const status = (state: 'accepted' | 'completed', result: Record<string, unknown> | null, correlationId: string) =>
      parseOperationalMessageObject({ protocolVersion: 1, schemaVersion: 1, kind: 'response', messageId: 'status-' + correlationId,
        deviceId, controllerId, body: { correlationId, type: 'operation-status', payload: { operationId: intent.body.operationId,
          fingerprint: record.fingerprint, status: state, result, eventSequence: state === 'accepted' ? 1 : 2 } } })
    const accepted = status('accepted', { status: 'accepted' }, 'accepted-a')
    assert.equal(outbox.acceptStatus(deviceId, accepted)?.status, 'accepted')
    assert.equal(outbox.acceptStatus(deviceId, status('accepted', { status: 'accepted' }, 'accepted-b'))?.status, 'accepted')
    database.close()

    database = createKaraokeDatabase(directory)
    outbox = new ManagementRemoteOutbox(database, { deviceId: controllerId, controllerId })
    assert.equal(outbox.acceptStatus(deviceId, status('accepted', { status: 'accepted' }, 'accepted-restart'))?.status, 'accepted')
    const completed = status('completed', { status: 'completed' }, 'complete-a')
    assert.equal(outbox.acceptStatus(deviceId, completed)?.status, 'completed')
    assert.equal(outbox.acceptStatus(deviceId, status('completed', { status: 'completed' }, 'complete-b'))?.status, 'completed')
    assert.throws(() => outbox.acceptStatus(deviceId, status('completed', { status: 'completed', result: 'conflict' }, 'conflict')),
      /TERMINAL_CONFLICT/)
    assert.equal(outbox.get(deviceId, intent.body.operationId)?.status, 'completed')
  } finally { database.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('snapshot is checkpointed before response and authorized ACK cursor is durable', async () => {
  const directory = temp()
  const store = new PlayerOperationalStore(storeOptions(directory))
  const snapshotPort = {
    snapshot: () => ({ journalId: store.getMetadata().journalId, deviceId,
      playerEpoch, hostEpoch: 'host-epoch-test', controlEpoch: '3', stateRevision: 0, mode: 'paired',
      observedState: { status: 'idle' }, acceptedTurn: null, active: null, libraryRevision: 'library-rev-1',
      highWatermark: store.getMetadata().highWatermark, compactedThrough: store.getMetadata().compactedThrough, operations: [] }),
    mediaAvailability: () => ({ queryId: 'q-media', musicCode: '01001', deviceId,
      libraryRevision: 'library-rev-1', status: 'available', title: null, artist: null })
  }
  const service = new OperationalProtocolService({ store, authorization: authorization(), deviceId, playerEpoch,
    isTargetCurrent: () => true, snapshotPort })
  const ctx = context('socket-ack')
  try {
    await greet(service, ctx)
    const snapshotQuery = structuredClone(valid.find(item => item.kind === 'query' && item.body.type === 'snapshot')!) as any
    snapshotQuery.deviceId = deviceId
    snapshotQuery.controllerId = controllerId
    snapshotQuery.messageId = 'snapshot-request'
    snapshotQuery.body.queryId = 'snapshot-correlation'
    await service.onMessage({ channel: ctx.channel, payload: snapshotQuery })
    const response = ctx.out.at(-1)
    assert.equal(response?.kind, 'response')
    assert.equal(response?.body.type, 'snapshot')
    assert.equal(store.getLatestCheckpoint()?.sequence, 0)

    const ack = structuredClone(valid.find(item => item.kind === 'ack')!) as any
    ack.deviceId = deviceId
    ack.controllerId = controllerId
    ack.messageId = 'ack-zero'
    ack.body.correlationId = 'ack-correlation'
    ack.body.payload.journalId = store.getMetadata().journalId
    ack.body.payload.consumerId = controllerId
    ack.body.payload.throughSequence = 0
    await service.onMessage({ channel: ctx.channel, payload: ack })
    assert.equal(store.getConsumerCursor(controllerId)?.throughSequence, 0)
    assert.equal(ctx.out.some(message => message.kind === 'error' && message.body.correlationId === 'ack-correlation'), false)

    const forgedAck = structuredClone(ack)
    forgedAck.messageId = 'ack-forged-consumer'
    forgedAck.body.payload.consumerId = 'other-controller'
    await service.onMessage({ channel: ctx.channel, payload: forgedAck })
    assert.ok(ctx.out.some(message => message.kind === 'error' && message.body.code === 'NOT_AUTHORIZED' &&
      message.body.correlationId === 'ack-correlation'))
    assert.equal(store.getConsumerCursor('other-controller'), null)
  } finally {
    await service.close()
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
