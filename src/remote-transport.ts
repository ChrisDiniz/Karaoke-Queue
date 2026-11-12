import { randomUUID } from 'node:crypto'
import https from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { performance } from 'node:perf_hooks'
import { WebSocket, WebSocketServer } from 'ws'
import { REMOTE_BOOTSTRAP_PATHS, REMOTE_CONTROL_PATH, REMOTE_CONTROL_SUBPROTOCOL,
  REMOTE_LIMITS, createTransportReady, denyAllRemoteAuthorization } from './remote-contracts'
import type { RemoteAuthorizationPort, RemoteBootstrapPort, RemoteDeviceIdentity,
  RemoteHttpResponse, RemoteHttpRoute, RemoteRequestContext, RemoteTransportChannel,
  RemoteTransportLogger, RemoteTransportMessagePort } from './remote-contracts'
import { isPrivateIpv4, validatePlayerCertificate } from './remote-tls'

interface TokenBucket { tokens: number; updatedAt: number }

class TokenBucketLimiter {
  private readonly buckets = new Map<string, TokenBucket>()
  constructor(private readonly maxEntries: number) {}

  consume(key: string, capacity: number, refillPerSecond: number, now = performance.now()): boolean {
    let bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= this.maxEntries) {
        const stale = [...this.buckets.entries()].find(([existingKey, value]) =>
          existingKey !== 'global' && existingKey !== 'bootstrap-global' && now - value.updatedAt > 120_000)
        if (!stale) return false
        this.buckets.delete(stale[0])
      }
      bucket = { tokens: capacity, updatedAt: now }
      this.buckets.set(key, bucket)
    }
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * refillPerSecond / 1000)
    bucket.updatedAt = now
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }
}

const noopLogger: RemoteTransportLogger = Object.freeze({
  info(): void {}, warn(): void {}, error(): void {}
})

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
  return /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN'
}

function sanitizeAddress(address: string | undefined): string | null {
  if (!address) return null
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

function hasExactlyOneHeader(request: IncomingMessage, wanted: string): boolean {
  let count = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === wanted.toLowerCase()) count++
  }
  return count === 1
}

function validateBoundedJson(body: Buffer): unknown {
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) }
  catch { throw new Error('REMOTE_MESSAGE_INVALID') }
  const pending: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }]
  let visited = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++visited > 4096 || depth > 8) throw new Error('REMOTE_MESSAGE_INVALID')
    if (typeof value === 'string' && value.length > 4096) throw new Error('REMOTE_MESSAGE_INVALID')
    if (Array.isArray(value)) {
      if (value.length > 128) throw new Error('REMOTE_MESSAGE_INVALID')
      for (const item of value) pending.push({ value: item, depth: depth + 1 })
    } else if (value && typeof value === 'object') {
      const entries = Object.entries(value)
      if (Object.getPrototypeOf(value) !== Object.prototype || entries.length > 32 ||
          entries.some(([key]) => key.length > 64)) throw new Error('REMOTE_MESSAGE_INVALID')
      for (const [, item] of entries) pending.push({ value: item, depth: depth + 1 })
    } else if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('REMOTE_MESSAGE_INVALID')
    }
  }
  return parsed
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function sendJson(response: ServerResponse, statusCode: number, code: string, extra?: Record<string, unknown>): void {
  const body = jsonBytes({ error: code, ...(extra ?? {}) })
  response.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': body.length,
    'Cache-Control': 'no-store', Connection: 'close' })
  response.end(body)
}

async function readBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = request.headers['content-length']
  if (declared && (!/^\d+$/.test(String(declared)) || Number(declared) > maximum)) throw new Error('REMOTE_BODY_TOO_LARGE')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    length += bytes.length
    if (length > maximum) throw new Error('REMOTE_BODY_TOO_LARGE')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string, controller: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(code))
    }, timeoutMs)
    timer.unref()
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

function isBearer(value: string | string[] | undefined): value is string {
  return typeof value === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(value)
}

