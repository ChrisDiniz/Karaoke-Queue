import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import {
  createInitialStandalonePlayerSnapshot,
  STANDALONE_CELEBRATION_MESSAGES,
  type StandalonePlayerCommandRequest,
  type StandalonePlayerCommandResult,
  type StandalonePlayerControl,
  type StandalonePlayerListener,
  type StandalonePlayerSnapshot
} from '../src/standalone-player-contracts'
import {
  isNewerStandalonePlayerOptionsSnapshot,
  STANDALONE_PLAYER_IPC_CHANNELS
} from '../src/standalone-player-ipc-contracts'
import type { StandalonePlayerOptionsData, StandalonePlayerOptionsMainPort } from '../src/standalone-player-ipc-contracts'
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

function setup(
  metadataCatalog?: Parameters<typeof installStandalonePlayerMainIpcBridge>[0]['metadataCatalog'],
  optionsPort?: StandalonePlayerOptionsMainPort,
  showExitFallbackDialog: () => Promise<boolean> = async () => false
) {
  const ipcMain = new FakeIpcMain()
  const webContents = new FakeWebContents(documentUrl)
  const control = new FakeControl()
  const bridge = installStandalonePlayerMainIpcBridge({
    ipcMain: ipcMain as unknown as IpcMain,
    webContents: webContents as unknown as WebContents,
    expectedDocumentUrl: documentUrl,
    control,
    showExitFallbackDialog,
    ...(metadataCatalog ? { metadataCatalog } : {}),
    ...(optionsPort ? { options: optionsPort } : {})
  })
  const event = (sender: WebContents = webContents.sender(), frame: { url: string } = webContents.mainFrame) => ({
    sender,
    senderFrame: frame
  }) as IpcMainInvokeEvent
  return { ipcMain, webContents, control, bridge, event }
}

test('exit IPC validates origin and payload, coalesces requests, and settles only the current Main request', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const requestChannel = STANDALONE_PLAYER_IPC_CHANNELS.requestExitConfirmation
  const resolveChannel = STANDALONE_PLAYER_IPC_CHANNELS.resolveExitConfirmation

  await assert.rejects(state.ipcMain.invoke(requestChannel, state.event(), 'unexpected'), /STANDALONE_IPC_INVALID_REQUEST/)
  await assert.rejects(state.ipcMain.invoke(resolveChannel, state.event(), null), /STANDALONE_IPC_INVALID_REQUEST/)
  await assert.rejects(state.ipcMain.invoke(resolveChannel, state.event(), {
    requestId: 'not-a-uuid', decision: 'confirm'
  }), /STANDALONE_IPC_INVALID_REQUEST/)
  await assert.rejects(state.ipcMain.invoke(resolveChannel, state.event(), {
    requestId: '6f9f39e0-cae0-40f8-a877-e4a2fc53c99a', decision: 'confirm', extra: true
  }), /STANDALONE_IPC_INVALID_REQUEST/)

  const foreign = new FakeWebContents(documentUrl)
  await assert.rejects(state.ipcMain.invoke(requestChannel, state.event(foreign.sender())), /STANDALONE_IPC_FORBIDDEN/)
  await assert.rejects(state.ipcMain.invoke(resolveChannel, state.event(foreign.sender()), {
    requestId: '6f9f39e0-cae0-40f8-a877-e4a2fc53c99a', decision: 'confirm'
  }), /STANDALONE_IPC_FORBIDDEN/)
  foreign.destroy()
  await assert.rejects(state.ipcMain.invoke(requestChannel, state.event(state.webContents.sender(), { url: 'file:///child.html' })),
    /STANDALONE_IPC_FORBIDDEN/)

  const firstMainRequest = state.bridge.requestExitConfirmationFromMain()
  const secondMainRequest = state.bridge.requestExitConfirmationFromMain()
  const requestEvent = state.webContents.sent.at(-1)
  assert.equal(requestEvent?.channel, STANDALONE_PLAYER_IPC_CHANNELS.exitConfirmationRequested)
  const requestId = (requestEvent?.value as { requestId: string }).requestId
  assert.match(requestId, /^[0-9a-f-]{36}$/)
  assert.equal(state.webContents.sent.filter(item => item.channel === requestEvent?.channel).length, 1,
    'simultaneous Main requests send one confirmation to the Renderer')

  const rendererRequest = await state.ipcMain.invoke(requestChannel, state.event()) as { outcome: string; requestId: string }
  assert.deepEqual(rendererRequest, { outcome: 'pending', requestId },
    'a Renderer-originated request joins the already pending Main request')
  const confirmed = await state.ipcMain.invoke(resolveChannel, state.event(), { requestId, decision: 'confirm' })
  assert.deepEqual(confirmed, { requestId, outcome: 'confirmed' })
  assert.deepEqual(await state.ipcMain.invoke(resolveChannel, state.event(), { requestId, decision: 'confirm' }), confirmed,
    'duplicate confirmation is idempotent')
  assert.deepEqual(await Promise.all([firstMainRequest, secondMainRequest]), [true, true])
  assert.deepEqual(await state.ipcMain.invoke(requestChannel, state.event()), { outcome: 'authorized' },
    'no later Renderer request can reenter after authorization')
  assert.equal(await state.bridge.requestExitConfirmationFromMain(), true,
    'repeated Main requests reuse the one authorization without another prompt')
  assert.equal(state.webContents.sent.filter(item => item.channel === requestEvent?.channel).length, 1)
})

