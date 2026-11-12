import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BonjourDiscoveryPort } from '../src/remote-discovery'
import { REMOTE_DISCOVERY_TYPE, REMOTE_LIMITS } from '../src/remote-contracts'

interface PacketRecord { name: string; type: string; ttl: number; data: unknown; flush?: boolean }
class FakeMdns extends EventEmitter {
  interfaceAddress = ''
  queries: Array<{ name: string; type: string }> = []
  destroyed = false
  query(name: string, type: string): void { this.queries.push({ name, type }) }
  respond(_packet: unknown, callback?: (error?: Error) => void): void { callback?.() }
  destroy(callback?: () => void): void { this.destroyed = true; callback?.() }
}

function makeHarness() {
  let now = 1_000
  let current = { address: '192.168.10.20', netmask: '255.255.255.0', name: 'eth-test' }
  const nodes: FakeMdns[] = []
  const optionsSeen: Array<{ interface: string; bind: '0.0.0.0'; reuseAddr: true }> = []
  const ticks = new Set<() => void>()
  const discovery = new BonjourDiscoveryPort(undefined, {
    now: () => now,
    resolveInterface: address => address === current.address ? { ...current } : undefined,
    resolveInterfaceName: name => name === current.name ? { ...current } : undefined,
    createMdns: options => {
      optionsSeen.push(options)
      const node = new FakeMdns()
      node.interfaceAddress = options.interface
      nodes.push(node)
      queueMicrotask(() => node.emit('ready'))
      return node as never
    },
    setInterval: ((callback: () => void) => { ticks.add(callback); return callback as never }) as unknown as typeof setInterval,
    clearInterval: ((handle: unknown) => { ticks.delete(handle as () => void) }) as typeof clearInterval
  })
  const setNow = (value: number): void => { now = value }
  const emit = (packet: PacketRecord[], node = nodes.at(-1), sourceAddress?: string): void => {
    assert.ok(node)
    const parts = node.interfaceAddress.split('.')
    parts[3] = '30'
    node.emit('response', { answers: packet, additionals: [] }, { address: sourceAddress ?? parts.join('.') })
  }
  const records = (address = current.address, ttl = 10): PacketRecord[] => {
    const instance = 'Karaoke-550e8400-e29b-41d4-a716-446655440000._kq-player._tcp.local'
    return [
      { name: `_${REMOTE_DISCOVERY_TYPE}._tcp.local`, type: 'PTR', ttl, data: instance },
      { name: instance, type: 'SRV', ttl, flush: true, data: { port: 47831, priority: 0, weight: 0, target: 'player-test.local' } },
      { name: instance, type: 'TXT', ttl, flush: true, data: [Buffer.from('version=1'), Buffer.from('deviceId=550e8400-e29b-41d4-a716-446655440000'), Buffer.from('name=Room Player')] },
      { name: 'player-test.local', type: 'A', ttl, flush: true, data: address }
    ]
  }
  return { discovery, nodes, optionsSeen, ticks, setNow, emit, records, setInterface: (next: typeof current) => { current = next } }
}

test('repeated identical DNS-SD answers renew TTL and DHCP address replaces stale endpoint', async () => {
  const h = makeHarness()
  await h.discovery.start(['192.168.10.20'])
  assert.deepEqual(h.optionsSeen, [{ interface: '192.168.10.20', bind: '0.0.0.0', reuseAddr: true }])
  h.emit(h.records())
  const initial = h.discovery.getSnapshot().candidates[0]
  assert.deepEqual(initial.addresses, ['192.168.10.20'])
  h.emit(h.records('192.168.10.99'), undefined, '192.168.11.99')
  assert.deepEqual(h.discovery.getSnapshot().candidates[0].addresses, ['192.168.10.20'],
    'responses outside the selected interface subnet are ignored')
  h.setNow(9_000)
  h.emit(h.records())
  h.setNow(12_000)
  assert.equal(h.discovery.getSnapshot().candidates.length, 1)
  h.setNow(20_000)
  h.emit(h.records('192.168.10.21'))
  assert.deepEqual(h.discovery.getSnapshot().candidates[0].addresses, ['192.168.10.21'])
  assert.equal(h.discovery.getSnapshot().candidates[0].verified, false)
  await h.discovery.stop()
})

