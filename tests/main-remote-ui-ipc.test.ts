import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { registerMainRemoteUiIpcHandlers } from '../src/main-remote-ui-ipc'
import type { MainRemoteRuntime } from '../src/main-remote-runtime'
import type { ManagementPairingUiEvent, PlayerPairingUiEvent, RemoteUiSnapshot } from '../src/remote-ui-contracts'

class FakeIpcMain {
  readonly handlers = new Map<string, (...args: any[]) => any>()
  handle(channel: string, listener: (...args: any[]) => any): void { this.handlers.set(channel, listener) }
  removeHandler(channel: string): void { this.handlers.delete(channel) }
  invoke(channel: string, event: any, ...args: unknown[]): Promise<any> {
    const handler = this.handlers.get(channel)
    if (!handler) return Promise.reject(new Error(`HANDLER_MISSING_${channel}`))
    return Promise.resolve(handler(event, ...args))
  }
}

function createWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (_channel: string, _payload: unknown): void => {}
  })
  return { webContents, isDestroyed: () => false }
}

const snapshot: RemoteUiSnapshot = { revision: 1, role: 'management', intent: 'disabled', listener: 'stopped',
  listenerEndpoint: null, discovery: 'stopped', candidates: [], connections: [], operations: [], savedDevices: [],
  pairingRecoveries: [], pairingStoreStatus: 'available', playerPairing: 'unavailable', errorCode: null }
const candidateId = '12345678-1234-4123-8123-123456789012'

function harness(pair: (presentation: any, signal: AbortSignal) => Promise<any>, options: {
  approved?: boolean
  recover?: (playerId: string, candidateId: string, presentation: any, signal: AbortSignal) => Promise<any>
} = {}) {
  const ipcMain = new FakeIpcMain()
  const managementWindow = createWindow()
  const sent: ManagementPairingUiEvent[] = []
  managementWindow.webContents.send = (_channel: string, payload: unknown) => { sent.push(payload as ManagementPairingUiEvent) }
  let calls = 0
  const purposes: string[] = []
  const recoveries: Array<{ playerId: string; candidateId: string }> = []
  const runtime = {
    subscribeRemoteUi: () => () => undefined,
    getRemoteUiSnapshot: async () => snapshot,
    pairWithDiscoveredCandidate: async (_candidateId: string, presentation: any, signal: AbortSignal, purpose: string) => {
      calls++
      purposes.push(purpose)
      return pair(presentation, signal)
    },
    recoverManagementPairing: async (playerId: string, recoveryCandidateId: string, presentation: any, signal: AbortSignal) => {
      recoveries.push({ playerId, candidateId: recoveryCandidateId })
      if (!options.recover) throw new Error('RECOVERY_NOT_CONFIGURED')
      return options.recover(playerId, recoveryCandidateId, presentation, signal)
    },
    acceptG2PairingUpdate: async () => undefined,
    enableManagementReconnection: async () => undefined,
    getCurrentManagementDiscovery: () => undefined
  } as unknown as MainRemoteRuntime
  const dispose = registerMainRemoteUiIpcHandlers({
    ipcMain: ipcMain as any, mode: 'combined', runtime, getPlayerWindow: () => null,
    getManagementWindow: () => managementWindow as any, assertPlayerSender: () => undefined,
    assertManagementSender: () => undefined, getInterfaceAddresses: () => ['192.168.1.20'],
    getManagementDatabase: () => ({} as any), pairingPresentationApprovedForProduction: options.approved ?? true
  })
  return { ipcMain, managementWindow, sent, dispose, calls: () => calls,
    purposes: () => [...purposes], recoveries: () => [...recoveries] }
}

