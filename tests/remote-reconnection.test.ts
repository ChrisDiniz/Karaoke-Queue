import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteReconnectionService, type RemoteReconnectClock, type RemoteReconnectPort, type RemotePeerChannel,
  type SavedRemotePeer } from '../src/remote-reconnection-service'

class Clock implements RemoteReconnectClock {
  value = 0; randomValue = 0.5; next = 1
  timers = new Map<number, () => void>()
  now(): number { return this.value }
  random(): number { return this.randomValue }
  setTimer(callback: () => void): ReturnType<typeof setTimeout> {
    const id = this.next++; this.timers.set(id, callback); return id as unknown as ReturnType<typeof setTimeout>
  }
  clearTimer(timer: ReturnType<typeof setTimeout>): void { this.timers.delete(timer as unknown as number) }
  async tick(): Promise<void> {
    const callbacks = [...this.timers.values()]; this.timers.clear()
    callbacks.forEach(callback => callback())
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

const peer: SavedRemotePeer = { playerId: 'player-1', fingerprintSha256: 'a'.repeat(64),
  serverName: 'player-player-1.karaoke.invalid', port: 12345, lastAddress: '192.168.1.12', active: true,
  credentialGeneration: 2 }
function channel(overrides: Partial<RemotePeerChannel> = {}): RemotePeerChannel {
  return { connectionId: 'connection-1', playerId: peer.playerId, fingerprintSha256: peer.fingerprintSha256,
    credentialGeneration: peer.credentialGeneration, close() {}, ...overrides }
}
function harness(options: { connect?: (signal: AbortSignal) => Promise<RemotePeerChannel>; reconcile?: () => Promise<
  { state: 'synchronized' } | { state: 'recovery_required'; reason: string }> } = {}) {
  const clock = new Clock(); const statuses: string[] = []; let connectCount = 0; let closed = 0
  const port: RemoteReconnectPort = {
    async connect(_peer, _address, signal) { connectCount++; return options.connect ? options.connect(signal) : channel({ close() { closed++ } }) },
    async reconcile() { return options.reconcile ? options.reconcile() : { state: 'synchronized' } },
    async isAuthorizationCurrent() { return true }
  }
  const service = new RemoteReconnectionService(port, clock, value => statuses.push(value.state))
  return { clock, service, statuses, counts: () => ({ connectCount, closed }) }
}

test('reconnect uses saved address, then requires authorization and reconciliation before synchronized', async () => {
  const h = harness(); await h.service.start([peer]); await h.clock.tick()
  assert.equal(h.counts().connectCount, 1)
  assert.equal(h.service.status(peer.playerId)?.state, 'synchronized')
  assert.ok(h.statuses.includes('authorized')); assert.ok(h.statuses.includes('reconciling'))
  await h.service.close(); assert.equal(h.service.status(peer.playerId)?.state, 'closed')
})

test('discovery is only a locator and cannot change pin or generation identity', async () => {
  const h = harness({ connect: async () => channel({ fingerprintSha256: 'b'.repeat(64) }) })
  await h.service.start([{ ...peer, lastAddress: undefined }])
  h.service.updateDiscovery([{ candidateId: 'c', instanceName: 'x', displayName: 'Player', deviceIdClaim: peer.playerId,
    interfaceAddress: '192.168.1.1', addresses: ['192.168.1.25'], port: peer.port, observedAt: 0, expiresAt: 10_000, verified: false }])
  await h.clock.tick()
  assert.equal(h.counts().connectCount, 1)
  assert.equal(h.service.status(peer.playerId)?.state, 'conflict')
  assert.equal(h.service.status(peer.playerId)?.reason, 'REMOTE_IDENTITY_MISMATCH')
})

test('DHCP discovery supplies a new address and port only as a candidate for the saved pinned peer', async () => {
  const clock = new Clock(); const endpoints: Array<{ address: string; port?: number }> = []
  const service = new RemoteReconnectionService({
    async connect(_savedPeer, address, _signal, port) {
      endpoints.push({ address, port })
      return channel()
    },
    async reconcile() { return { state: 'synchronized' } },
    async isAuthorizationCurrent() { return true }
  }, clock)
  const candidate = { candidateId: 'dhcp', instanceName: 'player-new-address', displayName: 'Player',
    deviceIdClaim: peer.playerId, interfaceAddress: '192.168.1.1', addresses: ['192.168.1.25'], port: 54321,
    observedAt: 0, expiresAt: 10_000, verified: false as const }
  await service.start([{ ...peer, lastAddress: undefined }])
  service.updateDiscovery([candidate])
  await clock.tick()
  assert.deepEqual(endpoints, [{ address: '192.168.1.25', port: 54321 }])
  assert.equal(service.status(peer.playerId)?.state, 'synchronized')
  await service.close()
})

test('temporary WSS close schedules reconnect and elects one replacement channel', async () => {
  const clock = new Clock(); let connectionCount = 0; let notifyClose: (() => void) | undefined
  const service = new RemoteReconnectionService({
    async connect() {
      connectionCount++
      return channel({ connectionId: `connection-${connectionCount}`, onClose(listener) {
        notifyClose = listener
        return () => { if (notifyClose === listener) notifyClose = undefined }
      } })
    },
    async reconcile() { return { state: 'synchronized' } },
    async isAuthorizationCurrent() { return true }
  }, clock)
  await service.start([peer]); await clock.tick()
  assert.equal(service.status(peer.playerId)?.state, 'synchronized')
  notifyClose?.()
  assert.equal(service.status(peer.playerId)?.state, 'backoff')
  assert.equal(clock.timers.size, 1)
  await clock.tick()
  assert.equal(connectionCount, 2)
  assert.equal(service.status(peer.playerId)?.connectionId, 'connection-2')
  assert.equal(service.status(peer.playerId)?.state, 'synchronized')
  await service.close()
})

test('temporary failures use bounded deterministic backoff and retry after task settles', async () => {
  const h = harness({ connect: async () => { throw new Error('ECONNRESET') } })
  await h.service.start([peer]); await h.clock.tick()
  assert.equal(h.service.status(peer.playerId)?.state, 'backoff')
  assert.equal(h.service.status(peer.playerId)?.retryAt, 1_000)
  assert.equal(h.clock.timers.size, 1)
  await h.clock.tick(); assert.equal(h.counts().connectCount, 2)
  await h.service.close()
})

test('saved peers share one global connect/reconciliation slot and later peers wait in a bounded queue', async () => {
  const clock = new Clock()
  const secondPeer = { ...peer, playerId: 'player-2', serverName: 'player-player-2.karaoke.invalid',
    lastAddress: '192.168.1.13' }
  let active = 0, maxActive = 0, connectCount = 0
  let releaseFirst!: () => void
  const service = new RemoteReconnectionService({
    async connect(savedPeer) {
      active++; connectCount++; maxActive = Math.max(maxActive, active)
      return channel({ playerId: savedPeer.playerId, connectionId: `connection-${savedPeer.playerId}` })
    },
    async reconcile(savedPeer) {
      if (savedPeer.playerId === peer.playerId) await new Promise<void>(resolve => { releaseFirst = resolve })
      active--
      return { state: 'synchronized' }
    },
    async isAuthorizationCurrent() { return true }
  }, clock)
  await service.start([peer, secondPeer])
  await clock.tick()
  assert.equal(connectCount, 1, 'the first saved peer occupies the single global attempt slot')
  assert.equal(service.status(secondPeer.playerId)?.reason, 'RECONNECT_SLOT_BUSY')
  releaseFirst()
  for (let index = 0; index < 6; index++) await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(connectCount, 2)
  assert.equal(maxActive, 1, 'connect plus reconciliation for different peers never overlap')
  assert.equal(service.status(peer.playerId)?.state, 'synchronized')
  assert.equal(service.status(secondPeer.playerId)?.state, 'synchronized')
  await service.close()
})

test('revocation while reconnecting aborts and stale completion cannot elect a channel', async () => {
  let resolveConnect!: (value: RemotePeerChannel) => void
  const h = harness({ connect: () => new Promise(resolve => { resolveConnect = resolve }) })
  await h.service.start([peer]); await h.clock.tick()
  await h.service.disable()
  resolveConnect(channel())
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.service.status(peer.playerId)?.state, 'disabled')
})

test('late initial authorization after disable cannot publish or retain an elected channel', async () => {
  const clock = new Clock(); let release!: (authorized: boolean) => void, reached!: () => void, closes = 0
  const authorizationPending = new Promise<boolean>(resolve => { release = resolve })
  const authorizationReached = new Promise<void>(resolve => { reached = resolve })
  const states: string[] = []
  const service = new RemoteReconnectionService({
    async connect() { return channel({ close() { closes++ } }) },
    async reconcile() { return { state: 'synchronized' } },
    async isAuthorizationCurrent() { reached(); return authorizationPending }
  }, clock, status => states.push(status.state))
  await service.start([peer]); await clock.tick(); await authorizationReached
  await service.disable()
  const disabledStateCount = states.filter(state => state === 'disabled').length
  release(true)
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(service.status(peer.playerId)?.state, 'disabled')
  assert.equal(service.status(peer.playerId)?.connectionId, null)
  assert.equal(states.filter(state => state === 'synchronized').length, 0)
  assert.equal(states.filter(state => state === 'disabled').length, disabledStateCount)
  assert.equal(closes, 1, 'the stale socket is closed once after authorization resolves')
  await service.close()
})

test('late post-reconciliation authorization cannot republish synchronized after disable', async () => {
  const clock = new Clock(); let release!: (authorized: boolean) => void, reached!: () => void, checks = 0, closes = 0
  const authorizationPending = new Promise<boolean>(resolve => { release = resolve })
  const authorizationReached = new Promise<void>(resolve => { reached = resolve })
  const states: string[] = []
  const service = new RemoteReconnectionService({
    async connect() { return channel({ close() { closes++ } }) },
    async reconcile() { return { state: 'synchronized' } },
    async isAuthorizationCurrent() { if (++checks === 2) { reached(); return authorizationPending } return true }
  }, clock, status => states.push(status.state))
  await service.start([peer]); await clock.tick(); await authorizationReached
  await service.disable()
  assert.equal(service.status(peer.playerId)?.state, 'disabled')
  release(true)
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(service.status(peer.playerId)?.state, 'disabled')
  assert.equal(service.status(peer.playerId)?.connectionId, null)
  assert.equal(states.filter(state => state === 'synchronized').length, 0)
  assert.equal(closes, 1, 'disable and the stale continuation share one close operation')
  await service.close()
})

test('a new explicit start fences a pending old authorization and elects only the new channel', async () => {
  const clock = new Clock(); let releaseOld!: (authorized: boolean) => void, reachedOld!: () => void, connects = 0
  let closeOld = 0
  const oldAuthorization = new Promise<boolean>(resolve => { releaseOld = resolve })
  const oldReached = new Promise<void>(resolve => { reachedOld = resolve })
  const states: Array<{ state: string; connectionId: string | null }> = []
  const service = new RemoteReconnectionService({
    async connect() {
      const current = ++connects
      return channel({ connectionId: `connection-${current}`, close() { if (current === 1) closeOld++ } })
    },
    async reconcile() { return { state: 'synchronized' } },
    async isAuthorizationCurrent() { if (connects === 1) { reachedOld(); return oldAuthorization } return true }
  }, clock, status => states.push({ state: status.state, connectionId: status.connectionId }))
  await service.start([peer]); await clock.tick(); await oldReached
  await service.disable()
  await service.start([peer])
  releaseOld(true)
  for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve))
  await clock.tick()
  assert.equal(connects, 2)
  assert.equal(service.status(peer.playerId)?.state, 'synchronized')
  assert.equal(service.status(peer.playerId)?.connectionId, 'connection-2')
  assert.equal(closeOld, 1)
  assert.ok(!states.some(value => value.state === 'synchronized' && value.connectionId === null))
  await service.close()
})

test('recovery_required is retained instead of being called synchronized', async () => {
  const h = harness({ reconcile: async () => ({ state: 'recovery_required', reason: 'CURSOR_GAP' }) })
  await h.service.start([peer]); await h.clock.tick()
  assert.equal(h.service.status(peer.playerId)?.state, 'recovery_required')
  assert.equal(h.service.status(peer.playerId)?.synchronized, false)
  await h.service.close()
})

test('Player recovery marker reported during G3 hello stops automatic retries in recovery_required', async () => {
  const clock = new Clock(); let attempts = 0
  const service = new RemoteReconnectionService({
    async connect() { attempts++; throw new Error('REMOTE_PLAYER_RECOVERY_REQUIRED') },
    async reconcile() { return { state: 'synchronized' } },
    async isAuthorizationCurrent() { return true }
  }, clock)
  await service.start([peer]); await clock.tick()
  assert.equal(attempts, 1)
  assert.equal(service.status(peer.playerId)?.state, 'recovery_required')
  assert.equal(service.status(peer.playerId)?.reason, 'REMOTE_PLAYER_RECOVERY_REQUIRED')
  assert.equal(clock.timers.size, 0, 'manual recovery evidence does not trigger an automatic reconnect loop')
  await service.close()
})