test('exit IPC rejects delayed settlement after cancel and keeps later requests independent', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const requestChannel = STANDALONE_PLAYER_IPC_CHANNELS.requestExitConfirmation
  const resolveChannel = STANDALONE_PLAYER_IPC_CHANNELS.resolveExitConfirmation
  const first = await state.ipcMain.invoke(requestChannel, state.event()) as { requestId: string }
  assert.deepEqual(await state.ipcMain.invoke(resolveChannel, state.event(), {
    requestId: first.requestId, decision: 'cancel'
  }), { requestId: first.requestId, outcome: 'cancelled' })
  assert.deepEqual(await state.ipcMain.invoke(resolveChannel, state.event(), {
    requestId: first.requestId, decision: 'confirm'
  }), { requestId: first.requestId, outcome: 'cancelled' }, 'a duplicate delayed response cannot reverse cancellation')

  const second = await state.ipcMain.invoke(requestChannel, state.event()) as { requestId: string }
  assert.notEqual(second.requestId, first.requestId)
  assert.deepEqual(await state.ipcMain.invoke(resolveChannel, state.event(), {
    requestId: first.requestId, decision: 'confirm'
  }), { requestId: first.requestId, outcome: 'cancelled' },
  'a delayed response from a settled request cannot mutate the new request')
  assert.deepEqual(await state.ipcMain.invoke(resolveChannel, state.event(), {
    requestId: second.requestId, decision: 'confirm'
  }), { requestId: second.requestId, outcome: 'confirmed' })
})

test('Renderer confirmation notifies Main exactly once without performing shutdown', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  let notifications = 0
  const unsubscribe = state.bridge.onExitAuthorized(() => { notifications++ })
  t.after(unsubscribe)
  const requestChannel = STANDALONE_PLAYER_IPC_CHANNELS.requestExitConfirmation
  const resolveChannel = STANDALONE_PLAYER_IPC_CHANNELS.resolveExitConfirmation

  const cancelled = await state.ipcMain.invoke(requestChannel, state.event()) as { requestId: string }
  await state.ipcMain.invoke(resolveChannel, state.event(), { requestId: cancelled.requestId, decision: 'cancel' })
  assert.equal(notifications, 0, 'cancellation does not authorize or notify Main')

  const confirmed = await state.ipcMain.invoke(requestChannel, state.event()) as { requestId: string }
  assert.deepEqual(await state.ipcMain.invoke(resolveChannel, state.event(), {
    requestId: confirmed.requestId, decision: 'confirm'
  }), { requestId: confirmed.requestId, outcome: 'confirmed' })
  await state.ipcMain.invoke(resolveChannel, state.event(), { requestId: confirmed.requestId, decision: 'confirm' })
  await state.ipcMain.invoke(resolveChannel, state.event(), { requestId: confirmed.requestId, decision: 'cancel' })
  assert.equal(notifications, 1, 'only the first Renderer-originated confirmation notifies Main')
  assert.equal(state.webContents.isDestroyed(), false, 'authorization does not close the application in C9.3')
})