test('goodbye and expiry remove candidates; cache bounds malformed and excessive announcements', async () => {
  const h = makeHarness()
  await h.discovery.start(['192.168.10.20'])
  h.emit(h.records())
  h.emit(h.records().map(record => ({ ...record, ttl: 0 })))
  assert.equal(h.discovery.getSnapshot().candidates.length, 0)

  for (let batch = 0; batch < 4; batch++) {
    h.emit(Array.from({ length: 256 }, (_, index) => ({
      name: `_${REMOTE_DISCOVERY_TYPE}._tcp.local`, type: 'PTR', ttl: 10,
      data: `fake-${batch}-${index}._kq-player._tcp.local`
    })))
  }
  const internal = h.discovery as unknown as { records: Map<unknown, unknown> }
  assert.equal(internal.records.size, 512)
  assert.equal(h.discovery.getSnapshot().candidates.length, 0)
  h.emit([{ name: `_${REMOTE_DISCOVERY_TYPE}._tcp.local`, type: 'PTR', ttl: 10, data: Buffer.alloc(70_000) }])
  assert.equal(internal.records.size, 512)
  h.setNow(20_000)
  for (const tick of h.ticks) tick()
  assert.equal(h.discovery.getSnapshot().candidates.length, 0)
  await h.discovery.stop()
  assert.equal(h.ticks.size, 0)
  assert.ok(h.nodes.every(node => node.destroyed))
})

test('many valid devices stay within the candidate snapshot cap while cache remains bounded', async () => {
  const h = makeHarness()
  await h.discovery.start(['192.168.10.20'])
  const records: PacketRecord[] = []
  for (let index = 0; index < REMOTE_LIMITS.maxCandidates + 16; index++) {
    const suffix = index.toString(16).padStart(12, '0')
    const deviceId = `00000000-0000-4000-8000-${suffix}`
    const instance = `Karaoke-${deviceId}._kq-player._tcp.local`
    const host = `player-${index}.local`
    records.push(
      { name: `_${REMOTE_DISCOVERY_TYPE}._tcp.local`, type: 'PTR', ttl: 10, data: instance },
      { name: instance, type: 'SRV', ttl: 10, flush: true, data: { port: 47831, priority: 0, weight: 0, target: host } },
      { name: instance, type: 'TXT', ttl: 10, flush: true, data: [Buffer.from('version=1'), Buffer.from(`deviceId=${deviceId}`), Buffer.from(`name=Player ${index}`)] },
      { name: host, type: 'A', ttl: 10, flush: true, data: '192.168.10.30' }
    )
  }
  for (let offset = 0; offset < records.length; offset += 256) h.emit(records.slice(offset, offset + 256))
  const internal = h.discovery as unknown as { records: Map<unknown, unknown>; candidates: Map<unknown, unknown> }
  assert.equal(internal.records.size, (REMOTE_LIMITS.maxCandidates + 16) * 4)
  assert.equal(internal.candidates.size, REMOTE_LIMITS.maxCandidates)
  assert.equal(h.discovery.getSnapshot().candidates.length, REMOTE_LIMITS.maxCandidates)
  assert.ok(h.discovery.getSnapshot().candidates.every(candidate => !candidate.verified))
  h.emit(Array.from({ length: 256 }, (_, index) => ({
    name: `unrelated-${index}.local`, type: 'A', ttl: 120, data: '192.168.10.31'
  })))
  assert.equal(internal.records.size, (REMOTE_LIMITS.maxCandidates + 16) * 4,
    'unrelated multicast A records cannot consume the DNS-SD cache')
  assert.equal(h.discovery.getSnapshot().candidates.length, REMOTE_LIMITS.maxCandidates)
  await h.discovery.stop()
})

test('refresh follows an interface address change and start-stop-start leaves no old sockets', async () => {
  const h = makeHarness()
  await h.discovery.start(['192.168.10.20'])
  h.emit(h.records())
  h.setInterface({ address: '192.168.10.21', netmask: '255.255.255.0', name: 'eth-test' })
  h.setNow(61_000)
  let unsubscribe = (): void => undefined
  const restarted = new Promise<void>(resolve => {
    unsubscribe = h.discovery.subscribe(() => {
      if (h.nodes.length === 2 && !h.nodes[1].destroyed) {
        unsubscribe()
        resolve()
      }
    })
  })
  for (const tick of h.ticks) tick()
  await restarted
  assert.equal(h.nodes[0].destroyed, true)
  assert.equal(h.nodes.length, 2)
  assert.deepEqual(h.nodes[1].queries.at(-1), { name: `_${REMOTE_DISCOVERY_TYPE}._tcp.local`, type: 'PTR' })
  assert.equal(h.discovery.getSnapshot().candidates.length, 0)
  await h.discovery.stop()
  await h.discovery.start(['192.168.10.21'])
  await h.discovery.stop()
  assert.ok(h.nodes.every(node => node.destroyed))
  assert.equal(h.ticks.size, 0)
})

