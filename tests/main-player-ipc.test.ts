import test from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'
import {
  registerMainPlayerIpcHandlers,
  registerMainStandaloneFullscreenHandler,
  type MainPlayerIpcDependencies
} from '../src/main-player-ipc'

class FakeIpcMain {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  readonly removed: string[] = []

  handle(channel: string, listener: (...args: unknown[]) => unknown): void {
    assert.equal(this.handlers.has(channel), false, `duplicate IPC handler ${channel}`)
    this.handlers.set(channel, listener)
  }

  removeHandler(channel: string): void {
    this.removed.push(channel)
    this.handlers.delete(channel)
  }
}

const playerChannels = [
  'player:get-snapshot', 'player:lookup-code', 'player:play-now',
  'player:sequence:add', 'player:sequence:add-batch', 'player:sequence:remove',
  'player:sequence:remove-current', 'player:sequence:reorder', 'player:sequence:clear',
  'player:mode:change', 'player:pause', 'player:resume', 'player:restart', 'player:stop',
  'player:next', 'player:previous', 'player:catalog:import', 'player:library:select-folder',
  'player:library:refresh', 'player:video:show', 'player:video:window-tip',
  'player-video:window-tip-dismissed', 'player:video:inline', 'player:video:inline-bounds',
  'player:video:inline-visibility', 'player:video:inline-hide', 'player-video:set-fullscreen',
  'player:video:fullscreen-toggle', 'player:video:fullscreen-exit', 'player:recovery:replay',
  'player:recovery:choose-another', 'player:recovery:leave-stopped',
  'player:recovery:resolve-invalid', 'player:recovery:copy-diagnostic',
  'player:shutdown:cancel', 'player:shutdown:confirm', 'player:shutdown:finish'
]

test('Main Player IPC registers the existing channels and disposes each handler once', () => {
  const ipcMain = new FakeIpcMain()
  const dependencies = { ipcMain: ipcMain as unknown as IpcMain } as MainPlayerIpcDependencies
  const dispose = registerMainPlayerIpcHandlers(dependencies)

  assert.deepEqual([...ipcMain.handlers.keys()], playerChannels)

  dispose()
  dispose()

  assert.equal(ipcMain.handlers.size, 0)
  assert.deepEqual(ipcMain.removed, [...playerChannels].reverse())
})

test('Player IPC validates its sender before reading or mutating Player services', async () => {
  const ipcMain = new FakeIpcMain()
  const forbidden = new Error('PLAYER_IPC_FORBIDDEN')
  let senderChecks = 0
  const dependencies = {
    ipcMain: ipcMain as unknown as IpcMain,
    requirePlayerIpcSender() { senderChecks++; throw forbidden }
  } as unknown as MainPlayerIpcDependencies
  const dispose = registerMainPlayerIpcHandlers(dependencies)

  await assert.rejects(
    Promise.resolve().then(() => ipcMain.handlers.get('player:get-snapshot')!(undefined)),
    error => error === forbidden
  )
  assert.equal(senderChecks, 1)

  dispose()
})

test('partial Player IPC registration removes handlers acquired before startup failure', () => {
  const ipcMain = new FakeIpcMain()
  let registrations = 0
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => {
    registrations++
    if (registrations === 3) throw new Error('registration failed')
    handle(channel, listener)
  }

  assert.throws(() => registerMainPlayerIpcHandlers({
    ipcMain: ipcMain as unknown as IpcMain
  } as MainPlayerIpcDependencies), /registration failed/)
  assert.equal(ipcMain.handlers.size, 0)
  assert.deepEqual(ipcMain.removed, ['player:lookup-code', 'player:get-snapshot'])
})

test('Standalone fullscreen IPC uses its independent registration and lifecycle', () => {
  const ipcMain = new FakeIpcMain()
  const dependencies = { ipcMain: ipcMain as unknown as IpcMain } as MainPlayerIpcDependencies
  const dispose = registerMainStandaloneFullscreenHandler(dependencies)

  assert.deepEqual([...ipcMain.handlers.keys()], ['player-video:set-fullscreen'])
  dispose()
  dispose()
  assert.equal(ipcMain.handlers.size, 0)
  assert.deepEqual(ipcMain.removed, ['player-video:set-fullscreen'])
})