test('Main uses one native fallback when the Renderer is unavailable or disappears during confirmation', async t => {
  let fallbackCalls = 0
  let fallbackResult = true
  const state = setup(undefined, undefined, async () => { fallbackCalls++; return fallbackResult })
  t.after(() => state.bridge.dispose())

  state.webContents.crash()
  assert.equal(await state.bridge.requestExitConfirmationFromMain(), true)
  assert.equal(fallbackCalls, 1, 'an unavailable Renderer uses the explicit fallback once')
  assert.equal(state.webContents.sent.some(item => item.channel === STANDALONE_PLAYER_IPC_CHANNELS.exitConfirmationRequested), false)

  const cancelledState = setup(undefined, undefined, async () => { fallbackCalls++; return false })
  t.after(() => cancelledState.bridge.dispose())
  cancelledState.webContents.crash()
  assert.equal(await cancelledState.bridge.requestExitConfirmationFromMain(), false,
    'choosing Cancel in the native fallback does not authorize exit')

  let finishFallback!: (confirmed: boolean) => void
  let notifyFallbackStarted!: () => void
  const fallbackStarted = new Promise<void>(resolve => { notifyFallbackStarted = resolve })
  const recoveredState = setup(undefined, undefined, () => {
    fallbackCalls++
    notifyFallbackStarted()
    return new Promise<boolean>(resolve => { finishFallback = resolve })
  })
  t.after(() => recoveredState.bridge.dispose())
  const pending = recoveredState.bridge.requestExitConfirmationFromMain()
  assert.equal(recoveredState.webContents.sent.at(-1)?.channel, STANDALONE_PLAYER_IPC_CHANNELS.exitConfirmationRequested)
  recoveredState.webContents.crash()
  await fallbackStarted
  assert.equal(fallbackCalls, 3, 'a Renderer crash switches the same pending confirmation to native fallback')
  finishFallback(true)
  assert.equal(await pending, true)
})

test('Renderer loss during its own pending exit request falls back and notifies Main only after confirmation', async t => {
  let fallbackStarted!: () => void
  const started = new Promise<void>(resolve => { fallbackStarted = resolve })
  let settleFallback!: (confirmed: boolean) => void
  const state = setup(undefined, undefined, () => {
    fallbackStarted()
    return new Promise<boolean>(resolve => { settleFallback = resolve })
  })
  t.after(() => state.bridge.dispose())
  let notifications = 0
  let authorized!: () => void
  const authorization = new Promise<void>(resolve => { authorized = resolve })
  const unsubscribe = state.bridge.onExitAuthorized(() => { notifications++; authorized() })
  t.after(unsubscribe)

  const request = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.requestExitConfirmation, state.event()) as { requestId: string }
  state.webContents.crash()
  await started
  assert.equal(notifications, 0, 'Main is not notified while the native fallback is still awaiting a decision')
  settleFallback(true)
  await authorization
  assert.equal(notifications, 1, 'a confirmed native fallback authorizes the pending Renderer-originated request once')
  assert.deepEqual(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.resolveExitConfirmation, state.event(), {
    requestId: request.requestId, decision: 'confirm'
  }), { requestId: request.requestId, outcome: 'already-authorized' }, 'a delayed Renderer reply cannot reenter after fallback approval')
  assert.equal(await state.bridge.requestExitConfirmationFromMain(), true)
  assert.equal(notifications, 1)
})

test('shutdown admission drains accepted IPC work and rejects later non-exit requests', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  let release!: (result: StandalonePlayerCommandResult) => void
  let started!: () => void
  const commandStarted = new Promise<void>(resolve => { started = resolve })
  state.control.executeHandler = request => {
    started()
    return new Promise(resolve => { release = resolve })
  }
  const command = state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), {
    operationId: 'shutdown-drain-1', command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' }
  })
  await commandStarted

  let drained = false
  const draining = state.bridge.beginCloseAdmission().then(() => { drained = true })
  await assert.rejects(
    state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, state.event()),
    /STANDALONE_IPC_CLOSING/
  )
  assert.equal(drained, false, 'shutdown waits for a command that entered before admission closed')

  release({ outcome: 'confirmed', operationId: 'shutdown-drain-1', snapshot: state.control.snapshot })
  await command
  await draining
  assert.equal(drained, true, 'the drain resolves after accepted IPC work settles')

  const exitRequest = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.requestExitConfirmation, state.event())
  assert.equal((exitRequest as { outcome: string }).outcome, 'pending',
    'the exit confirmation channel remains available for a safe retry after shutdown failure')
})

