import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { isIP } from 'node:net'
import { REMOTE_DISCOVERY_TYPE, REMOTE_LIMITS } from './remote-contracts'
import type { DiscoveryCandidate, DiscoveryPort, DiscoverySnapshot, PlayerAdvertisement,
  PlayerAdvertisementPort, RemoteTransportLogger } from './remote-contracts'
import { isPrivateIpv4 } from './remote-tls'

const MDNS_TTL_SECONDS = 120
const MDNS_REFRESH_INTERVAL_MS = 60_000
const MAX_DISCOVERY_INTERFACES = 4
const noopLogger: RemoteTransportLogger = Object.freeze({ info(): void {}, warn(): void {}, error(): void {} })

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
  return /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN'
}

interface InterfaceSnapshot { address: string; netmask: string; name?: string }
interface MdnsQuestion { name: string; type: string }
interface MdnsRecord { name: string; type: string; ttl: number; data: unknown; flush?: boolean }
interface MdnsPacket { questions?: MdnsQuestion[]; answers?: MdnsRecord[]; additionals?: MdnsRecord[] }
interface MdnsRinfo { address: string }
interface MdnsNode {
  on(event: 'query' | 'response', listener: (packet: MdnsPacket, rinfo: MdnsRinfo) => void): this
  on(event: 'error' | 'warning', listener: (error: Error) => void): this
  on(event: 'ready', listener: () => void): this
  once(event: 'ready', listener: () => void): this
  once(event: 'error', listener: (error: Error) => void): this
  removeListener(event: 'ready', listener: () => void): this
  removeListener(event: 'error', listener: (error: Error) => void): this
  query(name: string, type: string): void
  respond(packet: { answers: MdnsRecord[]; additionals?: MdnsRecord[] }, callback?: (error?: Error) => void): void
  destroy(callback?: () => void): void
}
type MdnsFactory = (options: { interface: string; bind: '0.0.0.0'; reuseAddr: true }) => MdnsNode
const createMulticastDns = require('multicast-dns') as MdnsFactory
interface CachedRecord { record: MdnsRecord; expiresAt: number; interfaceAddress: string }
interface DiscoveryDependencies {
  createMdns?: MdnsFactory
  resolveInterface?: (address: string) => InterfaceSnapshot | undefined
  resolveInterfaceName?: (name: string) => InterfaceSnapshot | undefined
  now?: () => number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

function ipv4Number(value: string): number {
  return value.split('.').reduce((total, part) => ((total << 8) | Number(part)) >>> 0, 0)
}

function getInterfaceSnapshot(address: string): InterfaceSnapshot | undefined {
  let interfaces: ReturnType<typeof os.networkInterfaces>
  try { interfaces = os.networkInterfaces() }
  catch { return undefined }
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address === address && isPrivateIpv4(address)) {
        return { address, netmask: entry.netmask, name }
      }
    }
  }
  return undefined
}

/** Returns bounded private LAN interfaces for Main-owned discovery; results are locators only. */
export function getRemoteDiscoveryInterfaceAddresses(): string[] {
  let interfaces: ReturnType<typeof os.networkInterfaces>
  try { interfaces = os.networkInterfaces() } catch { return [] }
  const addresses = Object.values(interfaces).flatMap(entries => (entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal && isPrivateIpv4(entry.address))
    .map(entry => entry.address))
  return [...new Set(addresses)].slice(0, MAX_DISCOVERY_INTERFACES)
}

function sameSubnet(left: string, right: string, mask: string): boolean {
  return ((ipv4Number(left) & ipv4Number(mask)) >>> 0) === ((ipv4Number(right) & ipv4Number(mask)) >>> 0)
}

function sanitizeDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback.slice(0, REMOTE_LIMITS.maxDiscoveryNameLength)
  let safe = [...value.replace(/[\u0000-\u001f\u007f]/g, '').trim()]
    .slice(0, REMOTE_LIMITS.maxDiscoveryNameLength).join('')
  while (safe && Buffer.byteLength(`name=${safe}`, 'utf8') > 255) safe = [...safe].slice(0, -1).join('')
  return safe || fallback.slice(0, REMOTE_LIMITS.maxDiscoveryNameLength)
}

