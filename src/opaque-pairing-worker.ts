import { parentPort } from 'node:worker_threads'
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import type { PairingContextFields } from './pairing-crypto'
import { buildOpaqueIdentifiers, buildPairingContext, decodeBase64Url, encodeBase64Url,
  encodeFields, OPAQUE_PROFILE, PAIRING_VERSION } from './pairing-crypto'

interface OpaqueApi {
  ready: Promise<void>
  client: {
    startRegistration(input: { password: string }): { clientRegistrationState: string; registrationRequest: string }
    finishRegistration(input: Record<string, unknown>): { registrationRecord: string; exportKey: string }
    startLogin(input: { password: string }): { clientLoginState: string; startLoginRequest: string }
    finishLogin(input: Record<string, unknown>): { finishLoginRequest: string; sessionKey: string } | undefined
  }
  server: {
    createSetup(): string
    createRegistrationResponse(input: { serverSetup: string; userIdentifier: string; registrationRequest: string }): { registrationResponse: string }
    startLogin(input: Record<string, unknown>): { serverLoginState: string; loginResponse: string }
    finishLogin(input: Record<string, unknown>): { sessionKey: string }
  }
}

interface WorkerRequest {
  id: number
  operation: 'player-register' | 'player-start' | 'player-finish' | 'controller-start' | 'controller-finish' |
    'controller-confirm-player-bind' | 'player-confirm-controller-bind'
  password?: string
  context?: PairingContextFields
  userIdentifier?: string
  ke1?: string
  ke2?: string
  ke3?: string
  playerBind?: string
  controllerBind?: string
}

const port = parentPort
if (!port) throw new Error('OPAQUE_WORKER_PARENT_REQUIRED')

const opaque = require('@serenity-kit/opaque') as OpaqueApi
let playerSetup: string | undefined
let playerRecord: string | undefined
let playerServerState: string | undefined
let controllerClientState: string | undefined
let currentContext: PairingContextFields | undefined
let ke1: Buffer | undefined
let ke2: Buffer | undefined
let ke3: Buffer | undefined
let sessionKey: Buffer | undefined
let finalTranscript: Buffer | undefined
let recoveryRoot: Buffer | undefined
let playerBind: Buffer | undefined
let controllerBind: Buffer | undefined
let queue = Promise.resolve()

function secretPassword(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) throw new Error('PAIRING_CODE_INVALID')
  return value
}

function schedule(keyText: string, contextValue: PairingContextFields,
  k1Text: string, k2Text: string, k3Text: string): void {
  const key = decodeBase64Url(keyText, 64)
  ke1 = decodeBase64Url(k1Text, 96)
  ke2 = decodeBase64Url(k2Text, 320)
  ke3 = decodeBase64Url(k3Text, 64)
  const context = buildPairingContext(contextValue)
  const transcript = encodeFields('KQ-Pair-transcript', PAIRING_VERSION, OPAQUE_PROFILE, context, ke1, ke2, ke3)
  const transcriptHash = createHash('sha256').update(transcript).digest()
  const derive = (ikm: Uint8Array, label: string): Buffer => Buffer.from(hkdfSync('sha256', ikm, transcriptHash,
    encodeFields('KQ-Pair-v2', label), 32))
  recoveryRoot = derive(key, 'recovery-root')
  const bindPlayerKey = derive(key, 'bind-player')
  const bindControllerKey = derive(key, 'bind-controller')
  playerBind = createHmac('sha256', bindPlayerKey).update(encodeFields('player-bind', transcriptHash, ke1, ke2, ke3)).digest()
  controllerBind = createHmac('sha256', bindControllerKey)
    .update(encodeFields('controller-bind', transcriptHash, ke1, ke2, ke3, playerBind)).digest()
  finalTranscript = transcript
  sessionKey = key
  key.fill(0)
  bindPlayerKey.fill(0)
  bindControllerKey.fill(0)
}

function publicSchedule(): Record<string, string> {
  if (!finalTranscript || !recoveryRoot) throw new Error('PAIRING_STATE_INVALID')
  return {
    transcript: encodeBase64Url(finalTranscript),
    transcriptHash: encodeBase64Url(createHash('sha256').update(finalTranscript).digest()),
    recoveryRoot: encodeBase64Url(recoveryRoot)
  }
}