function fakeOptionsPort(overrides: Partial<StandalonePlayerOptionsMainPort> = {}) {
  let snapshot: StandalonePlayerOptionsData = {
    library: { folderName: 'videos', scanStatus: 'ready', indexedFiles: 1 },
    catalog: { fileName: null, recordCount: 0, importedAt: null, revision: null, importIssueCount: 0, importGeneration: 0 }
  }
  const calls = { chooseVideoFolder: 0, applyVideoFolder: [] as string[], refreshVideoLibrary: 0,
    chooseCatalogFile: 0, importCatalogFile: [] as string[] }
  const listeners = new Set<(value: StandalonePlayerOptionsData) => void>()
  const port: StandalonePlayerOptionsMainPort = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    chooseVideoFolder: async () => { calls.chooseVideoFolder++; return '/selected/library' },
    applyVideoFolder: async value => { calls.applyVideoFolder.push(value); snapshot = {
      library: { folderName: 'library', scanStatus: 'ready', indexedFiles: 3 }, catalog: snapshot.catalog
    }; listeners.forEach(listener => listener(snapshot)) },
    refreshVideoLibrary: async () => { calls.refreshVideoLibrary++ },
    chooseCatalogFile: async () => { calls.chooseCatalogFile++; return '/selected/catalog.csv' },
    prepareCatalogImport: async value => {
      calls.importCatalogFile.push(value)
      return { outcome: 'imported' }
    },
    confirmCatalogImport: async () => undefined,
    cancelCatalogImport: () => false,
    getCatalogImportIssuesPage: (_revision, generation, offset, limit) => ({
      catalogRevision: snapshot.catalog.revision, generation, total: 0, offset, issues: []
    }),
    ...overrides
  }
  return {
    port,
    calls,
    setSnapshot: (value: StandalonePlayerOptionsData) => {
      snapshot = value
      listeners.forEach(listener => listener(snapshot))
    }
  }
}

test('metadata preview IPC validates exact digit payloads, sender origin, and the minimal response DTO', async t => {
  const revisions = new Set<(revision: string | null) => void>()
  const lookups: unknown[] = []
  const catalog = {
    getMetadata: () => ({ revision: 'catalog-r1' }),
    lookupMetadataByVideoCode: (value: unknown) => {
      lookups.push(value)
      const match = value === '1001' || value === '01001'
      return { catalogRevision: 'catalog-r1', title: match ? 'Always' : null, artist: match ? 'Bon Jovi' : null }
    },
    subscribeToMetadataRevision: (listener: (revision: string | null) => void) => {
      revisions.add(listener)
      return () => revisions.delete(listener)
    }
  }
  const state = setup(catalog)
  t.after(() => state.bridge.dispose())
  assert.deepEqual(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.lookupMetadata, state.event(), '1001'), {
    catalogRevision: 'catalog-r1', title: 'Always', artist: 'Bon Jovi'
  })
  assert.deepEqual(lookups, ['1001'])
  for (const invalid of [null, {}, '', '123456', '12x', 1001]) {
    await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.lookupMetadata, state.event(), invalid),
      /STANDALONE_IPC_INVALID_REQUEST/)
  }
  assert.deepEqual(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.lookupMetadata, state.event(), '01001'), {
    catalogRevision: 'catalog-r1', title: 'Always', artist: 'Bon Jovi'
  }, 'a canonical five-digit code is an exact catalog match')
  assert.deepEqual(lookups, ['1001', '01001'], 'invalid payloads do not reach catalog lookup')

  const foreign = new FakeWebContents(documentUrl)
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.lookupMetadata,
    state.event(foreign.sender()), '1001'), /STANDALONE_IPC_FORBIDDEN/)
  foreign.destroy()
  revisions.forEach(listener => listener('catalog-r2'))
  assert.deepEqual(state.webContents.sent.at(-1), {
    channel: STANDALONE_PLAYER_IPC_CHANNELS.catalogRevisionChanged,
    value: { catalogRevision: 'catalog-r2' }
  })
  state.webContents.navigate('file:///untrusted.html')
  revisions.forEach(listener => listener('catalog-r3'))
  assert.equal(state.webContents.sent.length, 1, 'catalog revisions are not sent to a navigated document')
  state.bridge.dispose()
  assert.equal(revisions.size, 0, 'disposing the bridge removes its catalog revision listener')
})

test('metadata preview IPC exposes no arbitrary catalog fields and supports an absent catalog', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  assert.deepEqual(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.lookupMetadata, state.event(), '1001'), {
    catalogRevision: null, title: null, artist: null
  })
  state.bridge.dispose()

  const invalidCatalog = {
    getMetadata: () => ({ revision: 'r1' }),
    lookupMetadataByVideoCode: () => ({ catalogRevision: 'r1', title: 'x', artist: null, filePath: '/secret' }),
    subscribeToMetadataRevision: () => () => undefined
  }
  const malformed = setup(invalidCatalog)
  t.after(() => malformed.bridge.dispose())
  await assert.rejects(malformed.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.lookupMetadata, malformed.event(), '1001'),
    /STANDALONE_IPC_INVALID_RESPONSE/)
})