test('management pairing accepts only the matching request, revision, deadline, and eight ASCII digits', async () => {
  const h = harness(async (presentation, _signal) => {
    const code = await presentation.enterTemporaryCode({ playerName: 'Player', expiresAt: Number(process.hrtime.bigint() / 1_000_000n) + 5_000,
      signal: new AbortController().signal })
    assert.equal(code, '01234567')
    return { playerId: 'player-1', phase: 'active-awaiting-reconciliation' }
  })
  const pending = h.ipcMain.invoke('remote-ui:management:pair', {}, candidateId)
  await new Promise<void>(resolve => setImmediate(resolve))
  const request = h.sent.find(event => event.type === 'code-request')
  assert.ok(request && request.type === 'code-request')
  assert.equal(await h.ipcMain.invoke('remote-ui:management:submit-code', {}, request.requestId, request.revision, '１２３４５６７８'), false)
  assert.equal(await h.ipcMain.invoke('remote-ui:management:submit-code', {}, request.requestId, request.revision + 1, '01234567'), false)
  assert.equal(await h.ipcMain.invoke('remote-ui:management:submit-code', {}, request.requestId, request.revision, '01234567'), true)
  assert.deepEqual(await pending, { outcome: 'completed' },
    'a successful pair must pass the G2 update and reconnection setup stages')
  assert.equal(h.calls(), 1)
  h.dispose()
})

test('renewal route retains its purpose through the Player code-entry presentation', async () => {
  const h = harness(async presentation => {
    const code = await presentation.enterTemporaryCode({ playerName: 'Player',
      expiresAt: Number(process.hrtime.bigint() / 1_000_000n) + 5_000, signal: new AbortController().signal })
    assert.equal(code, '00001234')
    return { playerId: candidateId, phase: 'active-awaiting-reconciliation' }
  })
  const pending = h.ipcMain.invoke('remote-ui:management:pair-renewal', {}, candidateId)
  await new Promise<void>(resolve => setImmediate(resolve))
  const request = h.sent.find(event => event.type === 'code-request')
  assert.ok(request && request.type === 'code-request')
  assert.equal(request.purpose, 'renewal')
  assert.equal(await h.ipcMain.invoke('remote-ui:management:submit-code', {}, request.requestId, request.revision, '00001234'), true)
  assert.deepEqual(await pending, { outcome: 'completed' })
  assert.deepEqual(h.purposes(), ['renewal'])
  h.dispose()
})

test('recovery route uses the persisted G2 proof without asking for a fresh temporary code', async () => {
  const playerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const h = harness(async () => { throw new Error('INITIAL_PAIRING_MUST_NOT_RUN') }, {
    recover: async (recoveredPlayerId, recoveredCandidateId, presentation) => {
      assert.equal(recoveredPlayerId, playerId)
      assert.equal(recoveredCandidateId, candidateId)
      assert.equal(presentation.approvedForProduction, true)
      await assert.rejects(presentation.enterTemporaryCode(), /PAIRING_RECOVERY_CODE_NOT_REQUIRED/)
      return { playerId: recoveredPlayerId, phase: 'active-awaiting-reconciliation' }
    }
  })
  assert.deepEqual(await h.ipcMain.invoke('remote-ui:management:pair-recover', {}, playerId, candidateId),
    { outcome: 'completed' })
  assert.deepEqual(h.recoveries(), [{ playerId, candidateId }])
  assert.equal(h.sent.some(event => event.type === 'recovery-started'), true)
  assert.equal(h.sent.some(event => event.type === 'code-request'), false)
  assert.equal(h.calls(), 0, 'recovery does not start a new pairing session')
  h.dispose()
})

test('temporary code expiry resolves the active request and rejects every later submission', async () => {
  const h = harness(async presentation => {
    const code = await presentation.enterTemporaryCode({ playerName: 'Player',
      expiresAt: Number(process.hrtime.bigint() / 1_000_000n) + 20, signal: new AbortController().signal })
    assert.equal(code, null, 'the Main-owned deadline resolves an unanswered code request without a value')
    throw new Error('PAIRING_CODE_EXPIRED')
  })
  const pending = h.ipcMain.invoke('remote-ui:management:pair', {}, candidateId)
  await new Promise<void>(resolve => setImmediate(resolve))
  const request = h.sent.find(event => event.type === 'code-request')
  assert.ok(request && request.type === 'code-request')
  const reply = await pending
  assert.deepEqual(reply, { outcome: 'failed', code: 'PAIRING_CODE_EXPIRED' })
  assert.equal(await h.ipcMain.invoke('remote-ui:management:submit-code', {}, request.requestId, request.revision, '01234567'), false,
    'a code arriving after expiry cannot be submitted into the completed request')
  h.dispose()
})

