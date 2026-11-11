import crypto from 'node:crypto'
import type { ReadStream } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { Protocol } from 'electron'
import { isCanonicalVideoCode } from './video-library'
import type { VideoLibraryService } from './video-library-service'
import type { PlayerMediaGrant } from './player-playback-contracts'

export const PLAYER_MEDIA_SCHEME = 'kq-media'
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/

interface MediaCapability {
  musicCode: string
  inventoryRevision: string
  streams: Set<ReadStream>
}

export interface PlayerMediaProtocolDiagnosticMetrics {
  requests: number
  rangeRequests: number
  fileHandlesOpened: number
  fileHandlesClosed: number
  fileHandleCloseFailures: number
  streamsOpened: number
  streamsClosed: number
  activeStreams: number
  activeGrants: number
  bytesRead: number
}

function emptyDiagnosticMetrics(): PlayerMediaProtocolDiagnosticMetrics {
  return { requests: 0, rangeRequests: 0, fileHandlesOpened: 0, fileHandlesClosed: 0,
    fileHandleCloseFailures: 0, streamsOpened: 0, streamsClosed: 0, activeStreams: 0, activeGrants: 0, bytesRead: 0 }
}

function mediaType(extension: string): string {
  switch (extension) {
    case '.mp4': case '.m4v': return 'video/mp4'
    case '.webm': return 'video/webm'
    case '.mkv': return 'video/x-matroska'
    case '.avi': return 'video/x-msvideo'
    case '.mov': return 'video/quicktime'
    case '.mpeg': case '.mpg': return 'video/mpeg'
    case '.wmv': return 'video/x-ms-wmv'
    default: return 'application/octet-stream'
  }
}

function response(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers })
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | 'invalid' | undefined {
  if (!value) return undefined
  const match = RANGE_PATTERN.exec(value.trim())
  if (!match || size <= 0) return 'invalid'
  let start: number
  let end: number
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid'
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return 'invalid'
  }
  return { start, end: Math.min(end, size - 1) }
}

/** Register before Electron becomes ready. No CSP bypass or general filesystem privilege is granted. */
export function registerPlayerMediaScheme(protocol: Protocol): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: PLAYER_MEDIA_SCHEME,
    privileges: { standard: true, secure: true, stream: true }
  }])
}

/** Main-process media capability registry. URLs identify only a current indexed code, never a path. */
export class PlayerMediaProtocol {
  private readonly capabilities = new Map<string, MediaCapability>()
  private readonly collectDiagnostics = process.env.KQ_F0_DIAGNOSTICS === '1'
  private readonly diagnosticMetrics = emptyDiagnosticMetrics()
  private installed = false
  private disposed = false

  constructor(private readonly library: VideoLibraryService) {}

  /** Opt-in aggregate counters for F0; no URL, path, filename, or code is returned. */
  getDiagnosticMetrics(): PlayerMediaProtocolDiagnosticMetrics | undefined {
    return this.collectDiagnostics ? { ...this.diagnosticMetrics, activeGrants: this.capabilities.size } : undefined
  }

  install(protocol: Protocol): void {
    if (this.disposed) throw new Error('The player media protocol has been disposed.')
    if (this.installed) throw new Error('The player media protocol is already installed.')
    protocol.handle(PLAYER_MEDIA_SCHEME, request => this.handleRequest(request))
    this.installed = true
  }

  grant(musicCode: string, inventoryRevision: string): PlayerMediaGrant {
    if (this.disposed || !this.installed) throw new Error('The player media protocol is unavailable.')
    if (!isCanonicalVideoCode(musicCode) || !/^[a-f0-9]{64}$/.test(inventoryRevision)) {
      throw new Error('A media capability requires a canonical code and a valid inventory revision.')
    }
    const token = crypto.randomBytes(32).toString('base64url')
    const capability: MediaCapability = { musicCode, inventoryRevision, streams: new Set() }
    this.capabilities.set(token, capability)
    let active = true
    return {
      url: `${PLAYER_MEDIA_SCHEME}://playback/${token}`,
      revoke: () => {
        if (!active) return
        active = false
        this.capabilities.delete(token)
        for (const stream of capability.streams) stream.destroy()
      }
    }
  }