test('current-track metadata IPC binds the lookup to the confirmed Main attempt and exposes only its DTO', async t => {
  const lookups: unknown[] = []
  const catalog = {
    lookupMetadataByVideoCode: (value: unknown) => {
      lookups.push(value)
      return { catalogRevision: 'catalog-r1', title: 'Always', artist: 'Bon Jovi' }
    },
    subscribeToMetadataRevision: () => () => undefined
  }
  const state = setup(catalog)
  t.after(() => state.bridge.dispose())
  const activeEntry = { entryId: 'entry-1', attemptId: 'attempt-1', musicCode: '01001' }
  const pendingEntry = { entryId: 'queued', musicCode: '02002' }
  const playing: StandalonePlayerSnapshot = {
    playbackCondition: 'ready',
    state: {
      operationalState: 'playing',
      current: activeEntry,
      pending: [pendingEntry]
    }
  }
  state.control.setSnapshot(playing)
  assert.deepEqual(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getCurrentTrackMetadata, state.event()), {
    catalogRevision: 'catalog-r1', title: 'Always', artist: 'Bon Jovi',
    entryId: 'entry-1', attemptId: 'attempt-1', musicCode: '01001'
  })
  assert.deepEqual(lookups, ['01001'], 'Main obtains the canonical current code and never accepts a renderer-selected code.')

  state.control.setSnapshot({
    playbackCondition: 'ready',
    state: { operationalState: 'paused', current: activeEntry, pending: [pendingEntry] }
  })
  assert.equal((await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getCurrentTrackMetadata, state.event()) as any).attemptId,
    'attempt-1', 'paused playback remains a confirmed current track.')

  const foreign = new FakeWebContents(documentUrl)
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getCurrentTrackMetadata,
    state.event(foreign.sender())), /STANDALONE_IPC_FORBIDDEN/)
  foreign.destroy()
  for (const invalid of ['01001', null, { musicCode: '01001' }]) {
    await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getCurrentTrackMetadata,
      state.event(), invalid), /STANDALONE_IPC_INVALID_REQUEST/)
  }
})

test('current-track metadata is unavailable outside ready playing or paused state, including idle and transitions', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const idle = createInitialStandalonePlayerSnapshot().state
  const current = { entryId: 'entry-1', attemptId: 'attempt-1', musicCode: '01001' }
  const target = { entryId: 'entry-2', musicCode: '02002' }
  const cases: StandalonePlayerSnapshot[] = [
    createInitialStandalonePlayerSnapshot(),
    { playbackCondition: 'transitioning', phase: 'countdown', lastConfirmedState: idle,
      pending: [target], target, remainingMs: 3200, paused: false },
    { playbackCondition: 'transitioning', phase: 'loading', lastConfirmedState: idle, pending: [target], target },
    { playbackCondition: 'transitioning', phase: 'celebration', lastConfirmedState: {
      operationalState: 'playing', current, pending: []
    }, pending: [], remainingMs: 3200, paused: false, message: STANDALONE_CELEBRATION_MESSAGES[0] },
    { playbackCondition: 'blocked', lastConfirmedState: { operationalState: 'playing', current, pending: [] },
      pending: [], error: { code: 'PLAYBACK_FAILED' } },
    { playbackCondition: 'uncertain', lastConfirmedState: { operationalState: 'playing', current, pending: [] },
      pending: [], error: { code: 'COMMAND_TIMEOUT' } }
  ]
  for (const snapshot of cases) {
    state.control.setSnapshot(snapshot)
    assert.equal(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getCurrentTrackMetadata, state.event()), null,
      `no confirmed metadata during ${snapshot.playbackCondition}${snapshot.playbackCondition === 'transitioning' ? `/${snapshot.phase}` : ''}`)
  }
})

test('current-track metadata without an optional catalog still returns identity with unavailable fields', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  state.control.setSnapshot({
    playbackCondition: 'ready',
    state: { operationalState: 'playing', current: { entryId: 'entry-1', attemptId: 'attempt-1', musicCode: '01001' }, pending: [] }
  })
  assert.deepEqual(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getCurrentTrackMetadata, state.event()), {
    catalogRevision: null, title: null, artist: null,
    entryId: 'entry-1', attemptId: 'attempt-1', musicCode: '01001'
  })
})

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

