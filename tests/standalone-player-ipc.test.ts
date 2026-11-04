import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import {
  createInitialStandalonePlayerSnapshot,
  type StandalonePlayerCommandRequest,
  type StandalonePlayerCommandResult,
  type StandalonePlayerControl,
  type StandalonePlayerListener,
  type StandalonePlayerSnapshot
} from '../src/standalone-player-contracts'
import { STANDALONE_PLAYER_IPC_CHANNELS } from '../src/standalone-player-ipc-contracts'
import { installStandalonePlayerMainIpcBridge } from '../src/standalone-player-ipc'

class FakeIpcMain {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, listener: (...args: unknown[]) => unknown): void {
    assert.equal(this.handlers.has(channel), false, `duplicate IPC handler ${channel}`)
    this.handlers.set(channel, listener)
  }
  removeHandler(channel: string): void { this.handlers.delete(channel) }
  invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) return Promise.reject(new Error(`No handler for ${channel}`))
    try { return Promise.resolve(handler(event, ...args)) }
    catch (error) { return Promise.reject(error) }
  }
}

class FakeWebContents extends EventEmitter {
  readonly id = 10
  mainFrame: { url: string }
  readonly sent: Array<{ channel: string; value: unknown }> = []
  private destroyed = false
  private crashed = false

  constructor(private url: string) {
    super()
    this.mainFrame = { url }
  }
  getURL(): string { return this.url }
  isDestroyed(): boolean { return this.destroyed }
  isCrashed(): boolean { return this.crashed }
  send(channel: string, value: unknown): void {
    if (this.destroyed || this.crashed) throw new Error('webContents unavailable')
    this.sent.push({ channel, value })
  }
  navigate(url = this.url): void {
    this.url = url
    this.mainFrame = { url }
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  }
  crash(): void {
    this.crashed = true
    this.emit('render-process-gone')
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
  sender(): WebContents { return this as unknown as WebContents }
}

class FakeControl implements StandalonePlayerControl {
  snapshot: StandalonePlayerSnapshot = createInitialStandalonePlayerSnapshot()
  readonly requests: StandalonePlayerCommandRequest[] = []
  readonly listeners = new Set<StandalonePlayerListener>()
  executeHandler: (request: StandalonePlayerCommandRequest) => Promise<StandalonePlayerCommandResult> = async request => ({
    outcome: 'confirmed', operationId: request.operationId, snapshot: this.snapshot
  })

  getSnapshot(): StandalonePlayerSnapshot { return this.snapshot }
  execute(request: StandalonePlayerCommandRequest): Promise<StandalonePlayerCommandResult> {
    this.requests.push(request)
    return this.executeHandler(request)
  }
  subscribe(listener: StandalonePlayerListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  setSnapshot(snapshot: StandalonePlayerSnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener(snapshot)
  }
}

const documentUrl = 'file:///isolated/standalone.html'

function setup() {
  const ipcMain = new FakeIpcMain()
  const webContents = new FakeWebContents(documentUrl)
  const control = new FakeControl()
  const bridge = installStandalonePlayerMainIpcBridge({
    ipcMain: ipcMain as unknown as IpcMain,
    webContents: webContents as unknown as WebContents,
    expectedDocumentUrl: documentUrl,
    control
  })
  const event = (sender: WebContents = webContents.sender(), frame: { url: string } = webContents.mainFrame) => ({
    sender,
    senderFrame: frame
  }) as IpcMainInvokeEvent
  return { ipcMain, webContents, control, bridge, event }
}

test('snapshot queries are versioned, cloned, and expose no mutable Main references', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const first = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, state.event()) as any
  assert.equal(first.revision, 0)
  assert.equal(first.snapshot.state.operationalState, 'idle')

  const mutable = first.snapshot as { state: { pending: unknown[] } }
  mutable.state.pending.push({ entryId: 'renderer', musicCode: '99999' })
  assert.deepEqual((await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, state.event()) as any).snapshot.state.pending, [])

  const playing: StandalonePlayerSnapshot = {
    playbackCondition: 'ready',
    state: { operationalState: 'playing', current: { entryId: 'e1', musicCode: '01001', attemptId: 'attempt-1' }, pending: [] }
  }
  state.control.setSnapshot(playing)
  const current = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, state.event()) as any
  assert.equal(current.revision, 1)
  assert.equal(current.snapshot.state.current.attemptId, 'attempt-1')
})