async function processRequest(request: WorkerRequest): Promise<unknown> {
  await opaque.ready
  if (request.operation === 'player-register') {
    if (!request.context || !request.userIdentifier) throw new Error('PAIRING_CONTEXT_REQUIRED')
    const password = secretPassword(request.password)
    const identifiers = buildOpaqueIdentifiers(buildPairingContext(request.context))
    const setup = opaque.server.createSetup()
    const registrationStart = opaque.client.startRegistration({ password })
    const registrationResponse = opaque.server.createRegistrationResponse({ serverSetup: setup,
      userIdentifier: request.userIdentifier, registrationRequest: registrationStart.registrationRequest })
    const registration = opaque.client.finishRegistration({ ...registrationStart, ...registrationResponse,
      password, identifiers, keyStretching: 'memory-constrained' })
    playerSetup = setup
    playerRecord = registration.registrationRecord
    currentContext = request.context
    playerServerState = undefined
    controllerClientState = undefined
    ke1 = undefined; ke2 = undefined; ke3 = undefined; sessionKey = undefined
    finalTranscript = undefined; recoveryRoot?.fill(0); recoveryRoot = undefined
    playerBind?.fill(0); playerBind = undefined; controllerBind?.fill(0); controllerBind = undefined
    return { registered: true }
  }
  if (request.operation === 'controller-start') {
    if (!request.context) throw new Error('PAIRING_CONTEXT_REQUIRED')
    const password = secretPassword(request.password)
    currentContext = request.context
    const result = opaque.client.startLogin({ password })
    controllerClientState = result.clientLoginState
    ke1 = decodeBase64Url(result.startLoginRequest, 96)
    return { KE1: result.startLoginRequest }
  }
  if (request.operation === 'player-start') {
    if (!currentContext || !playerSetup || !playerRecord || !request.ke1 || !request.userIdentifier) {
      throw new Error('PAIRING_STATE_INVALID')
    }
    const identifiers = buildOpaqueIdentifiers(buildPairingContext(currentContext))
    ke1 = decodeBase64Url(request.ke1, 96)
    const result = opaque.server.startLogin({ serverSetup: playerSetup, registrationRecord: playerRecord,
      userIdentifier: request.userIdentifier, startLoginRequest: request.ke1, identifiers })
    playerServerState = result.serverLoginState
    ke2 = decodeBase64Url(result.loginResponse, 320)
    return { KE2: result.loginResponse }
  }
  if (request.operation === 'controller-finish') {
    if (!currentContext || !controllerClientState || !ke1 || !request.ke2 || !request.password) {
      throw new Error('PAIRING_STATE_INVALID')
    }
    const password = secretPassword(request.password)
    const identifiers = buildOpaqueIdentifiers(buildPairingContext(currentContext))
    ke2 = decodeBase64Url(request.ke2, 320)
    const result = opaque.client.finishLogin({ clientLoginState: controllerClientState,
      loginResponse: request.ke2, password, identifiers, keyStretching: 'memory-constrained' })
    if (!result) throw new Error('PAIRING_AUTH_FAILED')
    const encodedKey = result.sessionKey
    schedule(encodedKey, currentContext, encodeBase64Url(ke1), request.ke2, result.finishLoginRequest)
    return { KE3: result.finishLoginRequest }
  }
  if (request.operation === 'controller-confirm-player-bind') {
    if (!request.playerBind || !playerBind || !controllerBind || !recoveryRoot) throw new Error('PAIRING_STATE_INVALID')
    const actualPlayerBind = decodeBase64Url(request.playerBind, 32)
    if (!timingSafeEqual(playerBind, actualPlayerBind)) throw new Error('PAIRING_BINDING_FAILED')
    return { controllerBind: encodeBase64Url(controllerBind), ...publicSchedule() }
  }
  if (request.operation === 'player-confirm-controller-bind') {
    if (!request.controllerBind || !controllerBind || !playerBind || !ke1 || !ke2 || !ke3 || !recoveryRoot) {
      throw new Error('PAIRING_STATE_INVALID')
    }
    const actual = decodeBase64Url(request.controllerBind, 32)
    if (!timingSafeEqual(controllerBind, actual)) throw new Error('PAIRING_BINDING_FAILED')
    return { confirmed: true, ...publicSchedule() }
  }
  if (request.operation === 'player-finish') {
    if (!currentContext || !playerServerState || !request.ke3 || !ke1 || !ke2) throw new Error('PAIRING_STATE_INVALID')
    const identifiers = buildOpaqueIdentifiers(buildPairingContext(currentContext))
    ke3 = decodeBase64Url(request.ke3, 64)
    const result = opaque.server.finishLogin({ serverLoginState: playerServerState,
      finishLoginRequest: request.ke3, identifiers })
    schedule(result.sessionKey, currentContext, encodeBase64Url(ke1), encodeBase64Url(ke2), request.ke3)
    return { playerBind: encodeBase64Url(playerBind!), ...publicSchedule() }
  }
  throw new Error('OPAQUE_OPERATION_UNSUPPORTED')
}

port.on('message', (request: WorkerRequest) => {
  queue = queue.then(async () => {
    try { port.postMessage({ id: request.id, result: await processRequest(request) }) }
    catch (error) { port.postMessage({ id: request.id, error: error instanceof Error ? error.message : 'OPAQUE_FAILED' }) }
  })
})

process.once('exit', () => {
  recoveryRoot?.fill(0); sessionKey?.fill(0); ke1?.fill(0); ke2?.fill(0); ke3?.fill(0)
  playerSetup = undefined; playerRecord = undefined; playerServerState = undefined; controllerClientState = undefined
})