test('countdown and loading snapshots preserve only the bounded typed transition target over IPC', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const idle = createInitialStandalonePlayerSnapshot().state
  const target = { entryId: 'transition-entry', musicCode: '01001' }
  state.control.setSnapshot({
    playbackCondition: 'transitioning', phase: 'countdown', lastConfirmedState: idle,
    pending: [target], target, remainingMs: 3210, paused: true
  })
  const countdown = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, state.event()) as any
  assert.equal(countdown.snapshot.phase, 'countdown')
  assert.equal(countdown.snapshot.remainingMs, 3210)
  assert.equal(countdown.snapshot.paused, true)
  assert.deepEqual(countdown.snapshot.target, target)
  countdown.snapshot.target.musicCode = '99999'
  assert.equal(state.control.snapshot.playbackCondition, 'transitioning')
  if (state.control.snapshot.playbackCondition === 'transitioning' && state.control.snapshot.phase === 'countdown') {
    assert.equal(state.control.snapshot.target.musicCode, '01001')
  }

  state.control.setSnapshot({
    playbackCondition: 'transitioning', phase: 'loading', lastConfirmedState: idle,
    pending: [target], target
  })
  const loading = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, state.event()) as any
  assert.equal(loading.snapshot.phase, 'loading')
  assert.deepEqual(loading.snapshot.target, target)
  assert.equal(Object.hasOwn(loading.snapshot, 'remainingMs'), false)
})

test('celebration snapshots preserve the Main-selected random message and timer state over IPC', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const idle = createInitialStandalonePlayerSnapshot().state
  const message = STANDALONE_CELEBRATION_MESSAGES[39]
  state.control.setSnapshot({
    playbackCondition: 'transitioning',
    phase: 'celebration',
    lastConfirmedState: idle,
    pending: [],
    remainingMs: 2345,
    paused: true,
    message
  })
  const response = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, state.event()) as any
  assert.deepEqual(response.snapshot, {
    playbackCondition: 'transitioning', phase: 'celebration', lastConfirmedState: idle, pending: [],
    remainingMs: 2345, paused: true, message
  })
  response.snapshot.message = 'altered by renderer'
  const second = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, state.event()) as any
  assert.equal(second.snapshot.message, message, 'the renderer receives a clone and cannot change the authoritative selected message.')
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
    { operationId: 'ok', command: { type: 'stop-all', extra: true } },
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

test('the exact C5 Stop All DTO is authorized and preserves its operationId through IPC', async t => {
  const state = setup()
  t.after(() => state.bridge.dispose())
  const request = { operationId: 'c5-stop-all', command: { type: 'stop-all' } } as const
  const reply = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), request) as any
  assert.deepEqual(state.control.requests, [request])
  assert.equal(reply.outcome, 'confirmed')
  assert.equal(reply.operationId, request.operationId)
  assert.equal(reply.envelope.snapshot.state.operationalState, 'idle')
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
  assert.equal(state.ipcMain.handlers.size, 10,
    'the bridge also registers the restricted C9 exit-confirmation and playback-surface channels.')
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

test('Standalone Options IPC exposes pathless snapshots and rejects malformed or foreign calls', async t => {
  const options = fakeOptionsPort()
  const state = setup(undefined, options.port)
  t.after(() => state.bridge.dispose())
  assert.deepEqual(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getOptionsSnapshot, state.event()), {
    ...options.port.getSnapshot(), revision: 0
  })
  options.setSnapshot({
    library: { folderName: 'new-videos', scanStatus: 'ready', indexedFiles: 2 },
    catalog: { fileName: null, recordCount: 0, importedAt: null, revision: null, importIssueCount: 0, importGeneration: 0 }
  })
  assert.deepEqual(state.webContents.sent.at(-1), {
    channel: STANDALONE_PLAYER_IPC_CHANNELS.optionsChanged,
    value: { ...options.port.getSnapshot(), revision: 1 }
  }, 'Main attaches a monotonic revision to every pushed options update.')
  assert.deepEqual(await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getOptionsSnapshot, state.event()), {
    ...options.port.getSnapshot(), revision: 1
  })
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.selectVideoFolder, state.event(), '/renderer/path'),
    /STANDALONE_IPC_INVALID_REQUEST/)
  const foreign = new FakeWebContents(documentUrl)
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getOptionsSnapshot,
    state.event(foreign.sender())), /STANDALONE_IPC_FORBIDDEN/)
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.importMusicCatalog,
    state.event(foreign.sender())), /STANDALONE_IPC_FORBIDDEN/)
  foreign.destroy()
  assert.deepEqual(options.calls, {
    chooseVideoFolder: 0, applyVideoFolder: [], refreshVideoLibrary: 0, chooseCatalogFile: 0, importCatalogFile: []
  }, 'invalid and unauthorized invocations never reach native dialogs or services.')
})