test('each invoke validates the exact WebContents, main frame, document URL, and argument count', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const foreign = new FakeWebContents(documentUrl)
  const wrongFrame = { url: documentUrl }
  const badEvents = [
    state.event(foreign.sender()),
    state.event(state.webContents.sender(), wrongFrame),
    state.event(state.webContents.sender(), { url: 'file:///untrusted.html' }),
    state.event(state.webContents.sender(), { url: documentUrl },)
  ]
  state.webContents.navigate('file:///untrusted.html')
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, badEvents[0]), /STANDALONE_IPC_FORBIDDEN/)
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, badEvents[1]), /STANDALONE_IPC_FORBIDDEN/)
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, badEvents[2]), /STANDALONE_IPC_FORBIDDEN/)
  state.webContents.navigate(documentUrl)
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, state.event(), 'extra'), /STANDALONE_IPC_INVALID_REQUEST/)
  assert.equal(state.control.requests.length, 0)
  foreign.destroy()
})

test('malformed or non-V1 commands are rejected before reaching StandaloneControl', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const invalid = [
    null,
    [],
    { operationId: 'ok', command: { type: 'next', extra: true } },
    { operationId: 'op with spaces', command: { type: 'next' } },
    { operationId: 'ok', command: { type: 'stop' } },
    { operationId: 'ok', command: { type: 'submit-code', enteredCode: '1001', priority: 'urgent' } },
    { operationId: 'ok', command: { type: 'submit-code', enteredCode: '1'.repeat(1025), priority: 'normal' } },
    { operationId: 'ok', command: { type: 'next' }, extra: 'not allowed' }
  ]
  for (const request of invalid) {
    await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), request), /STANDALONE_IPC_INVALID_REQUEST/)
  }
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.subscribe, state.event(), { subscriptionId: '../sp-1' }), /STANDALONE_IPC_INVALID_REQUEST/)
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.subscribe, state.event(), { subscriptionId: 'sp-1', extra: true }), /STANDALONE_IPC_INVALID_REQUEST/)
  assert.equal(state.control.requests.length, 0)
})

test('valid command preserves operationId, attemptId, outcome, and latest versioned snapshot', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const request = { operationId: 'intent-1', command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' } } as const
  state.control.executeHandler = async value => {
    const snapshot: StandalonePlayerSnapshot = {
      playbackCondition: 'ready',
      state: { operationalState: 'playing', current: { entryId: 'e1', musicCode: '01001', attemptId: 'attempt-1' }, pending: [] }
    }
    state.control.setSnapshot(snapshot)
    return { outcome: 'confirmed', operationId: value.operationId, attemptId: 'attempt-1', snapshot }
  }
  const reply = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), request) as any
  assert.deepEqual(state.control.requests, [request])
  assert.equal(reply.operationId, 'intent-1')
  assert.equal(reply.outcome, 'confirmed')
  assert.equal(reply.attemptId, 'attempt-1')
  assert.equal(reply.envelope.revision, 1)
  assert.equal(reply.envelope.snapshot.state.current.musicCode, '01001')
})

test('command replies never borrow an attemptId from unrelated current playback', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const playing: StandalonePlayerSnapshot = {
    playbackCondition: 'ready',
    state: { operationalState: 'playing', current: { entryId: 'current', musicCode: '01001', attemptId: 'active-attempt' }, pending: [] }
  }
  state.control.setSnapshot(playing)
  state.control.executeHandler = async request => ({ outcome: 'confirmed', operationId: request.operationId, snapshot: playing })
  const queued = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), {
    operationId: 'queued-intent', command: { type: 'submit-code', enteredCode: '1002', priority: 'normal' }
  }) as any
  assert.equal(queued.attemptId, undefined, 'a queue admission does not claim the already-playing attempt')

  state.control.executeHandler = async request => ({
    outcome: 'rejected', operationId: request.operationId, error: { code: 'INVALID_STATE' }, snapshot: playing
  })
  const rejected = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), {
    operationId: 'rejected-intent', command: { type: 'restart' }
  }) as any
  assert.equal(rejected.attemptId, undefined, 'a rejected intent does not claim the active attempt')
})

test('Main rejects a mismatched operationId from the control boundary instead of miscorrelating the response', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  state.control.executeHandler = async request => ({
    outcome: 'confirmed', operationId: `${request.operationId}-wrong`, snapshot: state.control.snapshot
  })
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), {
    operationId: 'correlation', command: { type: 'next' }
  }), /STANDALONE_IPC_INVALID_RESPONSE/)
})

