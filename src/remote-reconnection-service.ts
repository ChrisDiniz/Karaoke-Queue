import type { DiscoveryCandidate } from './remote-contracts'

export type RemoteConnectionState = 'disabled' | 'backoff' | 'connecting' | 'authorized' | 'reconciling' |
  'synchronized' | 'conflict' | 'recovery_required' | 'stopping' | 'blocked' | 'closed'

export interface SavedRemotePeer {
  readonly playerId: string
  readonly fingerprintSha256: string
  readonly serverName: string
  readonly port: number
  readonly lastAddress?: string
  readonly active: boolean
  readonly credentialGeneration: number
}

export interface RemotePeerChannel {
  readonly connectionId: string
  readonly playerId: string
  readonly fingerprintSha256: string
  readonly credentialGeneration: number
  close(): Promise<void> | void
  onClose?(listener: () => void): () => void
}

export interface RemoteReconnectPort {
  /** Must verify TLS pin/SAN and current G2 authorization before returning a channel. */
  connect(peer: SavedRemotePeer, address: string, signal: AbortSignal, port?: number): Promise<RemotePeerChannel>
  /** Performs only G3 snapshot/replay/status reconciliation; never takes operational control. */
  reconcile(peer: SavedRemotePeer, channel: RemotePeerChannel, signal: AbortSignal): Promise<
    { state: 'synchronized' } | { state: 'recovery_required'; reason: string }>
  isAuthorizationCurrent(peer: SavedRemotePeer, channel: RemotePeerChannel): Promise<boolean>
}

export interface RemoteReconnectClock {
  now(): number
  random(): number
  setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimer(timer: ReturnType<typeof setTimeout>): void
}

const systemClock: RemoteReconnectClock = {
  now: () => Date.now(), random: () => Math.random(),
  setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: timer => clearTimeout(timer)
}

export interface RemotePeerStatus {
  readonly playerId: string
  readonly state: RemoteConnectionState
  readonly reason: string | null
  readonly connectionId: string | null
  readonly synchronized: boolean
  readonly retryAt: number | null
}

interface ReconnectionEntry {
  peer: SavedRemotePeer; candidates: DiscoveryCandidate[]; addressCursor: number; attempt: number; token: number;
  state: RemoteConnectionState; reason: string | null; channel?: RemotePeerChannel; abort?: AbortController;
  retryDelay: number; removeCloseListener?: () => void; timer?: ReturnType<typeof setTimeout>;
  retryAt: number | null; task?: Promise<void>
}

interface QueuedAttempt { entry: ReconnectionEntry; resolve(): void; reject(error: Error): void }

/** One Main-owned scheduler and elected channel per trusted Player. Discovery only supplies addresses. */
export class RemoteReconnectionService {
  private readonly entries = new Map<string, ReconnectionEntry>()
  private readonly queuedAttempts: QueuedAttempt[] = []
  private activeAttempt: ReconnectionEntry | undefined
  private enabled = false
  private closed = false
  private lifecycleGeneration = 0
  private readonly channelCloseTasks = new WeakMap<RemotePeerChannel, Promise<void>>()

  constructor(private readonly port: RemoteReconnectPort, private readonly clock: RemoteReconnectClock = systemClock,
    private readonly publish: (status: RemotePeerStatus) => void = () => undefined) {}

  async start(peers: readonly SavedRemotePeer[]): Promise<void> {
    this.assertOpen()
    if (!this.enabled) this.lifecycleGeneration++
    this.enabled = true
    for (const peer of peers) {
      if (!peer.active || !peer.playerId || !/^[a-f0-9]{64}$/.test(peer.fingerprintSha256) ||
          !peer.serverName || !Number.isSafeInteger(peer.credentialGeneration)) continue
      const existing = this.entries.get(peer.playerId)
      if (existing) {
        if (existing.peer.fingerprintSha256 !== peer.fingerprintSha256 ||
            existing.peer.credentialGeneration !== peer.credentialGeneration) {
          await this.fence(existing, 'PEER_IDENTITY_CHANGED')
          existing.state = 'conflict'; existing.reason = 'PEER_IDENTITY_CHANGED'; this.emit(existing)
        } else existing.peer = peer
        if (existing.state === 'disabled' || existing.state === 'stopping') {
          existing.state = 'backoff'; existing.reason = null
        }
        continue
      }
      this.entries.set(peer.playerId, { peer, candidates: [], addressCursor: 0, attempt: 0, token: 0,
        state: 'backoff', reason: null, retryAt: null, retryDelay: 0 })
    }
    for (const entry of this.entries.values()) this.schedule(entry, 0)
  }