test('folder selection is Main-guarded and revalidated after its asynchronous native dialog', async t => {
  let releaseSelection!: (value: string | null) => void
  let announceSelection!: () => void
  const selection = new Promise<string | null>(resolve => { releaseSelection = resolve })
  const selectionStarted = new Promise<void>(resolve => { announceSelection = resolve })
  let dialogCalls = 0
  const applied: string[] = []
  const options = fakeOptionsPort({
    chooseVideoFolder: async () => { dialogCalls++; announceSelection(); return selection },
    applyVideoFolder: async value => { applied.push(value) }
  })
  const state = setup(undefined, options.port)
  t.after(() => state.bridge.dispose())

  const pendingSelection = state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.selectVideoFolder, state.event()) as Promise<any>
  await selectionStarted
  const duplicate = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.selectVideoFolder, state.event()) as any
  assert.deepEqual({ outcome: duplicate.outcome, code: duplicate.code }, { outcome: 'blocked', code: 'LIBRARY_BUSY' })

  const command = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.execute, state.event(), {
    operationId: 'while-folder-dialog-open', command: { type: 'next' }
  }) as any
  assert.equal(command.outcome, 'rejected')
  assert.equal(command.error.code, 'INVALID_STATE')
  assert.equal(state.control.requests.length, 0, 'player commands cannot race a library replacement.')

  state.control.setSnapshot({ playbackCondition: 'ready', state: {
    operationalState: 'playing', current: { entryId: 'current', attemptId: 'attempt', musicCode: '01001' }, pending: []
  } })
  releaseSelection('/selected/library')
  const result = await pendingSelection
  assert.deepEqual({ outcome: result.outcome, code: result.code }, { outcome: 'blocked', code: 'PLAYER_NOT_IDLE' })
  assert.equal(dialogCalls, 1, 'rapid repeated selection opens only one native folder picker.')
  assert.deepEqual(applied, [], 'a transition during the dialog prevents persisting or applying the selected root.')
  assert.equal(result.snapshot.library.folderName, 'videos')

})

test('CSV selection remains available during playback and is serialized without changing sequence state', async t => {
  const options = fakeOptionsPort()
  const state = setup(undefined, options.port)
  t.after(() => state.bridge.dispose())
  state.control.setSnapshot({ playbackCondition: 'ready', state: {
    operationalState: 'paused', current: { entryId: 'current', attemptId: 'attempt', musicCode: '01001' }, pending: [
      { entryId: 'pending', musicCode: '01002' }
    ]
  } })
  const before = state.control.getSnapshot()
  const result = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.importMusicCatalog, state.event()) as any
  assert.equal(result.outcome, 'confirmed')
  assert.equal(Number.isSafeInteger(result.snapshot.revision), true)
  assert.deepEqual(options.calls.importCatalogFile, ['/selected/catalog.csv'])
  assert.deepEqual(state.control.getSnapshot(), before, 'CSV import does not mutate the authoritative sequence.')
})