  dispose(protocol?: Protocol): void {
    if (this.disposed) return
    this.disposed = true
    for (const capability of this.capabilities.values()) {
      for (const stream of capability.streams) stream.destroy()
    }
    this.capabilities.clear()
    if (this.installed) protocol?.unhandle(PLAYER_MEDIA_SCHEME)
    this.installed = false
  }

  private async handleRequest(request: Request): Promise<Response> {
    if (this.disposed || !['GET', 'HEAD'].includes(request.method)) return response(405)
    if (this.collectDiagnostics) this.diagnosticMetrics.requests++
    let openHandle: FileHandle | undefined
    let stream: ReadStream | undefined
    try {
      const url = new URL(request.url)
      const token = url.hostname === 'playback' && /^\/[A-Za-z0-9_-]{43}$/.test(url.pathname)
        ? url.pathname.slice(1)
        : undefined
      const capability = token ? this.capabilities.get(token) : undefined
      if (!capability || url.search || url.hash) return response(404)

      const initiator = request.headers.get('Origin')
      if (initiator && initiator !== 'null' && initiator !== 'file://') return response(403)

      const authorized = () => !this.disposed && !request.signal.aborted && this.capabilities.get(token!) === capability
      if (!authorized()) return response(409)
      const opened = await this.library.openForPlayback(capability.musicCode, capability.inventoryRevision)
      if (opened.status !== 'available') return response(opened.status === 'missing' ? 404 : 409)
      openHandle = opened.handle
      if (this.collectDiagnostics) this.diagnosticMetrics.fileHandlesOpened++
      if (!authorized()) {
        await this.closeDiagnosticHandle(openHandle)
        openHandle = undefined
        return response(409)
      }
      const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': mediaType(opened.extension),
        'X-Content-Type-Options': 'nosniff'
      })
      const range = parseRange(request.headers.get('Range') ?? undefined, opened.size)
      if (range && this.collectDiagnostics) this.diagnosticMetrics.rangeRequests++
      if (range === 'invalid') {
        await this.closeDiagnosticHandle(openHandle)
        openHandle = undefined
        headers.set('Content-Range', `bytes */${opened.size}`)
        return new Response(null, { status: 416, headers })
      }
      if (request.method === 'HEAD') {
        await this.closeDiagnosticHandle(openHandle)
        openHandle = undefined
        headers.set('Content-Length', String(opened.size))
        return authorized() ? new Response(null, { status: 200, headers }) : response(409)
      }
      if (opened.size <= 0) {
        await this.closeDiagnosticHandle(openHandle)
        openHandle = undefined
        return response(422)
      }

      const start = range?.start ?? 0
      const end = range?.end ?? opened.size - 1
      stream = opened.handle.createReadStream({ start, end, autoClose: true })
      openHandle = undefined // The auto-closing stream now owns the handle.
      const ownedStream = stream
      const abort = () => ownedStream.destroy()
      capability.streams.add(ownedStream)
      request.signal.addEventListener('abort', abort, { once: true })
      ownedStream.once('close', () => {
        capability.streams.delete(ownedStream)
        request.signal.removeEventListener('abort', abort)
      })
      if (this.collectDiagnostics) {
        this.diagnosticMetrics.streamsOpened++
        this.diagnosticMetrics.activeStreams++
        stream.on('data', chunk => { this.diagnosticMetrics.bytesRead += Buffer.byteLength(chunk) })
        stream.once('close', () => {
          this.diagnosticMetrics.streamsClosed++
          this.diagnosticMetrics.activeStreams = Math.max(0, this.diagnosticMetrics.activeStreams - 1)
          this.diagnosticMetrics.fileHandlesClosed++
        })
      }
      headers.set('Content-Length', String(end - start + 1))
      if (range) headers.set('Content-Range', `bytes ${start}-${end}/${opened.size}`)
      const result = new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        status: range ? 206 : 200,
        headers
      })
      stream = undefined
      return result
    } catch {
      stream?.destroy()
      if (openHandle) await this.closeDiagnosticHandle(openHandle)
      return response(500)
    }
  }

  private async closeDiagnosticHandle(handle: FileHandle): Promise<void> {
    try {
      await handle.close()
      if (this.collectDiagnostics) this.diagnosticMetrics.fileHandlesClosed++
    } catch {
      if (this.collectDiagnostics) this.diagnosticMetrics.fileHandleCloseFailures++
    }
  }
}