  updateDiscovery(candidates: readonly DiscoveryCandidate[]): void {
    if (!this.enabled || this.closed) return
    const now = this.clock.now()
    for (const entry of this.entries.values()) {
      entry.candidates = candidates.filter(candidate => candidate.expiresAt > now && candidate.verified === false &&
        candidate.deviceIdClaim === entry.peer.playerId &&
        candidate.addresses.length > 0).slice(0, 64)
      if (entry.candidates.length && entry.state === 'backoff') this.schedule(entry, 0)
    }
  }

  /** Explicitly fences operational authorization. A socket may be retained only by caller policy. */
  async disable(): Promise<void> {
    this.enabled = false
    const lifecycle = ++this.lifecycleGeneration
    for (const entry of this.entries.values()) {
      entry.state = 'stopping'; entry.reason = 'REMOTE_DISABLED'; this.emit(entry)
    }
    await Promise.all([...this.entries.values()].map(async entry => {
      try {
        await this.fence(entry, 'REMOTE_DISABLED')
        if (lifecycle === this.lifecycleGeneration && !this.enabled && !this.closed) {
          entry.state = 'disabled'; entry.reason = 'REMOTE_DISABLED'
        }
      } catch {
        if (lifecycle === this.lifecycleGeneration && !this.enabled && !this.closed) {
          entry.state = 'blocked'; entry.reason = 'CHANNEL_CLOSE_FAILED'
        }
      }
      if (lifecycle === this.lifecycleGeneration && !this.enabled && !this.closed) this.emit(entry)
    }))
  }

  status(playerId: string): RemotePeerStatus | null {
    const entry = this.entries.get(playerId)
    return entry ? this.snapshot(entry) : null
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.enabled = false
    this.closed = true
    ++this.lifecycleGeneration
    const entries = [...this.entries.values()]
    for (const entry of entries) {
      entry.state = 'stopping'; this.emit(entry)
      try { await this.fence(entry, 'REMOTE_SHUTDOWN') }
      catch { entry.state = 'blocked'; entry.reason = 'CHANNEL_CLOSE_FAILED'; this.emit(entry); continue }
      const task = entry.task
      if (task) await task.catch(() => undefined)
      if (entry.channel) {
        try { await this.closeChannel(entry.channel); entry.channel = undefined; entry.state = 'closed' }
        catch { entry.state = 'blocked'; entry.reason = 'CHANNEL_CLOSE_FAILED' }
      } else entry.state = 'closed'
      this.emit(entry)
    }
  }

  private assertOpen(): void { if (this.closed) throw new Error('REMOTE_RECONNECT_CLOSED') }

  private schedule(entry: NonNullable<ReturnType<typeof this.entries.get>>, delay: number): void {
    if (!this.enabled || this.closed || entry.timer || entry.task) return
    entry.state = 'backoff'; entry.retryAt = this.clock.now() + delay; this.emit(entry)
    entry.timer = this.clock.setTimer(() => {
      entry.timer = undefined; entry.retryAt = null
      const queuedTask = this.dispatchAttempt(entry)
      entry.task = queuedTask
      void queuedTask.finally(() => {
        if (entry.task === queuedTask) entry.task = undefined
        if (entry.state === 'backoff' && this.enabled && !this.closed) this.schedule(entry, entry.retryDelay)
      })
    }, delay)
  }

  private dispatchAttempt(entry: ReconnectionEntry): Promise<void> {
    return new Promise((resolve, reject) => {
      const queued = { entry, resolve, reject }
      if (this.activeAttempt) {
        entry.state = 'backoff'; entry.reason = 'RECONNECT_SLOT_BUSY'; entry.retryAt = null; this.emit(entry)
        this.queuedAttempts.push(queued)
        return
      }
      this.runAttempt(queued)
    })
  }

  private runAttempt(queued: QueuedAttempt): void {
    const { entry } = queued
    if (this.closed || !this.enabled || !entry.peer.active || entry.state === 'disabled' || entry.state === 'stopping') {
      queued.resolve()
      this.pumpAttempts()
      return
    }
    this.activeAttempt = entry
    void this.attempt(entry).then(queued.resolve, error => queued.reject(error)).finally(() => {
      if (this.activeAttempt === entry) this.activeAttempt = undefined
      this.pumpAttempts()
    })
  }