test('partial catalog confirmation is Main-locked and report pages are revision/generation scoped', async t => {
  const token = '123e4567-e89b-12d3-a456-426614174000'
  const revision = 'a'.repeat(64)
  const options = fakeOptionsPort({
    prepareCatalogImport: async value => {
      options.calls.importCatalogFile.push(value)
      return { outcome: 'confirmation-required', token, recordCount: 10, issueCount: 1, currentRecordCount: 4 }
    },
    confirmCatalogImport: async suppliedToken => {
      assert.equal(suppliedToken, token)
      options.setSnapshot({
        ...options.port.getSnapshot(),
        catalog: { fileName: 'partial.csv', recordCount: 10, importedAt: new Date(0).toISOString(),
          revision, importIssueCount: 1, importGeneration: 1 }
      })
    },
    cancelCatalogImport: suppliedToken => suppliedToken === token,
    getCatalogImportIssuesPage: (catalogRevision, generation, offset) => {
      if (catalogRevision !== revision || generation !== 1) throw new Error('CATALOG_REPORT_STALE')
      return {
        catalogRevision, generation, total: 1, offset,
        issues: [{ rowNumber: 135, field: 'numero', value: '78952770', code: 'INVALID_MUSIC_NUMBER',
          reason: 'O código deve conter de 1 a 5 dígitos, sem zero inicial.' }]
      }
    }
  })
  const state = setup(undefined, options.port)
  t.after(() => state.bridge.dispose())

  const prepared = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.importMusicCatalog, state.event()) as any
  assert.equal(prepared.outcome, 'confirmation-required')
  assert.deepEqual(prepared.confirmation, { token, recordCount: 10, issueCount: 1, currentRecordCount: 4 })
  assert.equal(options.calls.importCatalogFile.length, 1)
  const duplicate = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.importMusicCatalog, state.event()) as any
  assert.deepEqual({ outcome: duplicate.outcome, code: duplicate.code }, { outcome: 'blocked', code: 'OPTIONS_BUSY' })

  const confirmed = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.confirmMusicCatalogImport, state.event(), token) as any
  assert.equal(confirmed.outcome, 'confirmed')
  assert.equal(confirmed.snapshot.catalog.importIssueCount, 1)
  const page = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getCatalogImportIssuesPage, state.event(), {
    catalogRevision: revision, generation: 1, offset: 0
  }) as any
  assert.equal(page.issues[0].rowNumber, 135)
  await assert.rejects(state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.getCatalogImportIssuesPage, state.event(), {
    catalogRevision: revision, generation: 0, offset: 0
  }), /CATALOG_REPORT_STALE/)
  const staleConfirmation = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.confirmMusicCatalogImport,
    state.event(), token) as any
  assert.deepEqual({ outcome: staleConfirmation.outcome, code: staleConfirmation.code },
    { outcome: 'failed', code: 'CATALOG_CONFIRMATION_STALE' })
})

test('Renderer accepts only newer options revisions when replies and events arrive out of order', () => {
  const snapshot = (revision: number, folderName: string) => ({
    revision,
    library: { folderName, scanStatus: 'ready' as const, indexedFiles: 1 },
    catalog: { fileName: null, recordCount: 0, importedAt: null, revision: null, importIssueCount: 0, importGeneration: 0 }
  })
  const revision3 = snapshot(3, 'latest')
  assert.equal(isNewerStandalonePlayerOptionsSnapshot(undefined, revision3), true)
  assert.equal(isNewerStandalonePlayerOptionsSnapshot(revision3, snapshot(2, 'stale')), false)
  assert.equal(isNewerStandalonePlayerOptionsSnapshot(revision3, snapshot(3, 'duplicate')), false)
  assert.equal(isNewerStandalonePlayerOptionsSnapshot(revision3, snapshot(4, 'newer')), true)
})

test('library refresh may use its own Main lock but still requires confirmed idle state', async t => {
  const options = fakeOptionsPort()
  const state = setup(undefined, options.port)
  t.after(() => state.bridge.dispose())

  const readyRefresh = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.refreshVideoLibrary, state.event()) as any
  assert.equal(readyRefresh.outcome, 'confirmed')
  assert.equal(options.calls.refreshVideoLibrary, 1)

  state.control.setSnapshot({ playbackCondition: 'ready', state: {
    operationalState: 'playing', current: { entryId: 'current', attemptId: 'attempt', musicCode: '01001' }, pending: []
  } })
  const busyRefresh = await state.ipcMain.invoke(STANDALONE_PLAYER_IPC_CHANNELS.refreshVideoLibrary, state.event()) as any
  assert.deepEqual({ outcome: busyRefresh.outcome, code: busyRefresh.code }, { outcome: 'blocked', code: 'PLAYER_NOT_IDLE' })
  assert.equal(options.calls.refreshVideoLibrary, 1, 'blocked direct IPC cannot start a second scan.')

  const idle = createInitialStandalonePlayerSnapshot().state
  const target = { entryId: 'loading-entry', musicCode: '01001' }
  state.control.setSnapshot({
    playbackCondition: 'transitioning', phase: 'loading', lastConfirmedState: idle,
    pending: [target], target
  })
  const loadingRefresh = await state.ipcMain.invoke(
    STANDALONE_PLAYER_IPC_CHANNELS.refreshVideoLibrary, state.event()) as any
  assert.deepEqual({ outcome: loadingRefresh.outcome, code: loadingRefresh.code },
    { outcome: 'blocked', code: 'PLAYER_NOT_IDLE' }, 'loading is occupied and cannot start a library scan.')
  assert.equal(options.calls.refreshVideoLibrary, 1)
})
