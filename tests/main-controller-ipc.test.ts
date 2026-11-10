import test from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import {
  registerMainControllerIpcHandlers,
  registerMainLicenseIpcHandlers,
  registerMainControllerWindowIpcHandlers,
  type MainControllerIpcDependencies
} from '../src/main-controller-ipc'

class FakeIpcMain {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  readonly listeners = new Map<string, (...args: any[]) => void>()
  readonly removedHandlers: string[] = []
  readonly removedListeners: string[] = []
  handle(channel: string, listener: (...args: unknown[]) => unknown): void {
    assert.equal(this.handlers.has(channel), false)
    this.handlers.set(channel, listener)
  }
  removeHandler(channel: string): void { this.removedHandlers.push(channel); this.handlers.delete(channel) }
  on(channel: string, listener: (...args: any[]) => void): this { this.listeners.set(channel, listener); return this }
  removeListener(channel: string, listener: (...args: any[]) => void): this {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel)
    this.removedListeners.push(channel)
    return this
  }
}

function setup() {
  const ipcMain = new FakeIpcMain()
  const logs: Array<{ level: string; event: string }> = []
  const sessionEvents: unknown[][] = []
  let allowed = true
  const deps = {
    ipcMain: ipcMain as unknown as IpcMain,
    getLicenseService: () => ({ getStatus: () => ({ expired: false }), activate: () => ({ expired: false }) }),
    logger: {
      info: (_origin: string, event: string) => logs.push({ level: 'info', event }),
      warn: (_origin: string, event: string) => logs.push({ level: 'warn', event }),
      error: (_origin: string, event: string) => logs.push({ level: 'error', event })
    },
    openLogs: async () => '',
    assertControllerIpcSender: (_event: IpcMainEvent | IpcMainInvokeEvent) => {
      if (!allowed) throw new Error('CONTROLLER_IPC_FORBIDDEN')
    },
    reportSessionEvent: (...args: unknown[]) => { sessionEvents.push(args) }
  } as unknown as MainControllerIpcDependencies
  const dispose = registerMainControllerIpcHandlers(deps)
  return { ipcMain, logs, sessionEvents, setAllowed: (value: boolean) => { allowed = value },
    counts: () => ({}), dispose }
}

function invoke(ipcMain: FakeIpcMain, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipcMain.handlers.get(channel)
  if (!handler) return Promise.reject(new Error(`No handler for ${channel}`))
  try { return Promise.resolve(handler(...args)) } catch (error) { return Promise.reject(error) }
}

test('Renderer has no direct operational-state load or save IPC', async () => {
  const context = setup()
  context.setAllowed(false)
  assert.equal(context.ipcMain.handlers.has('app-data:load'), false)
  assert.equal(context.ipcMain.handlers.has('app-data:save'), false)
  await assert.rejects(invoke(context.ipcMain, 'app-data:load', {}), /No handler/)
  await assert.rejects(invoke(context.ipcMain, 'app-data:save', {}, {}), /No handler/)
  context.dispose()
})

test('unauthorized Management event messages do not reach diagnostics or session effects', () => {
  const context = setup()
  context.setAllowed(false)
  context.ipcMain.listeners.get('diagnostics:session-event')!({}, { event: 'SESSION_ENDED', sessionId: 'x' })
  assert.deepEqual(context.sessionEvents, [])
  assert.ok(context.logs.some(log => log.event === 'CONTROLLER_IPC_FORBIDDEN'))
  context.dispose()
})

test('Management IPC registration owns handler and event cleanup without a mode-change route', async () => {
  const context = setup()
  assert.equal(context.ipcMain.handlers.has('settings:operating-mode:change'), false)
  context.dispose()
  context.dispose()
  assert.equal(context.ipcMain.handlers.size, 0)
  assert.equal(context.ipcMain.listeners.size, 0)
  assert.equal(context.ipcMain.removedHandlers.length, 3)
  assert.equal(context.ipcMain.removedListeners.length, 2)
})

test('Management window preference IPC requires its owner before invoking preference callbacks', async () => {
  const ipcMain = new FakeIpcMain()
  let authorized = false
  let writes = 0
  let reads = 0
  const dispose = registerMainControllerWindowIpcHandlers({
    ipcMain: ipcMain as unknown as IpcMain,
    assertControllerIpcSender: () => { if (!authorized) throw new Error('CONTROLLER_IPC_FORBIDDEN') },
    getUiScale: () => { reads++; return { effectiveFactor: 1 } },
    setUiScalePreference: () => { writes++; return { effectiveFactor: 1 } },
    getSidebarDisplayName: () => { reads++; return 'Karaoke Queue' },
    setSidebarDisplayName: () => { writes++; return 'Karaoke Queue' }
  })

  await assert.rejects(invoke(ipcMain, 'ui-scale:set-preference', {}, 1.2), /CONTROLLER_IPC_FORBIDDEN/)
  assert.equal(reads, 0)
  assert.equal(writes, 0)
  authorized = true
  assert.deepEqual(await invoke(ipcMain, 'ui-scale:set-preference', {}, 1.2), { effectiveFactor: 1 })
  assert.equal(writes, 1)
  dispose()
  dispose()
  assert.equal(ipcMain.handlers.size, 0)
  assert.equal(ipcMain.removedHandlers.length, 4)
})

test('standalone license IPC exposes only license channels and authorizes before touching the service', () => {
  const ipcMain = new FakeIpcMain()
  const sender = {} as IpcMainInvokeEvent
  let allowed = true
  let calls = 0
  const dispose = registerMainLicenseIpcHandlers({
    ipcMain: ipcMain as unknown as IpcMain,
    getLicenseService: () => { calls++; return undefined },
    logger: { error: () => {} },
    assertLicenseIpcSender: event => { assert.equal(event, sender); if (!allowed) throw Error('LICENSE_IPC_FORBIDDEN') }
  })
  assert.deepEqual([...ipcMain.handlers.keys()], ['license:get-status', 'license:activate'])
  allowed = false
  for (const handler of ipcMain.handlers.values()) assert.throws(() => handler(sender, 'invalid'), /LICENSE_IPC_FORBIDDEN/)
  assert.equal(calls, 0)
  allowed = true
  assert.throws(() => ipcMain.handlers.get('license:get-status')!(sender), /LICENSE_SERVICE_UNAVAILABLE/)
  assert.equal(calls, 1)
  dispose(); dispose()
  assert.equal(ipcMain.handlers.size, 0)
})