function safeResponse(result: RemoteHttpResponse): { status: number; headers: Record<string, string>; body: Buffer } {
  const body = Buffer.from(result.body ?? new Uint8Array())
  if (!Number.isInteger(result.statusCode) || result.statusCode < 200 || result.statusCode > 599 ||
      body.length > REMOTE_LIMITS.maxHttpBodyBytes) throw new Error('REMOTE_HANDLER_RESPONSE_INVALID')
  const contentType = result.contentType ?? 'application/json'
  if (contentType !== 'application/json' && contentType !== 'application/octet-stream') {
    throw new Error('REMOTE_HANDLER_RESPONSE_INVALID')
  }
  return { status: result.statusCode, headers: { 'Content-Type': contentType, 'Content-Length': String(body.length),
    'Cache-Control': 'no-store', Connection: 'close' }, body }
}

export interface RemoteTransportServerOptions {
  identity: RemoteDeviceIdentity
  address: string
  port: number
  authorization?: RemoteAuthorizationPort
  bootstrap?: RemoteBootstrapPort
  routes?: readonly RemoteHttpRoute[]
  messagePort?: RemoteTransportMessagePort
  logger?: RemoteTransportLogger
}

export interface RemoteTransportServer {
  listen(): Promise<void>
  close(): Promise<void>
  address(): AddressInfo | null
  closeController(controllerId: string): void
}