export function candidateFromService(service: { name?: string; fqdn?: string; txt?: Record<string, unknown>;
  port?: number; ttl?: number; addresses?: string[] }, interfaceInfo: InterfaceSnapshot, now = Date.now()): DiscoveryCandidate | undefined {
  const txt = service.txt ?? {}
  if (txt.version !== '1') return undefined
  const txtBytes = Object.entries(txt).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) +
    Buffer.byteLength(typeof value === 'string' ? value : String(value)), 0)
  if (txtBytes > REMOTE_LIMITS.maxTxtBytes || !service.port || service.port < 1024 || service.port > 65535) return undefined
  const claim = typeof txt.deviceId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(txt.deviceId)
    ? txt.deviceId : null
  const addresses = [...new Set((service.addresses ?? []).filter(address => isIP(address) === 4 &&
    isPrivateIpv4(address) && sameSubnet(address, interfaceInfo.address, interfaceInfo.netmask)))].slice(0, 4)
  if (!addresses.length) return undefined
  const ttlMs = Math.max(1, Math.min(service.ttl ?? MDNS_TTL_SECONDS, MDNS_TTL_SECONDS)) * 1000
  const fallback = service.name || 'Player encontrado'
  return {
    candidateId: randomUUID(),
    instanceName: service.fqdn || service.name || 'unknown.local',
    displayName: sanitizeDisplayName(txt.name, fallback),
    deviceIdClaim: claim,
    interfaceAddress: interfaceInfo.address,
    addresses,
    port: service.port,
    observedAt: now,
    expiresAt: now + ttlMs,
    verified: false
  }
}

export class BonjourDiscoveryPort implements DiscoveryPort {
  private readonly nodes = new Map<string, { node: MdnsNode; interfaceInfo: InterfaceSnapshot }>()
  private readonly candidates = new Map<string, DiscoveryCandidate>()
  private readonly records = new Map<string, CachedRecord>()
  private readonly listeners = new Set<(snapshot: DiscoverySnapshot) => void>()
  private readonly pendingReadyRejectors = new Set<(error: Error) => void>()
  private readonly now: () => number
  private readonly resolveInterface: (address: string) => InterfaceSnapshot | undefined
  private readonly resolveInterfaceName: (name: string) => InterfaceSnapshot | undefined
  private readonly createMdns: MdnsFactory
  private readonly setTimer: typeof setInterval
  private readonly clearTimer: typeof clearInterval
  private started = false
  private stopped = false
  private updatedAt = 0
  private lastNetworkRefreshAt = 0
  private sweepTimer: NodeJS.Timeout | undefined
  private startTask: Promise<void> | undefined
  private stopTask: Promise<void> | undefined
  private generation = 0

  constructor(private readonly logger: RemoteTransportLogger = noopLogger, dependencies: DiscoveryDependencies = {}) {
    this.createMdns = dependencies.createMdns ?? createMulticastDns
    this.resolveInterface = dependencies.resolveInterface ?? getInterfaceSnapshot
    this.resolveInterfaceName = dependencies.resolveInterfaceName ?? (name => {
      if (!name) return undefined
      const entries = os.networkInterfaces()[name] ?? []
      const item = entries.find(value => value.family === 'IPv4' && !value.internal && isPrivateIpv4(value.address))
      return item ? { address: item.address, netmask: item.netmask, name } : undefined
    })
    this.now = dependencies.now ?? Date.now
    this.setTimer = dependencies.setInterval ?? setInterval
    this.clearTimer = dependencies.clearInterval ?? clearInterval
  }

