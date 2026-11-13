import https from 'node:https'
import { isIP } from 'node:net'
import { REMOTE_BOOTSTRAP_PATHS, REMOTE_CONTROL_PATH, REMOTE_CONTROL_SUBPROTOCOL,
  REMOTE_LIMITS, createTransportReady } from './remote-contracts'
import type { PinnedCertificate } from './remote-tls'
import { createPinnedHttpsAgent, isPrivateIpv4 } from './remote-tls'
import WebSocket from 'ws'

function validateEndpoint(address: string, port: number): void {
  if (isIP(address) !== 4 || !isPrivateIpv4(address) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('REMOTE_ENDPOINT_INVALID')
  }
}

function validateToken(token: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('REMOTE_CREDENTIAL_INVALID')
}

function collectResponse(response: import('node:http').IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    response.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > limit) {
        settled = true
        response.destroy(new Error('REMOTE_RESPONSE_TOO_LARGE'))
        reject(new Error('REMOTE_RESPONSE_TOO_LARGE'))
        return
      }
      chunks.push(bytes)
    })
    response.once('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
    response.once('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
  })
}

export interface PinnedHttpRequest {
  address: string
  port: number
  pin: PinnedCertificate
  bearer: string
  method: 'GET' | 'POST'
  path: string
  body?: Uint8Array
  timeoutMs?: number
}

export interface PinnedHttpResponse {
  statusCode: number
  headers: Readonly<Record<string, string | string[] | undefined>>
  body: Buffer
}

/** Main-only HTTPS client. It never follows redirects and only accepts a relative /v1 route. */
export function requestPinnedHttps(options: PinnedHttpRequest): Promise<PinnedHttpResponse> {
  validateEndpoint(options.address, options.port)
  validateToken(options.bearer)
  if (!/^\/v1\/[A-Za-z0-9/_-]{1,120}$/.test(options.path) || options.path.includes('//') ||
      options.path.split('/').some(part => part === '.' || part === '..')) throw new Error('REMOTE_PATH_INVALID')
  const body = options.body ? Buffer.from(options.body) : undefined
  if (body && body.length > REMOTE_LIMITS.maxHttpBodyBytes) throw new Error('REMOTE_BODY_TOO_LARGE')
  const agent = createPinnedHttpsAgent(options.pin)
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: options.address,
      port: options.port,
      method: options.method,
      path: options.path,
      agent,
      timeout: options.timeoutMs ?? REMOTE_LIMITS.httpRequestTimeoutMs,
      maxHeaderSize: REMOTE_LIMITS.maxHttpHeaderBytes,
      headers: {
        Authorization: `Bearer ${options.bearer}`,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {})
      }
    }, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.once('error', () => undefined)
        response.destroy()
        agent.destroy()
        reject(new Error('REMOTE_REDIRECT_REJECTED'))
        return
      }
      const declaredLength = response.headers['content-length']
      if ((declaredLength !== undefined && (!/^\d+$/.test(String(declaredLength)) || Number(declaredLength) > REMOTE_LIMITS.maxHttpBodyBytes)) ||
          (response.headers['content-type'] && !String(response.headers['content-type']).toLowerCase().startsWith('application/json'))) {
        response.once('error', () => undefined)
        response.destroy()
        agent.destroy()
        reject(new Error('REMOTE_RESPONSE_INVALID'))
        return
      }
      void collectResponse(response, REMOTE_LIMITS.maxHttpBodyBytes).then(data => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: data
      }), reject).finally(() => agent.destroy())
    })
    request.on('timeout', () => request.destroy(new Error('REMOTE_REQUEST_TIMEOUT')))
    request.once('error', error => { agent.destroy(); reject(error) })
    if (body) request.write(body)
    request.end()
  })
}

export type BootstrapOperation = 'request' | 'proof' | 'confirm'

const BOOTSTRAP_PATH_BY_OPERATION: Readonly<Record<BootstrapOperation, typeof REMOTE_BOOTSTRAP_PATHS[number]>> = {
  request: REMOTE_BOOTSTRAP_PATHS[0], proof: REMOTE_BOOTSTRAP_PATHS[1], confirm: REMOTE_BOOTSTRAP_PATHS[2]
}

export interface BootstrapResponse {
  statusCode: number
  body: Uint8Array
}