test('periodic discovery queries renew announcements without operator refresh', async () => {
  const h = makeHarness()
  await h.discovery.start(['192.168.10.20'])
  h.emit(h.records())
  assert.equal(h.nodes[0].queries.length, 1)
  h.setNow(61_000)
  for (const tick of h.ticks) tick()
  assert.equal(h.nodes[0].queries.length, 2)
  h.emit(h.records())
  h.setNow(70_000)
  for (const tick of h.ticks) tick()
  assert.equal(h.discovery.getSnapshot().candidates.length, 1)
  await h.discovery.stop()
})

test('stop racing startup cancels pending ready wait and destroys socket', async () => {
  const h = makeHarness()
  let releaseReady: (() => void) | undefined
  const nodes: FakeMdns[] = []
  let creationCount = 0
  const discovery = new BonjourDiscoveryPort(undefined, {
    resolveInterface: address => ({ address, netmask: '255.255.255.0', name: 'eth-test' }),
    createMdns: options => {
      const node = new FakeMdns()
      node.interfaceAddress = options.interface
      nodes.push(node)
      if (creationCount++ === 0) releaseReady = () => node.emit('ready')
      else queueMicrotask(() => node.emit('ready'))
      return node as never
    }
  })
  const starting = discovery.start(['192.168.10.20'])
  await Promise.resolve()
  const stopping = discovery.stop()
  const repeatedStop = discovery.stop()
  const racingRestart = discovery.start(['192.168.10.20'])
  await assert.rejects(starting, /REMOTE_DISCOVERY_STOPPED/)
  await assert.rejects(racingRestart, /REMOTE_DISCOVERY_STOPPED/)
  await Promise.all([stopping, repeatedStop])
  releaseReady?.()
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].destroyed, true)
  await discovery.start(['192.168.10.20'])
  await discovery.stop()
  assert.equal(nodes.length, 2)
  assert.ok(nodes.every(node => node.destroyed))
})

test('DNS-SD caches and goodbyes remain scoped to the receiving interface', async () => {
  const interfaces = new Map([
    ['192.168.10.20', { address: '192.168.10.20', netmask: '255.255.255.0', name: 'eth-a' }],
    ['192.168.20.20', { address: '192.168.20.20', netmask: '255.255.255.0', name: 'eth-b' }]
  ])
  const nodes: FakeMdns[] = []
  const discovery = new BonjourDiscoveryPort(undefined, {
    resolveInterface: address => interfaces.get(address),
    resolveInterfaceName: name => [...interfaces.values()].find(item => item.name === name),
    createMdns: options => {
      const node = new FakeMdns()
      node.interfaceAddress = options.interface
      nodes.push(node)
      queueMicrotask(() => node.emit('ready'))
      return node as never
    },
    setInterval: (() => ({}) as never) as unknown as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval
  })
  const emit = (node: FakeMdns, records: PacketRecord[], sourceAddress: string): void => {
    node.emit('response', { answers: records, additionals: [] }, { address: sourceAddress })
  }
  const makeRecords = (address: string): PacketRecord[] => {
    const instance = 'Karaoke-550e8400-e29b-41d4-a716-446655440000._kq-player._tcp.local'
    return [
      { name: `_${REMOTE_DISCOVERY_TYPE}._tcp.local`, type: 'PTR', ttl: 10, data: instance },
      { name: instance, type: 'SRV', ttl: 10, flush: true, data: { port: 47831, priority: 0, weight: 0, target: 'player-test.local' } },
      { name: instance, type: 'TXT', ttl: 10, flush: true, data: [Buffer.from('version=1'), Buffer.from('deviceId=550e8400-e29b-41d4-a716-446655440000'), Buffer.from('name=Room Player')] },
      { name: 'player-test.local', type: 'A', ttl: 10, flush: true, data: address }
    ]
  }
  await discovery.start(['192.168.10.20', '192.168.20.20'])
  emit(nodes[0], makeRecords('192.168.10.30'), '192.168.10.30')
  emit(nodes[1], makeRecords('192.168.20.30'), '192.168.20.30')
  assert.deepEqual(discovery.getSnapshot().candidates.map(candidate => candidate.addresses[0]).sort(),
    ['192.168.10.30', '192.168.20.30'])

  emit(nodes[0], makeRecords('192.168.10.30').map(record => ({ ...record, ttl: 0 })), '192.168.10.30')
  assert.deepEqual(discovery.getSnapshot().candidates.map(candidate => candidate.addresses[0]), ['192.168.20.30'])
  await discovery.stop()
})