test('blocked, uncertain, and rejected results preserve explicit outcome and error code', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const idle = createInitialStandalonePlayerSnapshot().state
  const blocked: StandalonePlayerSnapshot = { playbackCondition: 'blocked', lastConfirmedState: idle, pending: [], error: { code: 'PLAYBACK_FAILED' } }
  const uncertain: StandalonePlayerSnapshot = { playbackCondition: 'uncertain', lastConfirmedState: idle, pending: [], error: { code: 'COMMAND_TIMEOUT' } }
  const cases = [
    { outcome: 'blocked', snapshot: blocked },
    { outcome: 'uncertain', snapshot: uncertain },
    { outcome: 'rejected', error: { code: 'INVALID_MUSIC_CODE' }, snapshot: createInitialStandalonePlayerSnapshot() }
  ] as const
  for (const [index, expected] of cases.entries()) {
    state.control.executeHandler = async request => ({ ...expected, operationId: request.operationId }) as StandalonePlayerCommandResult
    const reply = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), {
      operationId: `outcome-${index}`, command: { type: 'next' }
    }) as any
    assert.equal(reply.outcome, expected.outcome)
    assert.equal(reply.error.code, expected.outcome === 'rejected' ? 'INVALID_MUSIC_CODE' : expected.snapshot.error.code)
    assert.equal(reply.envelope.snapshot.playbackCondition, 'ready', 'the response envelope is the latest authoritative state, separate from operation outcome')
  }
})

test('subscription handshake returns initial state, versions updates, and removes only its own generation', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const subscription = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.subscribe, state.event(), { subscriptionId: 'sp-1' }) as any
  assert.equal(subscription.envelope.revision, 0)
  assert.equal(subscription.envelope.snapshot.state.operationalState, 'idle')

  state.control.setSnapshot({ playbackCondition: 'blocked', lastConfirmedState: createInitialStandalonePlayerSnapshot().state,
    pending: [], error: { code: 'PLAYBACK_FAILED' } })
  assert.equal(state.webContents.sent.length, 1)
  assert.equal((state.webContents.sent[0].value as any).envelope.revision, 1)
  const oldRef = subscription.subscription
  assert.equal(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.unsubscribe, state.event(), oldRef), true)

  const nextSubscription = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.subscribe, state.event(), { subscriptionId: 'sp-1' }) as any
  assert.ok(nextSubscription.subscription.generation > oldRef.generation)
  assert.equal(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.unsubscribe, state.event(), oldRef), false)
  state.control.setSnapshot(createInitialStandalonePlayerSnapshot())
  assert.equal(state.webContents.sent.length, 2, 'stale unsubscribe cannot remove the new generation')
  assert.equal((state.webContents.sent[1].value as any).generation, nextSubscription.subscription.generation)
})

test('main-frame reload, Renderer crash, and WebContents destruction clear subscriptions without disposing control', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const subscription = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.subscribe, state.event(), { subscriptionId: 'sp-1' }) as any
  state.webContents.navigate()
  state.control.setSnapshot(createInitialStandalonePlayerSnapshot())
  assert.equal(state.webContents.sent.length, 0)
  assert.equal(state.control.listeners.size, 1, 'navigation removes client subscriptions but keeps the bridge runtime listener')

  const reloaded = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.subscribe, state.event(), { subscriptionId: 'sp-1' }) as any
  assert.ok(reloaded.envelope.revision > subscription.envelope.revision)
  assert.ok(reloaded.subscription.generation > subscription.subscription.generation)
  state.webContents.crash()
  state.control.setSnapshot(createInitialStandalonePlayerSnapshot())
  assert.equal(state.webContents.sent.length, 0)
  assert.equal(state.control.listeners.size, 1)
  state.webContents.destroy()
  assert.equal(state.control.listeners.size, 0, 'destroying the owned WebContents disposes only the bridge transport')
  assert.equal(state.ipcMain.handlers.size, 0)
  assert.equal(state.control.executeHandler !== undefined, true, 'the bridge does not dispose the runtime')
})

test('distinct IPC commands are not serialized by the bridge and delayed replies retain their own IDs', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  let releaseFirst!: () => void
  let firstStarted!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const firstStartedPromise = new Promise<void>(resolve => { firstStarted = resolve })
  state.control.executeHandler = async request => {
    if (request.operationId === 'first') {
      firstStarted()
      await firstGate
    }
    const snapshot: StandalonePlayerSnapshot = {
      playbackCondition: 'ready',
      state: {
        operationalState: request.operationId === 'second' ? 'playing' : 'paused',
        current: { entryId: 'entry', musicCode: '01001', attemptId: request.operationId },
        pending: []
      }
    }
    state.control.setSnapshot(snapshot)
    return { outcome: 'confirmed', operationId: request.operationId, snapshot }
  }
  const first = state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), { operationId: 'first', command: { type: 'next' } })
  await firstStartedPromise
  const second = state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), { operationId: 'second', command: { type: 'restart' } })
  const secondReply = await second as any
  assert.equal(secondReply.operationId, 'second', 'the later independent operation may return first')
  assert.equal(secondReply.envelope.revision, 1)
  releaseFirst()
  const firstReply = await first as any
  assert.equal(firstReply.operationId, 'first')
  assert.equal(firstReply.envelope.revision, 2)
})

