import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IpcMain, WebContents } from 'electron'
import { ChromiumPlaybackHost } from '../src/chromium-playback-host'

class FakeIpcMain extends EventEmitter {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()

  handle(channel: string, listener: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }
}

class FakeWebContents extends EventEmitter {
  readonly mainFrame = {}
  destroyed = false

  isDestroyed(): boolean { return this.destroyed }
  setWindowOpenHandler(_handler: () => { action: 'deny' }): void {}
  send(_channel: string, ..._args: unknown[]): void {}
}

function createHost(terminateOwner: () => Promise<boolean>) {
  const ipc = new FakeIpcMain()
  const webContents = new FakeWebContents()
  const host = new ChromiumPlaybackHost(
    ipc as unknown as IpcMain,
    webContents as unknown as WebContents,
    'file:///isolated-player.html',
    terminateOwner
  )
  // The focused tests do not need Renderer readiness; handle rejection when dispose cancels it.
  void host.ready.catch(() => undefined)
  return { host, webContents, ipc }
}

test('terminate returns false when owner reports success without destroying the playback WebContents', async () => {
  const { host, webContents } = createHost(async () => true)
  try {
    assert.equal(await host.terminate(), false)
    assert.equal(webContents.isDestroyed(), false)
  } finally {
    host.dispose()
  }
})

test('terminate returns true only after the playback WebContents destruction is observed', async () => {
  const { host, webContents } = createHost(async () => {
    webContents.destroyed = true
    webContents.emit('destroyed')
    return true
  })
  try {
    assert.equal(await host.terminate(), true)
    assert.equal(webContents.isDestroyed(), true)
  } finally {
    host.dispose()
  }
})

test('a late Chromium command acknowledgement after the real timeout is ignored', async () => {
  const { host, webContents, ipc } = createHost(async () => false)
  const authorizedEvent = { sender: webContents, senderFrame: webContents.mainFrame }
  try {
    const readyHandler = ipc.handlers.get('player-playback:ready')
    assert.ok(readyHandler)
    await readyHandler(authorizedEvent)
    await host.ready

    const command = host.send({ type: 'stop', commandId: 'late-ack-command', attemptId: 'attempt-1' })
    await assert.rejects(command, error => {
      assert.equal((error as { code?: string }).code, 'COMMAND_TIMEOUT')
      return true
    })

    const acknowledgeHandler = ipc.handlers.get('player-playback:acknowledge')
    assert.ok(acknowledgeHandler)
    await assert.doesNotReject(Promise.resolve(acknowledgeHandler(authorizedEvent, {
      commandId: 'late-ack-command', attemptId: 'attempt-1', accepted: true
    })))
    await assert.rejects(command, error => (error as { code?: string }).code === 'COMMAND_TIMEOUT',
      'the late acknowledgement must not resolve or change the already timed-out operation')
  } finally {
    host.dispose()
  }
})