  async start(interfaceAddresses: readonly string[]): Promise<void> {
    if (this.started) return
    if (this.startTask) return this.startTask
    if (this.stopTask) await this.stopTask
    this.stopped = false
    if (interfaceAddresses.length === 0 || interfaceAddresses.length > MAX_DISCOVERY_INTERFACES ||
        new Set(interfaceAddresses).size !== interfaceAddresses.length) throw new Error('REMOTE_DISCOVERY_INTERFACES_INVALID')
    const resolved = interfaceAddresses.map(address => {
      if (isIP(address) !== 4 || !isPrivateIpv4(address)) throw new Error('REMOTE_DISCOVERY_INTERFACE_INVALID')
      const info = this.resolveInterface(address)
      if (!info) throw new Error('REMOTE_DISCOVERY_INTERFACE_UNAVAILABLE')
      return info
    })
    const generation = ++this.generation
    const task = this.startNodes(resolved, generation)
    this.startTask = task
    try { await task }
    catch (error) { await this.stop(); throw error }
    finally { if (this.startTask === task) this.startTask = undefined }
  }

  async refresh(): Promise<void> {
    if (!this.started || this.stopped) throw new Error('REMOTE_DISCOVERY_UNAVAILABLE')
    const generation = this.generation
    const current = [...this.nodes.values()].map(value => value.interfaceInfo)
    const refreshed = current.map(info => (info.name ? this.resolveInterfaceName(info.name) : undefined) ?? this.resolveInterface(info.address))
    if (refreshed.some((value, index) => !value || value.address !== current[index].address || value.netmask !== current[index].netmask)) {
      const addresses = refreshed.filter((value): value is InterfaceSnapshot => Boolean(value)).map(value => value.address)
      await this.stop()
      if (this.generation !== generation + 1) return
      if (addresses.length) await this.start(addresses)
      return
    }
    this.queryNodes()
    this.lastNetworkRefreshAt = this.now()
    this.sweep()
    this.publish()
  }