test('main-frame navigation aborts an in-flight pairing and stale UI cannot submit into it', async () => {
  let aborted = false
  const h = harness(async (_presentation, signal) => await new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('PAIRING_CANCELLED')) }, { once: true })
  }))
  const pending = h.ipcMain.invoke('remote-ui:management:pair', {}, candidateId)
  await new Promise<void>(resolve => setImmediate(resolve))
  const request = h.sent.find(event => event.type === 'waiting-consent')
  assert.ok(request && request.type === 'waiting-consent')
  h.managementWindow.webContents.emit('did-start-navigation', {}, 'file:///new-document', false, true)
  assert.equal((await pending).outcome, 'cancelled')
  assert.equal(aborted, true)
  assert.equal(await h.ipcMain.invoke('remote-ui:management:submit-code', {}, request.requestId, request.revision, '01234567'), false)
  h.dispose()
})

test('production gate prevents pairing before allocating a presentation request', async () => {
  const h = harness(async () => { throw new Error('PAIRING_SHOULD_NOT_START') }, { approved: false })
  const reply = await h.ipcMain.invoke('remote-ui:management:pair', {}, candidateId)
  assert.deepEqual(reply, { outcome: 'failed', code: 'PAIRING_PRESENTATION_UNAPPROVED' })
  assert.equal(h.calls(), 0)
  assert.equal(h.sent.length, 0)
  h.dispose()
})

test('Player consent expiration resolves as rejection and a stale consent event cannot authorize later', async () => {
  const ipcMain = new FakeIpcMain()
  const playerWindow = createWindow()
  const playerEvents: PlayerPairingUiEvent[] = []
  playerWindow.webContents.send = (_channel: string, payload: unknown): void => { playerEvents.push(payload as PlayerPairingUiEvent) }
  let presentation: any
  let consentTask: Promise<boolean> | undefined
  const runtime = {
    subscribeRemoteUi: () => () => undefined,
    getRemoteUiSnapshot: async () => snapshot,
    setRemoteControlIntent: async () => undefined,
    configurePlayerPairingPresentation: async (value: unknown) => { presentation = value },
    createPlayerPairingAuthorization: () => ({}),
    cancelPlayerPairing: async () => true,
    startPlayer: async () => {
      consentTask = presentation.requestConsent({ displayName: 'Gestão', purpose: 'initial',
        expiresAt: Number(process.hrtime.bigint() / 1_000_000n) + 20 })
    }
  } as unknown as MainRemoteRuntime
  const dispose = registerMainRemoteUiIpcHandlers({
    ipcMain: ipcMain as any, mode: 'player', runtime, getPlayerWindow: () => playerWindow as any,
    getManagementWindow: () => null, assertPlayerSender: () => undefined,
    assertManagementSender: () => undefined, getInterfaceAddresses: () => ['192.168.1.20'],
    getManagementDatabase: () => undefined, pairingPresentationApprovedForProduction: true
  })
  try {
    assert.deepEqual(await ipcMain.invoke('remote-ui:player:enable-discovery', {}, '192.168.1.20'), { outcome: 'started' })
    const request = playerEvents.find(event => event.type === 'consent-request')
    assert.ok(request && request.type === 'consent-request')
    assert.ok(request.remainingMs > 0 && request.remainingMs <= 20)
    assert.equal(await consentTask, false, 'the bounded consent timer fails closed when the owner does not answer')
    assert.equal(await ipcMain.invoke('remote-ui:player:answer-consent', {}, request.requestId, request.revision, true), false,
      'a delayed acceptance from the expired modal cannot authorize the Player')
    assert.equal(playerEvents.some(event => event.type === 'temporary-code'), false,
      'expired consent never exposes a pairing code')
  } finally { dispose() }
})

test('pairing preserves only a bounded native error code for categorized Renderer feedback', async () => {
  const error = Object.assign(new Error('connect failed at /private/path with secret material'), { code: 'ECONNREFUSED' })
  const h = harness(async () => { throw error })
  try {
    assert.deepEqual(await h.ipcMain.invoke('remote-ui:management:pair', {}, candidateId),
      { outcome: 'failed', code: 'ECONNREFUSED' })
  } finally { h.dispose() }
})

