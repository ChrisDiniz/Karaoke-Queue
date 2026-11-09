import test from 'node:test'
import assert from 'node:assert/strict'
import { MainManagementCloseCoordinator, type ManagementClosePort } from '../src/main-management-close'

function setup(options: {
  summary?: { sessionActive: boolean; uncompletedCount: number; sessionId: string | null }
  responses?: number[]
  failFlush?: boolean
  startupComplete?: boolean
  licensed?: boolean
  prepareToClose?: () => Promise<void>
} = {}) {
  const calls: string[] = []
  const responses = [...(options.responses ?? [])]
  let destroyed = false
  const port: ManagementClosePort = {
    prepareToClose: async () => { calls.push('prepare'); await options.prepareToClose?.() },
    closeSummary: async () => { calls.push('summary'); return options.summary ?? { sessionActive: true, uncompletedCount: 0, sessionId: 'session-1' } },
    flushState: async () => { calls.push('flush'); if (options.failFlush) throw new Error('disk unavailable') },
    endSessionAndArchive: async () => { calls.push('end-session'); return true },
    cancelClose: async () => { calls.push('cancel-close') }
  }
  const coordinator = new MainManagementCloseCoordinator({
    getPort: () => port,
    isWindowDestroyed: () => destroyed,
    showMessageBox: async message => {
      calls.push(`dialog:${message.title}`)
      return { response: responses.shift() ?? 0, checkboxChecked: false }
    },
    isStartupComplete: () => options.startupComplete ?? true,
    isLicenseOperationallyAllowed: () => options.licensed ?? true,
    closeWindow: () => { calls.push('close'); destroyed = true },
    logger: { info: (_origin, event) => calls.push(`info:${event}`), error: (_origin, event) => calls.push(`error:${event}`) }
  })
  return { coordinator, calls }
}

function closeEvent() {
  let prevented = false
  return { event: { preventDefault: () => { prevented = true } } as Electron.Event, wasPrevented: () => prevented }
}

async function drainMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

test('closing with no active session flushes state without prompting', async () => {
  const context = setup({ summary: { sessionActive: false, uncompletedCount: 0, sessionId: null } })
  const close = closeEvent()
  context.coordinator.handleClose(close.event)
  assert.equal(close.wasPrevented(), true)
  await drainMicrotasks()
  assert.deepEqual(context.calls.slice(0, 5), ['info:APP_CLOSE_REQUESTED', 'prepare', 'summary', 'flush', 'info:APP_CLOSE_DECISION'])
  assert.equal(context.calls.includes('dialog:Karaoke Queue'), false)
  assert.equal(context.calls.includes('end-session'), false)
  assert.equal(context.calls.at(-1), 'close')
})

test('cancel choice preserves the window and thaws admission', async () => {
  const context = setup({ responses: [2] })
  context.coordinator.handleClose(closeEvent().event)
  await drainMicrotasks()
  assert.equal(context.calls.includes('close'), false)
  assert.equal(context.calls.includes('cancel-close'), true)
  assert.equal(context.calls.includes('end-session'), false)
})

test('session end asks confirmation for pending turns and closes only after confirmed archive', async () => {
  const context = setup({ summary: { sessionActive: true, uncompletedCount: 2, sessionId: 'session-7' }, responses: [0, 0] })
  context.coordinator.handleClose(closeEvent().event)
  await drainMicrotasks()
  assert.equal(context.calls.filter(call => call.startsWith('dialog:')).length, 2)
  assert.equal(context.calls.includes('end-session'), true)
  assert.equal(context.calls.at(-1), 'close')
})

test('persistence failure keeps window open, reports failure, and cancels close admission', async () => {
  const context = setup({ licensed: false, failFlush: true })
  context.coordinator.handleClose(closeEvent().event)
  await drainMicrotasks()
  assert.equal(context.calls.includes('close'), false)
  assert.equal(context.calls.includes('error:APP_CLOSE_PERSISTENCE_FAILED'), true)
  assert.equal(context.calls.includes('cancel-close'), true)
})

test('concurrent close events share one close flow', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const context = setup({ summary: { sessionActive: false, uncompletedCount: 0, sessionId: null }, prepareToClose: () => pending })
  const first = closeEvent()
  const second = closeEvent()
  context.coordinator.handleClose(first.event)
  context.coordinator.handleClose(second.event)
  assert.equal(first.wasPrevented(), true)
  assert.equal(second.wasPrevented(), true)
  assert.equal(context.calls.filter(call => call === 'prepare').length, 1)
  release()
  await drainMicrotasks()
  assert.equal(context.calls.filter(call => call === 'close').length, 1)
})
