import test from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMainEvent, WebContents } from 'electron'
import { createMainIpcPolicy } from '../src/main-ipc-policy'

function webContents(url: string) {
  let destroyed = false
  const contents = {
    id: 1,
    mainFrame: { url },
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true }
  }
  return contents
}

function event(sender: ReturnType<typeof webContents>, senderFrame = sender.mainFrame): IpcMainEvent {
  return { sender, senderFrame } as unknown as IpcMainEvent
}

test('Main IPC policy accepts only the enabled live owner main frame at the exact document URL', () => {
  const expectedUrl = 'file:///app/src/index.html'
  const owner = webContents(expectedUrl)
  let enabled = true
  const authorize = createMainIpcPolicy({
    getExpectedWebContents: () => owner as unknown as WebContents,
    getExpectedDocumentUrl: () => expectedUrl,
    isEnabled: () => enabled,
    forbiddenCode: 'IPC_FORBIDDEN'
  })

  assert.doesNotThrow(() => authorize(event(owner)))

  enabled = false
  assert.throws(() => authorize(event(owner)), { message: 'IPC_FORBIDDEN' })
  enabled = true
  assert.throws(() => authorize(event(webContents(expectedUrl))), { message: 'IPC_FORBIDDEN' })
  assert.throws(() => authorize(event(owner, { url: expectedUrl })), { message: 'IPC_FORBIDDEN' })
  assert.throws(() => authorize(event(webContents('file:///app/src/old.html'))), { message: 'IPC_FORBIDDEN' })
  owner.destroy()
  assert.throws(() => authorize(event(owner)), { message: 'IPC_FORBIDDEN' })
})

test('Main IPC policy checks mode dynamically so stale handlers cannot outlive capability', () => {
  const url = 'file:///app/src/index.html'
  const owner = webContents(url)
  let modeAllowsController = true
  const authorize = createMainIpcPolicy({
    getExpectedWebContents: () => owner as unknown as WebContents,
    getExpectedDocumentUrl: () => url,
    isEnabled: () => modeAllowsController,
    forbiddenCode: 'CONTROLLER_IPC_FORBIDDEN'
  })

  authorize(event(owner))
  modeAllowsController = false
  assert.throws(() => authorize(event(owner)), { message: 'CONTROLLER_IPC_FORBIDDEN' })
})