  private pumpAttempts(): void {
    if (this.activeAttempt) return
    while (this.queuedAttempts.length) {
      const queued = this.queuedAttempts.shift()!
      if (this.closed || !this.enabled || !queued.entry.peer.active || queued.entry.state === 'disabled' ||
          queued.entry.state === 'stopping' || queued.entry.state === 'conflict' || queued.entry.state === 'recovery_required') {
        queued.resolve()
        continue
      }
      this.runAttempt(queued)
      return
    }
  }

  private async attempt(entry: ReconnectionEntry): Promise<void> {
    if (!this.enabled || this.closed || !entry.peer.active) return
    const token = ++entry.token
    const abort = new AbortController(); entry.abort = abort
    const isCurrent = (channel?: RemotePeerChannel): boolean =>
      !this.closed && this.enabled && entry.peer.active && token === entry.token && !abort.signal.aborted &&
      (channel === undefined || entry.channel === channel || entry.channel === undefined)
    const closeStale = async (stale: RemotePeerChannel): Promise<void> => {
      if (entry.channel === stale) {
        entry.removeCloseListener?.(); entry.removeCloseListener = undefined
        entry.channel = undefined
      }
      await this.closeChannel(stale).catch(() => undefined)
    }
    const candidates = this.addresses(entry)
    if (!candidates.length) { this.failed(entry, 'NO_TRUSTED_ENDPOINT'); return }
    entry.state = 'connecting'; entry.reason = null; this.emit(entry)
    let channel: RemotePeerChannel | undefined
    try {
      let lastError = 'REMOTE_CONNECT_FAILED'
      for (const endpoint of candidates) {
        if (abort.signal.aborted || token !== entry.token) return
        try {
          channel = await this.port.connect(entry.peer, endpoint.address, abort.signal, endpoint.port)
          if (!isCurrent()) { await closeStale(channel); return }
          break
        }
        catch (error) {
          if (!isCurrent()) return
          lastError = error instanceof Error ? error.message : 'REMOTE_CONNECT_FAILED'
          if (lastError === 'REMOTE_PLAYER_RECOVERY_REQUIRED') {
            entry.state = 'recovery_required'; entry.reason = lastError; this.emit(entry)
            return
          }
          if (lastError === 'REMOTE_CERTIFICATE_PIN_MISMATCH' || lastError === 'REMOTE_IDENTITY_MISMATCH' ||
              lastError === 'REMOTE_AUTHORIZATION_REVOKED') {
            entry.state = 'conflict'; entry.reason = lastError; this.emit(entry)
            return
          }
        }
      }
      if (!channel) { if (isCurrent()) this.failed(entry, lastError); return }
      if (!isCurrent()) { await closeStale(channel); return }
      if (channel.playerId !== entry.peer.playerId || channel.fingerprintSha256 !== entry.peer.fingerprintSha256 ||
          channel.credentialGeneration !== entry.peer.credentialGeneration) {
        await closeStale(channel)
        if (isCurrent()) { entry.state = 'conflict'; entry.reason = 'REMOTE_IDENTITY_MISMATCH'; this.emit(entry) }
        return
      }
      const initiallyAuthorized = await this.port.isAuthorizationCurrent(entry.peer, channel)
      if (!isCurrent()) { await closeStale(channel); return }
      if (!initiallyAuthorized) {
        await closeStale(channel)
        if (isCurrent()) { entry.state = 'conflict'; entry.reason = 'REMOTE_AUTHORIZATION_REVOKED'; this.emit(entry) }
        return
      }
      entry.channel = channel; entry.state = 'authorized'; entry.reason = null; this.emit(entry)
      entry.removeCloseListener?.()
      entry.removeCloseListener = channel.onClose?.(() => {
        if (entry.token !== token || entry.channel !== channel || this.closed || !this.enabled) return
        entry.removeCloseListener?.(); entry.removeCloseListener = undefined
        entry.channel = undefined; ++entry.token; entry.attempt = Math.min(entry.attempt + 1, 5)
        const base = Math.min(30_000, 1000 * 2 ** (entry.attempt - 1))
        entry.retryDelay = Math.min(30_000, Math.round(base * (0.8 + Math.max(0, Math.min(1, this.clock.random())) * 0.4)))
        entry.reason = 'REMOTE_CHANNEL_CLOSED'; entry.state = 'backoff'; this.emit(entry)
        this.schedule(entry, entry.retryDelay)
      })
      if (!isCurrent(channel)) { await closeStale(channel); return }
      entry.state = 'reconciling'; this.emit(entry)
      const result = await this.port.reconcile(entry.peer, channel, abort.signal)
      if (!isCurrent(channel) || entry.channel !== channel) { await closeStale(channel); return }
      const stillAuthorized = await this.port.isAuthorizationCurrent(entry.peer, channel)
      if (!isCurrent(channel) || entry.channel !== channel) { await closeStale(channel); return }
      if (!stillAuthorized) {
        await closeStale(channel)
        if (isCurrent()) { entry.state = 'conflict'; entry.reason = 'REMOTE_AUTHORIZATION_REVOKED'; this.emit(entry) }
        return
      }
      if (result.state === 'recovery_required') {
        entry.state = 'recovery_required'; entry.reason = result.reason; this.emit(entry); return
      }
      entry.state = 'synchronized'; entry.reason = null; entry.attempt = 0; this.emit(entry)
    } catch (error) {
      if (channel) {
        if (entry.channel === channel) {
          entry.removeCloseListener?.(); entry.removeCloseListener = undefined
          entry.channel = undefined
        }
        await this.closeChannel(channel).catch(() => undefined)
      }
      if (isCurrent()) this.failed(entry, error instanceof Error ? error.message : 'REMOTE_RECOVERY_FAILED')
    } finally { if (entry.abort === abort) entry.abort = undefined }
  }

