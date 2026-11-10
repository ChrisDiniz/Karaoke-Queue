import test from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createKaraokeDatabase } from '../database'
import { KaraokeApplication } from '../src/application'
import { createStateRepository } from '../src/state-repository'
import { MainManagementHost } from '../src/main-management-host'
import { registerManagementIpcHandlers, validateLegacyStateStorageDto, validateManagementCommandRequest } from '../src/management-ipc'
import { LEGACY_STATE_STORAGE_KEYS } from '../src/persistence-contracts'

const emptyLegacyState = () => Object.fromEntries(Object.values(LEGACY_STATE_STORAGE_KEYS).map(key => [key, null]))

class FakeIpcMain {
  readonly handlers = new Map<string, (...args: any[]) => any>()
  handle(channel: string, listener: (...args: any[]) => any): void {
    assert.equal(this.handlers.has(channel), false)
    this.handlers.set(channel, listener)
  }
  removeHandler(channel: string): void { this.handlers.delete(channel) }
}

function call(ipc: FakeIpcMain, channel: string, event: object, ...args: unknown[]): Promise<unknown> {
  try {
    const handler = ipc.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return Promise.resolve(handler(event, ...args))
  } catch (error) { return Promise.reject(error) }
}

test('Management command DTO validator rejects malformed, extra, and oversized input', () => {
  assert.deepEqual(validateManagementCommandRequest({ operationId: 'ok-1', command: {
    type: 'addEntries', entries: [{ name: 'A', songNumber: '1', songNumber2: '', table: '1' }], selectCurrent: true
  } }).command.type, 'addEntries')
  for (const invalid of [
    null,
    { operationId: 'x', extra: true, command: { type: 'releaseFreeze' } },
    { operationId: 'x', command: { type: 'addEntries', entries: [{ name: 'A', songNumber: '1', songNumber2: '', table: '1', status: 'done' }], selectCurrent: true } },
    { operationId: 'x', command: { type: 'moveTurn', id: 'q', targetPosition: 1.5 } },
    { operationId: 'x', command: { type: 'endCurrentSession' } },
    { operationId: 'x', command: { type: 'unlisted', id: 'q' } }
  ]) assert.throws(() => validateManagementCommandRequest(invalid))
  assert.deepEqual(validateLegacyStateStorageDto(emptyLegacyState()), emptyLegacyState())
  assert.throws(() => validateLegacyStateStorageDto({ ...emptyLegacyState(), unexpected: 'value' }))
  assert.throws(() => validateLegacyStateStorageDto({ ...emptyLegacyState(), kshake_queue: 1 }))
})

test('IPC sender and schema validation happen before the Main application can mutate state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-management-ipc-'))
  const database = createKaraokeDatabase(root)
  const app = new KaraokeApplication(createStateRepository({
    async load() { return database.loadState() }, async save(state) { database.saveState(state); return true }
  }))
  const host = new MainManagementHost(app, { hostEpoch: 'ipc-epoch' })
  await host.initialize()
  const ipc = new FakeIpcMain()
  const sent: number[] = []
  let authorized = false
  const dispose = registerManagementIpcHandlers({
    ipcMain: ipc as unknown as IpcMain, host,
    logger: { warn() {}, error() {} },
    assertSender: (_event: IpcMainInvokeEvent) => { if (!authorized) throw new Error('MANAGEMENT_IPC_FORBIDDEN') },
    initializeHost: legacy => host.initialize(false, legacy),
    sendState: snapshot => sent.push(snapshot.revision)
  })
  const request = { operationId: 'ipc-add-1', command: { type: 'addEntries', entries: [
    { name: 'Singer', songNumber: '123', songNumber2: '', table: '1' }
  ], selectCurrent: true } }
  try {
    await assert.rejects(call(ipc, 'management:command', {}, request), /MANAGEMENT_IPC_FORBIDDEN/)
    assert.equal(database.loadState().queue?.length, 0)
    await assert.rejects(call(ipc, 'management:initialize', {}, emptyLegacyState()), /MANAGEMENT_IPC_FORBIDDEN/)
    authorized = true
    await assert.rejects(call(ipc, 'management:initialize', {}, { ...emptyLegacyState(), kshake_queue: 10 }), /INVALID_MANAGEMENT_LEGACY_STORAGE/)
    assert.equal(database.loadState().queue?.length, 0)
    await assert.rejects(call(ipc, 'management:command', {}, { ...request, command: { type: 'addEntries', entries: 'bad', selectCurrent: true } }), /INVALID_MANAGEMENT_COMMAND_PAYLOAD/)
    assert.equal(database.loadState().queue?.length, 0)
    const reply = await call(ipc, 'management:command', {}, request) as { snapshot: { revision: number; state: { queue: unknown[] } } }
    assert.equal(reply.snapshot.state.queue.length, 1)
    assert.deepEqual(sent, [reply.snapshot.revision])
  } finally {
    dispose(); dispose()
    assert.equal(ipc.handlers.size, 0)
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