test('temporary pairing code is delivered only to the Player owner and never enters a general snapshot', async () => {
  const ipcMain = new FakeIpcMain()
  const playerWindow = createWindow()
  const managementWindow = createWindow()
  const playerEvents: PlayerPairingUiEvent[] = []
  const managementEvents: unknown[] = []
  playerWindow.webContents.send = (_channel: string, payload: unknown): void => { playerEvents.push(payload as PlayerPairingUiEvent) }
  managementWindow.webContents.send = (_channel: string, payload: unknown): void => { managementEvents.push(payload) }
  let presentation: any
  let consentTask: Promise<boolean> | undefined
  let playerOptions: any
  let renewalOptions: any
  let renewalConsentTask: Promise<boolean> | undefined
  const runtime = {
    subscribeRemoteUi: () => () => undefined,
    getRemoteUiSnapshot: async () => snapshot,
    setRemoteControlIntent: async () => undefined,
    configurePlayerPairingPresentation: async (value: unknown) => { presentation = value },
    createPlayerPairingAuthorization: () => ({}),
    startPlayer: async (options: any) => {
      playerOptions = options
      consentTask = presentation.requestConsent({ displayName: 'Gestão', purpose: 'initial',
        expiresAt: Number(process.hrtime.bigint() / 1_000_000n) + 10_000 })
    },
    startGuidedPlayerCertificateRenewal: async (options: any) => {
      renewalOptions = options
      renewalConsentTask = options.presentation.requestConsent({ displayName: 'Gestão', purpose: 'renewal',
        expiresAt: Number(process.hrtime.bigint() / 1_000_000n) + 10_000 })
    },
    cancelPlayerPairing: async () => true
  } as unknown as MainRemoteRuntime
  const errors: string[] = []
  const dispose = registerMainRemoteUiIpcHandlers({
    ipcMain: ipcMain as any, mode: 'player', runtime, getPlayerWindow: () => playerWindow as any,
    getManagementWindow: () => managementWindow as any, assertPlayerSender: () => undefined,
    assertManagementSender: () => undefined, getInterfaceAddresses: () => ['192.168.1.20'],
    getManagementDatabase: () => undefined, pairingPresentationApprovedForProduction: true,
    onError: code => errors.push(code)
  })
  try {
    assert.deepEqual(await ipcMain.invoke('remote-ui:player:enable-discovery', {}, '192.168.1.20'), { outcome: 'started' })
    assert.equal(playerOptions.port, 47831)
    await new Promise<void>(resolve => setImmediate(resolve))
    const request = playerEvents.find(event => event.type === 'consent-request')
    assert.ok(request && request.type === 'consent-request')
    assert.equal(await ipcMain.invoke('remote-ui:player:answer-consent', {}, request.requestId, request.revision, true), true)
    assert.equal(await consentTask, true)
    presentation.showTemporaryCode({ groupedCode: '0123 4567',
      expiresAt: Number(process.hrtime.bigint() / 1_000_000n) + 10_000 })
    const codeEvent = playerEvents.find(event => event.type === 'temporary-code')
    assert.ok(codeEvent && codeEvent.type === 'temporary-code')
    assert.equal(codeEvent.groupedCode, '0123 4567')
    assert.equal(managementEvents.some(event => JSON.stringify(event).includes('0123 4567')), false)
    const generalSnapshot = await ipcMain.invoke('remote-ui:player:get-snapshot', {})
    assert.equal(JSON.stringify(generalSnapshot).includes('0123 4567'), false)
    presentation.closePairing({ outcome: 'active' })
    assert.deepEqual(await ipcMain.invoke('remote-ui:player:renew-certificate', {}, '192.168.1.20'), { outcome: 'started' })
    await new Promise<void>(resolve => setImmediate(resolve))
    const renewalRequest = playerEvents.filter(event => event.type === 'consent-request' && event.purpose === 'renewal').at(-1)
    assert.ok(renewalRequest && renewalRequest.type === 'consent-request',
      'certificate renewal uses a distinct Player-owned consent presentation')
    assert.equal(await ipcMain.invoke('remote-ui:player:answer-consent', {}, renewalRequest.requestId,
      renewalRequest.revision, false), true)
    assert.equal(await renewalConsentTask, false, 'renewal cancellation cannot proceed to code display or certificate promotion')
    assert.equal(renewalOptions.port, playerOptions.port, 'renewal retains the same approved listener port')
    assert.equal(playerEvents.filter(event => event.type === 'temporary-code').length, 1,
      'a cancelled renewal does not show a temporary code')
    assert.deepEqual(errors, [])
  } finally { dispose() }
})