  private addresses(entry: ReconnectionEntry): Array<{ address: string; port: number }> {
    const now = this.clock.now()
    const values: Array<{ address: string; port: number }> = []
    if (entry.peer.lastAddress) values.push({ address: entry.peer.lastAddress, port: entry.peer.port })
    const candidates = entry.candidates.filter(item => item.expiresAt > now)
    if (candidates.length) {
      const start = entry.addressCursor++ % candidates.length
      for (let offset = 0; offset < candidates.length; offset++) {
        const candidate = candidates[(start + offset) % candidates.length]
        for (const address of candidate.addresses) {
          if (!values.some(item => item.address === address && item.port === candidate.port)) values.push({ address, port: candidate.port })
        }
      }
    }
    return values.slice(0, 64)
  }

  private failed(entry: ReconnectionEntry, reason: string): void {
    entry.reason = reason
    entry.attempt = Math.min(entry.attempt + 1, 5)
    const base = Math.min(30_000, 1000 * 2 ** (entry.attempt - 1))
    const jitter = 0.8 + Math.max(0, Math.min(1, this.clock.random())) * 0.4
    entry.state = 'backoff'; this.emit(entry)
    entry.retryDelay = Math.min(30_000, Math.round(base * jitter))
  }

  private async fence(entry: ReconnectionEntry, reason: string): Promise<void> {
    if (entry.timer) this.clock.clearTimer(entry.timer)
    entry.timer = undefined; entry.retryAt = null; ++entry.token
    entry.abort?.abort(new Error(reason)); entry.abort = undefined
    const queuedIndex = this.queuedAttempts.findIndex(item => item.entry === entry)
    if (queuedIndex >= 0) this.queuedAttempts.splice(queuedIndex, 1)[0].resolve()
    const channel = entry.channel; entry.channel = undefined
    entry.removeCloseListener?.(); entry.removeCloseListener = undefined
    if (channel) await this.closeChannel(channel)
  }

  private closeChannel(channel: RemotePeerChannel): Promise<void> {
    const active = this.channelCloseTasks.get(channel)
    if (active) return active
    const task = Promise.resolve().then(() => channel.close()).then(() => undefined)
    this.channelCloseTasks.set(channel, task)
    void task.catch(() => { if (this.channelCloseTasks.get(channel) === task) this.channelCloseTasks.delete(channel) })
    return task
  }

  private snapshot(entry: ReconnectionEntry): RemotePeerStatus {
    return { playerId: entry.peer.playerId, state: entry.state, reason: entry.reason,
      connectionId: entry.channel?.connectionId ?? null, synchronized: entry.state === 'synchronized', retryAt: entry.retryAt }
  }
  private emit(entry: ReconnectionEntry): void { this.publish(this.snapshot(entry)) }
}