test('destroying Renderer disposes transport but does not cancel its admitted runtime command', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  let started!: () => void
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  state.control.executeHandler = async request => {
    started()
    await gate
    const snapshot: StandalonePlayerSnapshot = {
      playbackCondition: 'ready',
      state: { operationalState: 'playing', current: { entryId: 'late', musicCode: '01001', attemptId: 'late-attempt' }, pending: [] }
    }
    state.control.setSnapshot(snapshot)
    return { outcome: 'confirmed', operationId: request.operationId, attemptId: 'late-attempt', snapshot }
  }
  const pending = state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), {
    operationId: 'in-flight', command: { type: 'next' }
  })
  await startedPromise
  state.webContents.destroy()
  finish()
  await assert.rejects(pending, /STANDALONE_IPC_DISPOSED/,
    'a destroyed Renderer cannot receive an ACK containing an envelope that transport no longer observes')
  assert.equal(state.control.snapshot.playbackCondition, 'ready')
  assert.equal((state.control.snapshot as any).state.current.attemptId, 'late-attempt',
    'the admitted operation still completed in the authoritative runtime')
  assert.equal(state.control.listeners.size, 0, 'WebContents destruction releases the bridge listener')
  assert.equal(state.ipcMain.handlers.size, 0, 'WebContents destruction removes globally registered IPC handlers')
  state.bridge.dispose()
  assert.equal(state.control.executeHandler !== undefined, true, 'bridge never disposes or replaces the runtime')
})

test('bridge shutdown removes every handler and listener but does not mutate sequence state', async () => {
  const state = setup()
  assert.equal(state.ipcMain.handlers.size, 4)
  assert.equal(state.control.listeners.size, 1)
  state.bridge.dispose()
  assert.equal(state.ipcMain.handlers.size, 0)
  assert.equal(state.control.listeners.size, 0)
  assert.equal(state.control.snapshot.playbackCondition, 'ready')
})

test('bridge shutdown during an admitted operation removes transport ownership without canceling the command', async () => {
  const state = setup()
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  state.control.executeHandler = async request => {
    started()
    await gate
    const snapshot: StandalonePlayerSnapshot = {
      playbackCondition: 'ready',
      state: { operationalState: 'playing', current: { entryId: 'late', musicCode: '01001', attemptId: 'late-attempt' }, pending: [] }
    }
    state.control.setSnapshot(snapshot)
    return { outcome: 'confirmed', operationId: request.operationId, attemptId: 'late-attempt', snapshot }
  }
  const pending = state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), {
    operationId: 'shutdown-pending', command: { type: 'next' }
  })
  await startedPromise
  state.bridge.dispose()
  assert.equal(state.ipcMain.handlers.size, 0)
  assert.equal(state.control.listeners.size, 0)
  release()
  await assert.rejects(pending, /STANDALONE_IPC_DISPOSED/,
    'a command finishing after transport disposal cannot return a stale cached snapshot')
  assert.equal(state.control.snapshot.playbackCondition, 'ready')
  assert.equal((state.control.snapshot as any).state.current.attemptId, 'late-attempt',
    'bridge shutdown does not cancel or roll back the already-admitted runtime operation')
})

test('partial IPC handler registration rolls back only handlers owned by the failed bridge', () => {
  const ipcMain = new FakeIpcMain()
  const preexisting = () => 'other owner'
  ipcMain.handlers.set(STANDALONE_PLAYER_IPC_CHANNELS.subscribe, preexisting)
  const webContents = new FakeWebContents(documentUrl)
  const control = new FakeControl()
  assert.throws(() => installStandalonePlayerMainIpcBridge({
    ipcMain: ipcMain as unknown as IpcMain,
    webContents: webContents as unknown as WebContents,
    expectedDocumentUrl: documentUrl,
    control
  }), /duplicate IPC handler/)
  assert.equal(ipcMain.handlers.size, 1)
  assert.equal(ipcMain.handlers.get(STANDALONE_PLAYER_IPC_CHANNELS.subscribe), preexisting,
    'rollback leaves the colliding channel owner untouched')
  assert.equal(control.listeners.size, 0, 'failed installation releases its runtime listener')
  assert.equal(webContents.listenerCount('did-start-navigation'), 0)
  assert.equal(webContents.listenerCount('render-process-gone'), 0)
  assert.equal(webContents.listenerCount('destroyed'), 0)
})

test('a Renderer has a bounded number of active subscriptions', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const subscriptions = []
  for (let index = 1; index <= 8; index++) {
    subscriptions.push(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.subscribe, state.event(), {
      subscriptionId: `sp-${index}`
    }) as any)
  }
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.subscribe, state.event(), {
    subscriptionId: 'sp-9'
  }), /STANDALONE_IPC_SUBSCRIPTION_LIMIT/)
  assert.equal(state.webContents.sent.length, 0)
  assert.equal(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.unsubscribe, state.event(), subscriptions[0].subscription), true)
  assert.ok(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.subscribe, state.event(), { subscriptionId: 'sp-9' }))
})