/** Candidate-pinned client for G2 only. No bearer, control path, redirects, or arbitrary URL is accepted. */
export function createBootstrapChannel(options: {
  address: string
  port: number
  candidatePin: PinnedCertificate
}): {
  request(operation: BootstrapOperation, body: Uint8Array, signal?: AbortSignal): Promise<BootstrapResponse>
  close(): void
} {
  validateEndpoint(options.address, options.port)
  const agent = createPinnedHttpsAgent(options.candidatePin)
  let closed = false
  const requests = new Set<import('node:http').ClientRequest>()
  return {
    request(operation, bodyBytes, signal) {
      if (closed || signal?.aborted) return Promise.reject(new Error('REMOTE_BOOTSTRAP_CLOSED'))
      if (!Object.hasOwn(BOOTSTRAP_PATH_BY_OPERATION, operation)) return Promise.reject(new Error('REMOTE_BOOTSTRAP_OPERATION_INVALID'))
      const body = Buffer.from(bodyBytes)
      if (body.length === 0 || body.length > REMOTE_LIMITS.maxHttpBodyBytes) return Promise.reject(new Error('REMOTE_BODY_TOO_LARGE'))
      return new Promise((resolve, reject) => {
        const request = https.request({ host: options.address, port: options.port, method: 'POST',
          path: BOOTSTRAP_PATH_BY_OPERATION[operation], agent, timeout: REMOTE_LIMITS.httpRequestTimeoutMs,
          maxHeaderSize: REMOTE_LIMITS.maxHttpHeaderBytes, headers: {
            'Content-Type': 'application/json', 'Content-Length': String(body.length)
          } }, response => {
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
            response.once('error', () => undefined)
            response.destroy()
            reject(new Error('REMOTE_REDIRECT_REJECTED'))
            return
          }
          void collectResponse(response, REMOTE_LIMITS.maxHttpBodyBytes).then(data => resolve({
            statusCode: response.statusCode ?? 0, body: data
          }), reject).finally(() => requests.delete(request))
        })
        requests.add(request)
        request.once('close', () => requests.delete(request))
        const abort = (): void => { request.destroy(new Error('REMOTE_BOOTSTRAP_ABORTED')) }
        signal?.addEventListener('abort', abort, { once: true })
        request.once('close', () => signal?.removeEventListener('abort', abort))
        request.on('timeout', () => request.destroy(new Error('REMOTE_REQUEST_TIMEOUT')))
        request.once('error', error => { requests.delete(request); reject(error) })
        request.end(body)
      })
    },
    close() {
      if (closed) return
      closed = true
      for (const request of requests) request.destroy(new Error('REMOTE_BOOTSTRAP_CLOSED'))
      requests.clear()
      agent.destroy()
    }
  }
}

function decodeText(data: WebSocket.RawData): string {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export interface PinnedControlChannel {
  socket: WebSocket
  ready: { type: 'transport-ready'; transportVersion: 1; capabilities: string[] }
  close(): void
}

/** Opens WSS only after strict candidate trust and confirms G1's closed transport handshake. */
export function connectPinnedControlChannel(options: {
  address: string
  port: number
  pin: PinnedCertificate
  bearer: string
  capabilities?: readonly string[]
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<PinnedControlChannel> {
  validateEndpoint(options.address, options.port)
  validateToken(options.bearer)
  const requested = createTransportReady(options.capabilities ?? []).capabilities
  const agent = createPinnedHttpsAgent(options.pin)
  const socket = new WebSocket(`wss://${options.address}:${options.port}${REMOTE_CONTROL_PATH}`,
    REMOTE_CONTROL_SUBPROTOCOL, {
      agent, headers: { Authorization: `Bearer ${options.bearer}` },
      handshakeTimeout: options.timeoutMs ?? REMOTE_LIMITS.tlsHandshakeTimeoutMs,
      perMessageDeflate: false, followRedirects: false,
      maxPayload: REMOTE_LIMITS.maxWebSocketMessageBytes, maxFragments: 16
    })
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => fail(new Error('REMOTE_HELLO_TIMEOUT')), REMOTE_LIMITS.helloTimeoutMs)
    timeout.unref()
    const abort = (): void => fail(new Error('REMOTE_CONNECT_ABORTED'))
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      socket.terminate()
      agent.destroy()
      reject(error)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) { abort(); return }
    socket.on('error', fail)
    socket.once('close', () => {
      agent.destroy()
      if (!settled) fail(new Error('REMOTE_CHANNEL_CLOSED'))
    })
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'transport-hello', transportVersion: 1, capabilities: requested }), error => {
        if (error) fail(error)
      })
    })
    socket.once('message', (data, isBinary) => {
      if (isBinary) return fail(new Error('REMOTE_HELLO_INVALID'))
      let message: unknown
      try { message = JSON.parse(decodeText(data)) }
      catch { return fail(new Error('REMOTE_HELLO_INVALID')) }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return fail(new Error('REMOTE_HELLO_INVALID'))
      const value = message as Record<string, unknown>
      if (Object.keys(value).sort().join(',') !== 'capabilities,transportVersion,type' || value.type !== 'transport-ready' ||
          value.transportVersion !== 1 || !Array.isArray(value.capabilities) || value.capabilities.length > REMOTE_LIMITS.maxCapabilities ||
          value.capabilities.some(item => typeof item !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(item))) {
        return fail(new Error('REMOTE_VERSION_UNSUPPORTED'))
      }
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      resolve({ socket, ready: value as PinnedControlChannel['ready'], close() {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000)
        agent.destroy()
      } })
    })
  })
}