/** Main-only bounded HTTPS/WSS server. With no G2 port, all control upgrades are denied. */
export function createRemoteTransportServer(options: RemoteTransportServerOptions): RemoteTransportServer {
  const { identity } = options
  if (identity.role !== 'player' || !identity.privateKeyPem || !identity.certificatePem ||
      !identity.certificateFingerprintSha256) throw new Error('REMOTE_PLAYER_IDENTITY_REQUIRED')
  const validatedIdentity = validatePlayerCertificate(identity.certificatePem, identity.privateKeyPem, identity.deviceId)
  if (validatedIdentity.fingerprintSha256 !== identity.certificateFingerprintSha256) {
    throw new Error('REMOTE_IDENTITY_FINGERPRINT_MISMATCH')
  }
  if (!isPrivateIpv4(options.address, options.address.startsWith('127.')) ||
      !Number.isInteger(options.port) || options.port < (options.port === 0 && options.address.startsWith('127.') ? 0 : 1024) ||
      options.port > 65535) throw new Error('REMOTE_BIND_ENDPOINT_INVALID')
  const authorization = options.authorization ?? denyAllRemoteAuthorization
  const logger = options.logger ?? noopLogger
  const routes = new Map<string, RemoteHttpRoute>()
  for (const route of options.routes ?? []) {
    if (!/^\/v1\/[A-Za-z0-9/_-]{1,120}$/.test(route.path) || route.path.includes('//') ||
        route.path.split('/').some(part => part === '.' || part === '..') ||
        routes.has(`${route.method} ${route.path}`)) throw new Error('REMOTE_ROUTE_INVALID')
    routes.set(`${route.method} ${route.path}`, route)
  }

  const server = https.createServer({
    key: identity.privateKeyPem,
    cert: identity.certificatePem,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    handshakeTimeout: REMOTE_LIMITS.tlsHandshakeTimeoutMs,
    maxHeaderSize: REMOTE_LIMITS.maxHttpHeaderBytes,
    requestCert: false
  })
  server.maxHeadersCount = REMOTE_LIMITS.maxHttpHeaders
  server.headersTimeout = REMOTE_LIMITS.httpHeadersTimeoutMs
  server.requestTimeout = REMOTE_LIMITS.httpRequestTimeoutMs
  server.keepAliveTimeout = REMOTE_LIMITS.httpKeepAliveTimeoutMs
  server.on('error', error => logger.error('REMOTE_SERVER_ERROR', { code: safeErrorCode(error) }))
  const webSockets = new WebSocketServer({ noServer: true, clientTracking: true, perMessageDeflate: false,
    maxPayload: REMOTE_LIMITS.maxWebSocketMessageBytes, maxFragments: 16,
    handleProtocols(protocols) { return protocols.has(REMOTE_CONTROL_SUBPROTOCOL) ? REMOTE_CONTROL_SUBPROTOCOL : false }
  })
  const sockets = new Set<Socket>()
  const addressCounts = new Map<string, number>()
  const rateLimiter = new TokenBucketLimiter(REMOTE_LIMITS.maxAddressEntries + 1)
  const activeChannels = new Map<WebSocket, { connectionId: string; peer: { controllerId: string; credentialGeneration: number; scopes: readonly string[] }; controllerId: string }>()
  const authorizationOperations = new Set<AbortController>()
  let controlSocket: WebSocket | undefined
  let listening = false
  let closing: Promise<void> | undefined
  let listenTask: Promise<void> | undefined
  let heartbeat: NodeJS.Timeout | undefined
  const heartbeatTimeouts = new Map<WebSocket, NodeJS.Timeout>()
  let controlReservation: string | undefined

  async function runAuthorizationOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (closing) throw new Error('REMOTE_TRANSPORT_CLOSING')
    const controller = new AbortController()
    authorizationOperations.add(controller)
    try { return await withTimeout(operation(controller.signal), REMOTE_LIMITS.authorizationTimeoutMs,
      'REMOTE_AUTH_TIMEOUT', controller) }
    finally { authorizationOperations.delete(controller) }
  }

  async function isPeerCurrent(peer: Parameters<RemoteAuthorizationPort['isCurrent']>[0], connectionId: string): Promise<boolean> {
    return runAuthorizationOperation(signal => Promise.resolve(authorization.isCurrent(peer, connectionId, signal)))
  }

  server.on('connection', rawSocket => {
    const socket = rawSocket as Socket
    const remoteAddress = sanitizeAddress(socket.remoteAddress)
    if (!remoteAddress || !isPrivateIpv4(remoteAddress, remoteAddress.startsWith('127.'))) {
      socket.destroy()
      return
    }
    const count = addressCounts.get(remoteAddress) ?? 0
    if (sockets.size >= REMOTE_LIMITS.maxGlobalConnections || count >= REMOTE_LIMITS.maxConnectionsPerAddress ||
        (count === 0 && addressCounts.size >= REMOTE_LIMITS.maxAddressEntries)) {
      logger.warn('REMOTE_CONNECTION_LIMIT_REACHED')
      socket.destroy()
      return
    }
    sockets.add(socket)
    addressCounts.set(remoteAddress, count + 1)
    socket.once('close', () => {
      if (!sockets.delete(socket)) return
      const current = addressCounts.get(remoteAddress) ?? 0
      if (current <= 1) addressCounts.delete(remoteAddress)
      else addressCounts.set(remoteAddress, current - 1)
    })
  })

  server.on('request', (request, response) => {
    void handleHttpRequest(request, response)
  })

  async function authorize(request: IncomingMessage, connectionId: string): Promise<{
    controllerId: string; credentialGeneration: number; scopes: readonly string[]
  } | null> {
    const remoteAddress = sanitizeAddress(request.socket.remoteAddress) ?? 'unknown'
    if (!rateLimiter.consume('global', 60, 1) || !rateLimiter.consume(`address:${remoteAddress}`, 10, 1 / 6)) {
      throw new Error('REMOTE_RATE_LIMITED')
    }
    if (!hasExactlyOneHeader(request, 'authorization') || !isBearer(request.headers.authorization)) {
      throw new Error('REMOTE_AUTH_REQUIRED')
    }
    const peer = await runAuthorizationOperation(signal =>
      authorization.authorizeBearer(request.headers.authorization!.slice(7), connectionId, signal))
    if (!peer) throw new Error('REMOTE_NOT_AUTHORIZED')
    return peer
  }

  async function handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (closing) return sendJson(response, 503, 'TRANSPORT_CLOSING')
      request.setTimeout(REMOTE_LIMITS.httpRequestTimeoutMs, () => request.destroy(new Error('REMOTE_REQUEST_TIMEOUT')))
      if (request.headers.origin !== undefined) return sendJson(response, 403, 'REQUEST_ORIGIN_REJECTED')
      if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.includes('?') || request.url.includes('#')) {
        return sendJson(response, 400, 'REQUEST_INVALID')
      }
      if (request.method === 'POST' && (REMOTE_BOOTSTRAP_PATHS as readonly string[]).includes(request.url)) {
        if (!options.bootstrap) return sendJson(response, 404, 'NOT_FOUND')
        if (request.headers.authorization !== undefined || request.headers.cookie !== undefined) {
          return sendJson(response, 400, 'BOOTSTRAP_CREDENTIAL_REJECTED')
        }
        if (request.headers['content-type']?.toLowerCase() !== 'application/json' ||
            !hasExactlyOneHeader(request, 'content-type')) return sendJson(response, 415, 'CONTENT_TYPE_INVALID')
        if (!rateLimiter.consume('bootstrap-global', 60, 1) ||
            !rateLimiter.consume(`bootstrap:${sanitizeAddress(request.socket.remoteAddress) ?? 'unknown'}`, 10, 1 / 6)) {
          return sendJson(response, 429, 'LIMIT_EXCEEDED')
        }
        const body = await readBody(request, REMOTE_LIMITS.maxHttpBodyBytes)
        if (!body.length) return sendJson(response, 400, 'REQUEST_INVALID')
        validateBoundedJson(body)
        const operation = request.url.endsWith('/request') ? 'request'
          : request.url.endsWith('/proof') ? 'proof' : 'confirm'
        const result = safeResponse(await options.bootstrap.handle({ connectionId: randomUUID(), operation, body,
          socket: request.socket }))
        response.writeHead(result.status, result.headers)
        response.end(result.body)
        return
      }

      const route = routes.get(`${request.method} ${request.url}`)
      if (!route) return sendJson(response, 404, 'NOT_FOUND')
      const body = request.method === 'GET' ? Buffer.alloc(0) : await readBody(request, REMOTE_LIMITS.maxHttpBodyBytes)
      if (body.length && request.headers['content-type']?.toLowerCase() !== 'application/json') {
        return sendJson(response, 415, 'CONTENT_TYPE_INVALID')
      }
      if (body.length) validateBoundedJson(body)
      const connectionId = randomUUID()
      const peer = await authorize(request, connectionId)
      if (!peer || !peer.scopes.includes(route.requiredScope)) return sendJson(response, 403, 'NOT_AUTHORIZED')
      const current = await isPeerCurrent(peer, connectionId)
      if (!current) return sendJson(response, 401, 'NOT_AUTHORIZED')
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string' && name !== 'authorization' && name !== 'cookie' && name !== 'set-cookie') headers[name] = value
      }
      const result = safeResponse(await route.handle({ connectionId, peer, method: request.method ?? 'GET',
        path: request.url, headers, body }))
      response.writeHead(result.status, result.headers)
      response.end(result.body)
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return }
      const code = error instanceof Error ? error.message : 'REMOTE_REQUEST_FAILED'
      const expected = new Set(['REMOTE_RATE_LIMITED', 'REMOTE_AUTH_REQUIRED', 'REMOTE_NOT_AUTHORIZED',
        'REMOTE_AUTH_TIMEOUT', 'REMOTE_BODY_TOO_LARGE', 'REMOTE_MESSAGE_INVALID'])
      const status = code === 'REMOTE_RATE_LIMITED' ? 429
        : code === 'REMOTE_AUTH_REQUIRED' ? 401
          : code === 'REMOTE_NOT_AUTHORIZED' ? 403
            : code === 'REMOTE_AUTH_TIMEOUT' ? 503
              : expected.has(code) ? 400 : 500
      sendJson(response, status, expected.has(code) ? code : 'REMOTE_REQUEST_FAILED')
    }
  }

  server.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket as TLSSocket, head)
  })

  async function handleUpgrade(request: IncomingMessage, socket: TLSSocket, head: Buffer): Promise<void> {
    let reservedId: string | undefined
    const reject = (status: number, code: string): void => {
      if (!socket.destroyed) {
        const body = Buffer.from(JSON.stringify({ error: code }))
        socket.end(`HTTP/1.1 ${status} ${status === 409 ? 'Conflict' : status === 429 ? 'Too Many Requests' : 'Unauthorized'}\r\n` +
          'Connection: close\r\nContent-Type: application/json\r\n' + `Content-Length: ${body.length}\r\n\r\n${body.toString('utf8')}`)
      }
    }
    try {
      if (closing) { socket.destroy(); return }
      if (request.method !== 'GET' || request.url !== REMOTE_CONTROL_PATH || request.headers.origin !== undefined ||
          request.headers['sec-websocket-protocol'] !== REMOTE_CONTROL_SUBPROTOCOL ||
          !hasExactlyOneHeader(request, 'sec-websocket-protocol')) return reject(400, 'UPGRADE_INVALID')
      const connectionId = randomUUID()
      const peer = await authorize(request, connectionId)
      if (closing || socket.destroyed) { socket.destroy(); return }
      if (!peer || !peer.scopes.includes('transport:control')) return reject(401, 'NOT_AUTHORIZED')
      if ((controlSocket && controlSocket.readyState < WebSocket.CLOSING) || controlReservation) {
        return reject(409, 'CONNECTION_BUSY')
      }
      controlReservation = connectionId
      reservedId = connectionId
      const isCurrent = await isPeerCurrent(peer, connectionId)
      if (closing || socket.destroyed) {
        if (controlReservation === connectionId) controlReservation = undefined
        reservedId = undefined
        socket.destroy()
        return
      }
      if (!isCurrent) {
        if (controlReservation === connectionId) controlReservation = undefined
        reservedId = undefined
        return reject(401, 'NOT_AUTHORIZED')
      }
      webSockets.handleUpgrade(request, socket, head, webSocket => {
        controlSocket = webSocket
        webSocket.on('error', () => webSocket.terminate())
        if (controlReservation === connectionId) controlReservation = undefined
        reservedId = undefined
        const channelInfo = { connectionId, peer, controllerId: peer.controllerId }
        activeChannels.set(webSocket, channelInfo)
        let handshakeComplete = false
        let pendingSendCount = 0
        const helloTimer = setTimeout(() => webSocket.close(1008, 'HELLO_TIMEOUT'), REMOTE_LIMITS.helloTimeoutMs)
        helloTimer.unref()
        const channel: RemoteTransportChannel = {
          connectionId,
          peer,
          send(data) {
            if (webSocket.readyState !== WebSocket.OPEN) return false
            const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
            if (payload.length > REMOTE_LIMITS.maxWebSocketMessageBytes ||
                webSocket.bufferedAmount + payload.length > REMOTE_LIMITS.maxBufferedBytes ||
                pendingSendCount >= REMOTE_LIMITS.maxPendingMessages) {
              webSocket.close(1013, 'BACKPRESSURE_LIMIT')
              return false
            }
            pendingSendCount++
            webSocket.send(payload, { binary: typeof data !== 'string' }, error => {
              pendingSendCount = Math.max(0, pendingSendCount - 1)
              if (error) webSocket.terminate()
            })
            return true
          },
          close(code = 1000, reason = 'CLOSED') { webSocket.close(code, reason.slice(0, 120)) }
        }
        let messageQueue = Promise.resolve()
        let pendingMessages = 0
        webSocket.on('message', (data, isBinary) => {
          if (webSocket.readyState !== WebSocket.OPEN) return
          if (!rateLimiter.consume(`channel:${connectionId}`, 40, 20, performance.now())) {
            webSocket.close(1008, 'RATE_LIMITED')
            return
          }
          if (isBinary) return webSocket.close(1003, 'TEXT_ONLY')
          const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          if (bytes.length > REMOTE_LIMITS.maxWebSocketMessageBytes) return webSocket.close(1009, 'MESSAGE_TOO_LARGE')
          if (pendingMessages >= REMOTE_LIMITS.maxPendingMessages) return webSocket.close(1013, 'BACKPRESSURE_LIMIT')
          pendingMessages++
          messageQueue = messageQueue.then(async () => {
            if (webSocket.readyState !== WebSocket.OPEN) return
            let payload: unknown
            try { payload = validateBoundedJson(bytes) }
            catch { return webSocket.close(1007, 'MESSAGE_INVALID') }
            if (!handshakeComplete) {
              if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return webSocket.close(1002, 'HELLO_REQUIRED')
              const hello = payload as Record<string, unknown>
              if (Object.keys(hello).sort().join(',') !== 'capabilities,transportVersion,type' ||
                  hello.type !== 'transport-hello' || hello.transportVersion !== 1 || !Array.isArray(hello.capabilities) ||
                  hello.capabilities.length > REMOTE_LIMITS.maxCapabilities ||
                  hello.capabilities.some(value => typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(value)) ||
                  new Set(hello.capabilities).size !== hello.capabilities.length) return webSocket.close(1002, 'HELLO_INVALID')
              if (!(await isPeerCurrent(peer, connectionId))) return webSocket.close(1008, 'REVOKED')
              handshakeComplete = true
              clearTimeout(helloTimer)
              channel.send(JSON.stringify(createTransportReady([])))
              return
            }
            if (!options.messagePort) return webSocket.close(1008, 'NO_OPERATIONAL_PROTOCOL')
            const current = await isPeerCurrent(peer, connectionId)
            if (!current) return webSocket.close(1008, 'REVOKED')
            if (webSocket.readyState !== WebSocket.OPEN) return
            options.messagePort.onMessage({ channel, payload })
          }).catch(() => webSocket.close(1011, 'INTERNAL_ERROR')).finally(() => { pendingMessages-- })
        })
        webSocket.on('close', () => {
          clearTimeout(helloTimer)
          const pongTimeout = heartbeatTimeouts.get(webSocket)
          if (pongTimeout) clearTimeout(pongTimeout)
          heartbeatTimeouts.delete(webSocket)
          activeChannels.delete(webSocket)
          if (controlSocket === webSocket) controlSocket = undefined
        })
      })
    } catch (error) {
      if (reservedId && controlReservation === reservedId) controlReservation = undefined
      if (closing || socket.destroyed) { socket.destroy(); return }
      const message = error instanceof Error ? error.message : 'REMOTE_UPGRADE_FAILED'
      if (message === 'REMOTE_RATE_LIMITED') return reject(429, 'LIMIT_EXCEEDED')
      if (message === 'REMOTE_AUTH_TIMEOUT') return reject(503, 'AUTH_UNAVAILABLE')
      reject(401, 'NOT_AUTHORIZED')
    }
  }

  function closeController(controllerId: string): void {
    for (const [socket, info] of activeChannels) {
      if (info.controllerId === controllerId) socket.close(1008, 'REVOKED')
    }
  }

  function close(): Promise<void> {
    if (closing) return closing
    closing = new Promise(resolve => {
      let finished = false
      let shutdownTimer: NodeJS.Timeout
      const finish = (): void => {
        if (finished) return
        finished = true
        clearTimeout(shutdownTimer)
        resolve()
      }
      if (heartbeat) clearInterval(heartbeat)
      for (const controller of authorizationOperations) controller.abort()
      authorizationOperations.clear()
      for (const socket of webSockets.clients) socket.close(1001, 'SERVER_SHUTDOWN')
      for (const timer of heartbeatTimeouts.values()) clearTimeout(timer)
      heartbeatTimeouts.clear()
      shutdownTimer = setTimeout(() => {
        for (const socket of webSockets.clients) socket.terminate()
        for (const socket of sockets) socket.destroy()
        if (server.listening) server.close(() => undefined)
        finish()
      }, REMOTE_LIMITS.shutdownTimeoutMs)
      shutdownTimer.unref()
      webSockets.close(() => undefined)
      void (async () => {
        // Closing during bind waits for the bind result, then closes it if it won.
        await listenTask?.catch(() => undefined)
        for (const socket of sockets) socket.destroy()
        if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()))
        finish()
      })().catch(() => finish())
    })
    return closing
  }

  return {
    listen() {
      if (closing) return Promise.reject(new Error('REMOTE_TRANSPORT_CLOSING'))
      if (listening) return Promise.resolve()
      if (listenTask) return listenTask
      listenTask = new Promise((resolve, reject) => {
        const onError = (error: Error): void => { server.removeListener('listening', onListening); reject(error) }
        const onListening = (): void => {
          server.removeListener('error', onError)
          listening = true
          if (closing) {
            server.close(() => undefined)
            reject(new Error('REMOTE_TRANSPORT_CLOSING'))
            return
          }
          heartbeat = setInterval(() => {
            for (const socket of webSockets.clients) {
              const state = socket as WebSocket & { __kqAlive?: boolean }
              if (state.__kqAlive === false) { socket.terminate(); continue }
              state.__kqAlive = false
              socket.ping()
              const previous = heartbeatTimeouts.get(socket)
              if (previous) clearTimeout(previous)
              const timeout = setTimeout(() => {
                heartbeatTimeouts.delete(socket)
                if (state.__kqAlive === false) socket.terminate()
              }, REMOTE_LIMITS.heartbeatTimeoutMs)
              timeout.unref()
              heartbeatTimeouts.set(socket, timeout)
              socket.once('pong', () => { state.__kqAlive = true; clearTimeout(timeout) })
            }
          }, REMOTE_LIMITS.heartbeatIntervalMs)
          heartbeat.unref()
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        try { server.listen(options.port, options.address) }
        catch (error) {
          server.removeListener('error', onError)
          server.removeListener('listening', onListening)
          reject(error)
        }
      })
      return listenTask
    },
    close,
    address() {
      const value = server.address()
      return value && typeof value !== 'string' ? value : null
    },
    closeController
  }
}