  getSnapshot(): DiscoverySnapshot {
    const now = this.now()
    return {
      candidates: [...this.candidates.values()].filter(candidate => candidate.expiresAt > now)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)).slice(0, REMOTE_LIMITS.maxCandidates),
      updatedAt: this.updatedAt
    }
  }

  subscribe(listener: (snapshot: DiscoverySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async stop(): Promise<void> {
    this.stopped = true
    ++this.generation
    if (this.stopTask) return this.stopTask
    this.started = false
    if (this.sweepTimer) this.clearTimer(this.sweepTimer)
    this.sweepTimer = undefined
    for (const reject of [...this.pendingReadyRejectors]) reject(new Error('REMOTE_DISCOVERY_STOPPED'))
    const task = (async () => {
      const resources = [...this.nodes.values()]
      this.nodes.clear()
      this.records.clear()
      this.candidates.clear()
      await Promise.all(resources.map(({ node }) => new Promise<void>(resolve => node.destroy(resolve))))
      await this.startTask?.catch(() => undefined)
      this.updatedAt = this.now()
      this.publish()
    })()
    this.stopTask = task
    try { await task } finally { if (this.stopTask === task) this.stopTask = undefined }
  }

  private async startNodes(resolved: InterfaceSnapshot[], generation: number): Promise<void> {
    for (const interfaceInfo of resolved) {
        const node = this.createMdns({ interface: interfaceInfo.address, bind: '0.0.0.0', reuseAddr: true })
        this.nodes.set(interfaceInfo.address, { node, interfaceInfo })
        node.on('error', error => this.logger.warn('REMOTE_DISCOVERY_SOCKET_ERROR', { code: safeErrorCode(error) }))
        node.on('warning', error => this.logger.warn('REMOTE_DISCOVERY_SOCKET_WARNING', { code: safeErrorCode(error) }))
        node.on('response', (packet, rinfo) => {
          if (this.stopped || generation !== this.generation) return
          if (!this.isSourceOnInterface(rinfo?.address, interfaceInfo)) return
          this.acceptPacket(packet, interfaceInfo)
        })
        await new Promise<void>((resolve, reject) => {
          const cancel = (error: Error): void => { cleanup(); reject(error) }
          const cleanup = (): void => {
            node.removeListener('ready', onReady)
            node.removeListener('error', onError)
            this.pendingReadyRejectors.delete(cancel)
          }
          const onReady = (): void => { cleanup(); resolve() }
          const onError = (error: Error): void => { cleanup(); reject(error) }
          this.pendingReadyRejectors.add(cancel)
          node.once('ready', onReady)
          node.once('error', onError)
        })
        if (this.stopped || generation !== this.generation) throw new Error('REMOTE_DISCOVERY_STOPPED')
        node.query(`_${REMOTE_DISCOVERY_TYPE}._tcp.local`, 'PTR')
    }
    this.started = true
    this.updatedAt = this.now()
    this.lastNetworkRefreshAt = this.now()
    this.sweepTimer = this.setTimer(() => this.sweep(), 1000)
    this.publish()
  }

  private isSourceOnInterface(address: string | undefined, interfaceInfo: InterfaceSnapshot): boolean {
    return typeof address === 'string' && isIP(address) === 4 && isPrivateIpv4(address) &&
      sameSubnet(address, interfaceInfo.address, interfaceInfo.netmask)
  }

  private acceptPacket(packet: MdnsPacket, interfaceInfo: InterfaceSnapshot): void {
    if (this.stopped) return
    const incoming = (packet.answers ?? []).slice(0, 256)
    if (incoming.length < 256) incoming.push(...(packet.additionals ?? []).slice(0, 256 - incoming.length))
    const valid = this.relevantRecords(incoming.filter(record => this.validRecord(record)), interfaceInfo.address)
    const flushSets = new Set(valid.filter(record => record.flush && ['SRV', 'TXT', 'A'].includes(record.type))
      .map(record => `${record.name.toLowerCase()}|${record.type}`))
    for (const set of flushSets) {
      for (const [key, item] of this.records) {
        if (item.interfaceAddress === interfaceInfo.address &&
            `${item.record.name.toLowerCase()}|${item.record.type}` === set) this.records.delete(key)
      }
    }
    const now = this.now()
    for (const record of valid) {
      const key = this.recordKey(record, interfaceInfo.address)
      if (record.ttl <= 0) this.records.delete(key)
      else if (this.records.has(key)) this.records.set(key, { record, expiresAt: now + Math.min(record.ttl, 120) * 1000,
        interfaceAddress: interfaceInfo.address })
      else if (this.records.size < 512) this.records.set(key, { record, expiresAt: now + Math.min(record.ttl, 120) * 1000,
        interfaceAddress: interfaceInfo.address })
      else this.logger.warn('REMOTE_DISCOVERY_RECORD_LIMIT_REACHED')
    }
    this.rebuildCandidates(interfaceInfo, now)
    this.updatedAt = now
    this.publish()
  }

  private validRecord(record: MdnsRecord): boolean {
    if (typeof record.name !== 'string' || record.name.length > 255 ||
        record.name.split('.').some(label => label.length > 63 || /[^\x21-\x7e]/.test(label)) ||
        !Number.isFinite(record.ttl) || record.ttl < 0) return false
    const serviceTypeName = `_${REMOTE_DISCOVERY_TYPE}._tcp.local`.toLowerCase()
    const serviceInstanceSuffix = `.${serviceTypeName}`
    if (record.type === 'PTR') return record.name.toLowerCase() === serviceTypeName &&
      typeof record.data === 'string' && record.data.length <= 255 && record.data.toLowerCase().endsWith(serviceInstanceSuffix)
    if (['SRV', 'TXT'].includes(record.type) && !record.name.toLowerCase().endsWith(serviceInstanceSuffix)) return false
    if (record.type === 'A') return typeof record.data === 'string' && isIP(record.data) === 4
    if (record.type === 'SRV') {
      if (!record.data || typeof record.data !== 'object') return false
      const value = record.data as { target?: unknown; port?: unknown; priority?: unknown; weight?: unknown }
      return typeof value.target === 'string' && value.target.length <= 255 && Number.isInteger(value.port) &&
        Number(value.port) >= 1024 && Number(value.port) <= 65535 &&
        (value.priority === undefined || Number.isInteger(value.priority)) &&
        (value.weight === undefined || Number.isInteger(value.weight))
    }
    if (record.type === 'TXT') {
      if (!Array.isArray(record.data) || record.data.length > 16) return false
      let total = 0
      for (const value of record.data) {
        const size = Buffer.isBuffer(value) ? value.length : typeof value === 'string' ? Buffer.byteLength(value) : Infinity
        total += size
        if (size > 255 || total > REMOTE_LIMITS.maxTxtBytes) return false
      }
      return true
    }
    return false
  }

  private relevantRecords(records: MdnsRecord[], interfaceAddress: string): MdnsRecord[] {
    const serviceTypeName = `_${REMOTE_DISCOVERY_TYPE}._tcp.local`.toLowerCase()
    const serviceInstanceSuffix = `.${serviceTypeName}`
    const cached = [...this.records.values()]
      .filter(value => value.interfaceAddress === interfaceAddress)
      .map(value => value.record)
    const instances = new Set([...cached, ...records]
      .filter(record => record.type === 'PTR' && record.name.toLowerCase() === serviceTypeName && typeof record.data === 'string')
      .map(record => String(record.data).toLowerCase()))
    const targets = new Set([...cached, ...records]
      .filter(record => record.type === 'SRV' && instances.has(record.name.toLowerCase()) &&
        record.data && typeof record.data === 'object' && typeof (record.data as { target?: unknown }).target === 'string')
      .map(record => String((record.data as { target: string }).target).toLowerCase()))
    return records.filter(record => {
      if (record.type === 'PTR') return record.name.toLowerCase() === serviceTypeName &&
        typeof record.data === 'string' && record.data.toLowerCase().endsWith(serviceInstanceSuffix)
      if (record.type === 'SRV' || record.type === 'TXT') return instances.has(record.name.toLowerCase())
      if (record.type === 'A') return targets.has(record.name.toLowerCase())
      return false
    })
  }

  private recordKey(record: MdnsRecord, interfaceAddress: string): string {
    return `${interfaceAddress}|${record.name.toLowerCase()}|${record.type}|${JSON.stringify(record.data)}`
  }

  private rebuildCandidates(interfaceInfo: InterfaceSnapshot, now: number): void {
    for (const [key, value] of this.records) if (value.expiresAt <= now) this.records.delete(key)
    const records = [...this.records.values()]
      .filter(value => value.interfaceAddress === interfaceInfo.address)
      .map(value => value.record)
    const pointers = records.filter(record => record.type === 'PTR' &&
      record.name.toLowerCase() === `_${REMOTE_DISCOVERY_TYPE}._tcp.local` && typeof record.data === 'string')
    const validKeys = new Set<string>()
    for (const pointer of pointers.slice(0, REMOTE_LIMITS.maxCandidates)) {
      const instance = String(pointer.data)
      const srv = records.find(record => record.type === 'SRV' && record.name.toLowerCase() === instance.toLowerCase())
      const txtRecord = records.find(record => record.type === 'TXT' && record.name.toLowerCase() === instance.toLowerCase())
      if (!srv || !txtRecord || !srv.data || typeof srv.data !== 'object') continue
      const srvData = srv.data as { target?: unknown; port?: unknown }
      if (typeof srvData.target !== 'string' || !Number.isInteger(srvData.port)) continue
      const rawTxt = Array.isArray(txtRecord.data) ? txtRecord.data : []
      const txt: Record<string, unknown> = {}
      for (const field of rawTxt.slice(0, 16)) {
        const line = Buffer.isBuffer(field) ? field.toString('utf8') : String(field)
        const separator = line.indexOf('=')
        if (separator > 0 && line.length <= 255) txt[line.slice(0, separator)] = line.slice(separator + 1)
      }
      const addressRecords = records.filter(record => record.type === 'A' &&
        record.name.toLowerCase() === srvData.target!.toString().toLowerCase())
      const newestAddress = Math.max(0, ...addressRecords.map(record =>
        this.records.get(this.recordKey(record, interfaceInfo.address))?.expiresAt ?? 0))
      const addresses = addressRecords.filter(record =>
        (this.records.get(this.recordKey(record, interfaceInfo.address))?.expiresAt ?? 0) === newestAddress)
        .map(record => String(record.data))
      const serviceName = instance.split('.')[0] || 'Player encontrado'
      const candidate = candidateFromService({ name: serviceName, fqdn: instance, txt,
        port: Number(srvData.port), ttl: Math.max(1, Math.floor((pointer.ttl || 120))), addresses }, interfaceInfo, now)
      if (!candidate) continue
      const key = `${interfaceInfo.address}|${instance.toLowerCase()}`
      validKeys.add(key)
      if (this.candidates.has(key) || this.candidates.size < REMOTE_LIMITS.maxCandidates) this.candidates.set(key, candidate)
    }
    for (const key of this.candidates.keys()) if (key.startsWith(`${interfaceInfo.address}|`) && !validKeys.has(key)) this.candidates.delete(key)
  }

  private sweep(): void {
    if (this.stopped) return
    const now = this.now()
    const beforeRecords = this.records.size
    const beforeCandidates = this.candidates.size
    for (const [key, record] of this.records) if (record.expiresAt <= now) this.records.delete(key)
    for (const { interfaceInfo } of this.nodes.values()) this.rebuildCandidates(interfaceInfo, now)
    if (beforeRecords !== this.records.size || beforeCandidates !== this.candidates.size) {
      this.updatedAt = now
      this.publish()
    }
    if (now - this.lastNetworkRefreshAt >= MDNS_REFRESH_INTERVAL_MS) {
      void this.refresh().catch(error => this.logger.warn('REMOTE_DISCOVERY_REFRESH_FAILED', { code: safeErrorCode(error) }))
    }
  }

  private queryNodes(): void {
    for (const [address, { node }] of this.nodes) {
      if (this.stopped || this.nodes.get(address)?.node !== node) continue
      try { node.query(`_${REMOTE_DISCOVERY_TYPE}._tcp.local`, 'PTR') }
      catch (error) { this.logger.warn('REMOTE_DISCOVERY_QUERY_FAILED', { code: safeErrorCode(error) }) }
    }
  }

  private publish(): void {
    const snapshot = this.getSnapshot()
    for (const listener of [...this.listeners]) {
      try { listener(snapshot) } catch { this.logger.warn('REMOTE_DISCOVERY_LISTENER_FAILED') }
    }
  }
}

/** Announces only the explicitly selected IPv4 interface, with a minimal public TXT record. */
export class BonjourPlayerAdvertisementPort implements PlayerAdvertisementPort {
  private mdns: MdnsNode | undefined
  private records: MdnsRecord[] = []
  private started = false
  private stopped = false
  private lifecycleTask: Promise<void> = Promise.resolve()

  constructor(
    private readonly logger: RemoteTransportLogger = noopLogger,
    private readonly createMdns: MdnsFactory = createMulticastDns,
    private readonly resolveInterface: (address: string) => InterfaceSnapshot | undefined = getInterfaceSnapshot
  ) {}

  async start(advertisement: PlayerAdvertisement): Promise<void> {
    return this.enqueueLifecycle(() => this.startCurrent(advertisement))
  }

  async update(advertisement: PlayerAdvertisement): Promise<void> {
    return this.enqueueLifecycle(async () => {
      if (this.stopped) throw new Error('REMOTE_ADVERTISEMENT_STOPPED')
      if (this.started) await this.stopCurrent(true)
      await this.startCurrent(advertisement)
    })
  }

  async stop(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      if (this.stopped) return
      this.stopped = true
      await this.stopCurrent(true)
    })
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const task = this.lifecycleTask.then(operation, operation)
    this.lifecycleTask = task.catch(() => undefined)
    return task
  }

  private async startCurrent(advertisement: PlayerAdvertisement): Promise<void> {
    if (this.started) throw new Error('REMOTE_ADVERTISEMENT_ALREADY_STARTED')
    if (this.stopped) throw new Error('REMOTE_ADVERTISEMENT_STOPPED')
    const interfaceInfo = this.resolveInterface(advertisement.address)
    if (!interfaceInfo || !Number.isInteger(advertisement.port) || advertisement.port < 1024 || advertisement.port > 65535 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(advertisement.deviceId)) {
      throw new Error('REMOTE_ADVERTISEMENT_INVALID')
    }
    const name = sanitizeDisplayName(advertisement.displayName, 'Karaoke Player')
    const serviceInstance = `Karaoke-${advertisement.deviceId}`
    const serviceFqdn = `${serviceInstance}._${REMOTE_DISCOVERY_TYPE}._tcp.local`
    const host = `player-${advertisement.deviceId}.local`
    this.records = [
      { name: `_${REMOTE_DISCOVERY_TYPE}._tcp.local`, type: 'PTR', ttl: MDNS_TTL_SECONDS, data: serviceFqdn },
      { name: serviceFqdn, type: 'SRV', ttl: MDNS_TTL_SECONDS, flush: true,
        data: { port: advertisement.port, priority: 0, weight: 0, target: host } },
      { name: serviceFqdn, type: 'TXT', ttl: MDNS_TTL_SECONDS,
        flush: true, data: [Buffer.from('version=1'), Buffer.from(`deviceId=${advertisement.deviceId}`), Buffer.from(`name=${name}`)] },
      { name: host, type: 'A', ttl: MDNS_TTL_SECONDS, flush: true, data: advertisement.address }
    ]
    const mdns = this.createMdns({ interface: interfaceInfo.address, bind: '0.0.0.0', reuseAddr: true })
    mdns.on('error', error => this.logger.warn('REMOTE_ADVERTISEMENT_SOCKET_ERROR', { code: safeErrorCode(error) }))
    mdns.on('warning', error => this.logger.warn('REMOTE_ADVERTISEMENT_WARNING', { code: safeErrorCode(error) }))
    mdns.on('query', (packet, rinfo) => {
      if (!this.isSourceOnInterface(rinfo?.address, interfaceInfo)) return
      const questions = packet.questions ?? []
      const serviceName = `_${REMOTE_DISCOVERY_TYPE}._tcp.local`
      const hostName = `player-${advertisement.deviceId}.local`
      const selected = questions.some(question => question.name.toLowerCase() === serviceName.toLowerCase() &&
        (question.type === 'PTR' || question.type === 'ANY')) ? this.records
        : questions.some(question => question.name.toLowerCase() === serviceFqdn.toLowerCase() &&
          ['SRV', 'TXT', 'ANY'].includes(question.type)) ? this.records.slice(1)
          : questions.some(question => question.name.toLowerCase() === hostName.toLowerCase() &&
            ['A', 'ANY'].includes(question.type)) ? this.records.slice(3)
            : []
      if (!selected.length) return
      const answers = selected.filter(record => questions.some(question => question.name.toLowerCase() === record.name.toLowerCase() &&
        (question.type === record.type || question.type === 'ANY' || record.type === 'PTR')))
      const additionals = this.records.filter(record => record.type === 'SRV' || record.type === 'TXT' || record.type === 'A')
      mdns.respond({ answers: answers.length ? answers : selected, additionals }, error => {
        if (error) this.logger.warn('REMOTE_ADVERTISEMENT_RESPONSE_FAILED', { code: safeErrorCode(error) })
      })
    })
    this.mdns = mdns
    this.started = true
    await new Promise<void>((resolve, reject) => {
      try { mdns.respond({ answers: this.records, additionals: [] }, error => error ? reject(error) : resolve()) }
      catch (error) { reject(error) }
    })
    .catch(async error => {
      this.mdns = undefined
      this.started = false
      this.records = []
      await new Promise<void>(resolve => mdns.destroy(resolve))
      throw error
    })
  }

  private isSourceOnInterface(address: string | undefined, interfaceInfo: InterfaceSnapshot): boolean {
    return typeof address === 'string' && isIP(address) === 4 && isPrivateIpv4(address) &&
      sameSubnet(address, interfaceInfo.address, interfaceInfo.netmask)
  }

  private async stopCurrent(goodbye: boolean): Promise<void> {
    const mdns = this.mdns
    this.mdns = undefined
    this.started = false
    if (!mdns) return
    if (goodbye && this.records.length) {
      const records = this.records.map(record => ({ ...record, ttl: 0 }))
      await new Promise<void>(resolve => {
        try { mdns.respond({ answers: records, additionals: [] }, () => resolve()) }
        catch { resolve() }
      })
    }
    this.records = []
    await new Promise<void>(resolve => mdns.destroy(resolve))
  }
}
