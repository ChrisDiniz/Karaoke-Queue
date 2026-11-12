import { createHash, createHmac, randomInt, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RemoteBootstrapPort, RemoteBootstrapRequestContext, RemoteDeviceIdentity,
  RemoteHttpResponse } from './remote-contracts'
import { decodeBase64Url, derivePairingKey, encodeBase64Url, encodeFields,
  makeReceipt, nextReceiptDigest, opaqueUserIdentifier, sha256, verifyReceipt } from './pairing-crypto'
import { MainOpaqueWorker } from './opaque-worker-client'
import type { OpaqueWorkerPort } from './opaque-worker-client'
import { PairingStore, type PairingJournal } from './pairing-store'
import type { PairingContextFields } from './pairing-crypto'
import { encodePairingEnvelope, parsePairingEnvelope, type PairingEnvelope } from './pairing-wire'
import { canCancelPairing, transitionPlayerPairing, type PlayerPairingState } from './pairing-state-machine'

export interface PairingPresentationPort {
  /** Must be a locally trusted, non-projected surface approved for code entry/consent. */
  readonly approvedForProduction: boolean
  requestConsent(input: { displayName: string; purpose: 'initial' | 'renewal'; expiresAt: number }): Promise<boolean>
  showTemporaryCode(input: { groupedCode: string; expiresAt: number }): Promise<void> | void
  closePairing(input: { outcome: 'rejected' | 'cancelled' | 'timed-out' | 'active' | 'error' }): Promise<void> | void
}

export interface PairingBootstrapClock {
  monotonicNow(): number
  utcNow(): Date
}

const systemClock: PairingBootstrapClock = {
  monotonicNow: () => Number(process.hrtime.bigint() / 1_000_000n),
  utcNow: () => new Date()
}

interface ActivePlayerSession {
  sessionId: string
  operationId: string
  nonceC: string
  nonceP: string
  capability: string
  controllerId: string
  displayName: string
  purpose: 'initial' | 'renewal'
  baseCRevision: string
  basePRevision: string
  expectedGeneration: string
  targetGeneration: string
  consentDeadline: number
  codeDeadline: number
  state: PlayerPairingState
  code: string
  attemptsUsed: number
  attemptId: string
  context?: PairingContextFields
  worker?: OpaqueWorkerPort
  cancelRequested: boolean
  cancelTask?: Promise<boolean>
  firstPersistence?: FirstPairingPersistence
  presentationCloseTask?: Promise<void>
  playerBind?: string
  cache: Map<string, { digest: string; response: Promise<RemoteHttpResponse> }>
  serial: Promise<void>
  deadlineTimer?: NodeJS.Timeout
}

type FirstPairingPersistenceOutcome =
  | { kind: 'persisted' }
  | { kind: 'absent'; error: unknown }
  | { kind: 'uncertain'; error: unknown }

interface FirstPairingPersistence {
  status: 'writing' | 'persisted' | 'absent' | 'uncertain'
  cancelAfterAdmission: boolean
  completion: Promise<FirstPairingPersistenceOutcome>
  cancelTask?: Promise<boolean>
}

function shaText(value: Uint8Array): string { return encodeBase64Url(sha256(value)) }

function makeResponse(envelope: PairingEnvelope): RemoteHttpResponse {
  return { statusCode: 200, contentType: 'application/json', body: encodePairingEnvelope(envelope) }
}

function responseEnvelope(request: PairingEnvelope, type: string, payload: Record<string, unknown>, attemptId = request.attemptId): PairingEnvelope {
  return { version: 'kq-pair/2', type, sessionId: request.sessionId, operationId: request.operationId, attemptId, payload }
}

function rawHmac(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

function verifyMac(key: Uint8Array, data: Uint8Array, encoded: string): boolean {
  const actual = decodeBase64Url(encoded, 32)
  const expected = rawHmac(key, data)
  return timingSafeEqual(actual, expected)
}

function descriptorFromJournal(journal: PairingJournal): {
  transcriptHash: string; pairingId: string; operationId: string; targetGeneration: string;
  basePRevision: string; baseCRevision: string; tokenHash: string
} {
  return journal.descriptor as ReturnType<typeof descriptorFromJournal>
}

/** G2 Player endpoint adapter. It remains unreachable unless an approved local presentation port is supplied. */
export class PairingBootstrapService implements RemoteBootstrapPort {
  private session: ActivePlayerSession | undefined
  private closed = false
  private openFingerprint: string | undefined
  private openTask: Promise<RemoteHttpResponse> | undefined

  constructor(
    private readonly identity: RemoteDeviceIdentity,
    private readonly store: PairingStore,
    private readonly presentation: PairingPresentationPort | undefined,
    private readonly clock: PairingBootstrapClock = systemClock,
    private readonly createWorker: () => OpaqueWorkerPort = () => new MainOpaqueWorker(),
    private readonly promoteRenewal?: () => Promise<void>
  ) {
    if (identity.role !== 'player' || !identity.certificatePem || !identity.privateKeyPem ||
        typeof identity.certificateFingerprintSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(identity.certificateFingerprintSha256)) {
      throw new Error('PAIRING_PLAYER_IDENTITY_INVALID')
    }
  }

  get enabled(): boolean { return !this.closed && this.presentation?.approvedForProduction === true }

  async handle(context: RemoteBootstrapRequestContext): Promise<RemoteHttpResponse> {
    if (this.closed) return this.rawError(503, 'TRANSPORT_CLOSING')
    let request: PairingEnvelope
    try { request = parsePairingEnvelope(context.body) }
    catch { return this.rawError(400, 'INVALID_MESSAGE') }
    if (!this.enabled && !['confirm/status', 'confirm/prepared', 'confirm/final'].includes(request.type)) {
      return this.error(request, 503, 'STORAGE_UNAVAILABLE')
    }
    const allowed = context.operation === 'request'
      ? ['request/open', 'request/poll', 'request/cancel']
      : context.operation === 'proof' ? ['proof/ake-start', 'proof/ake-finish']
        : ['confirm/controller-bind', 'confirm/prepared', 'confirm/final', 'confirm/status']
    if (!allowed.includes(request.type)) return this.error(request, 400, 'INVALID_MESSAGE')
    const fingerprint = shaText(context.body)
    if (request.type === 'request/open') {
      if (this.openFingerprint === fingerprint && this.openTask) return this.openTask
      if (this.openFingerprint === fingerprint && this.session) return this.openResponse(request, this.session)
      if (this.session && !['rejected', 'cancelled', 'timed-out', 'error'].includes(this.session.state)) {
        return this.error(request, 409, 'BUSY')
      }
      if (this.session) { this.session = undefined; this.openFingerprint = undefined }
      if (this.openTask) return this.error(request, 409, 'BUSY')
      this.openFingerprint = fingerprint
      const task = this.open(request)
      this.openTask = task
      void task.finally(() => {
        if (this.openTask === task) this.openTask = undefined
      }).catch(() => undefined)
      return task
    }
    const session = request.type === 'request/open' ? undefined : this.session
    const cacheKey = request.type === 'request/open' ? `open:${fingerprint}`
      : `${request.type}:${request.sessionId}:${request.operationId}:${request.attemptId}`
    if (session) {
      if (request.type === 'request/cancel' && this.matchesCapability(request, session) &&
          !['pending', 'committed', 'active'].includes(session.state) &&
          session.firstPersistence?.status !== 'writing') {
        session.cancelRequested = true
        void session.worker?.close()
      }
      const cacheable = request.type !== 'request/poll' && request.type !== 'confirm/status'
      const cached = cacheable ? session.cache.get(cacheKey) : undefined
      if (cached) return cached.digest === fingerprint ? cached.response : this.error(request, 409, 'REVISION_CONFLICT')
      const response = this.serialize(session, async () => {
        try { return await this.dispatch(request) }
        catch (error) {
          const code = error instanceof Error ? error.message : 'PAIRING_REQUEST_FAILED'
          if (code === 'PAIRING_EXPIRED') return this.error(request, 410, 'EXPIRED')
          if (code === 'PAIRING_SESSION_FENCED' || code === 'PAIRING_CANCELLED') return this.error(request, 403, 'REJECTED')
          return this.error(request, 503, 'RESULT_UNCERTAIN')
        }
      })
      if (cacheable) {
        session.cache.set(cacheKey, { digest: fingerprint, response })
        if (session.cache.size > 128) session.cache.delete(session.cache.keys().next().value!)
      }
      return response
    }
    if (request.type === 'confirm/status') return this.status(request)
    if (request.type === 'confirm/prepared') return this.commitPrepared(request)
    if (request.type === 'confirm/final') return this.activate(request)
    return this.error(request, 409, 'RESULT_UNCERTAIN')
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.closed = true
    this.closeTask = this.closeSession()
    return this.closeTask
  }

  private closeTask?: Promise<void>

  private async closeSession(): Promise<void> {
    const session = this.session
    if (!session) return
    const admitted = session.firstPersistence?.status === 'writing' ? session.firstPersistence : undefined
    let mayCancel = canCancelPairing(session.state)
    session.code = ''
    if (admitted) {
      admitted.cancelAfterAdmission = true
      const outcome = await admitted.completion
      mayCancel = outcome.kind === 'absent'
      if (outcome.kind === 'uncertain') session.state = 'blocked'
    } else if (mayCancel) {
      session.cancelRequested = true
      session.state = transitionPlayerPairing(session.state, 'cancelled')
    }
    await session.worker?.close().catch(() => undefined)
    session.worker = undefined
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer)
    if (this.session === session) this.session = undefined
    if (mayCancel) await this.closePresentationOnce(session, 'cancelled')
    else if (session.state === 'blocked' || session.state === 'error') await this.closePresentationOnce(session, 'error')
  }

  /** Called only by a local Player presentation. It fences volatile work without touching playback. */
  async cancelLocally(): Promise<boolean> {
    const session = this.session
    if (!session || this.closed || ['pending', 'committed', 'active', 'blocked'].includes(session.state)) return false
    const persistence = session.firstPersistence
    if (persistence?.status === 'writing') {
      persistence.cancelAfterAdmission = true
      if (!persistence.cancelTask) {
        persistence.cancelTask = (async () => {
          const outcome = await persistence.completion
          if (outcome.kind !== 'absent' || this.session !== session || this.closed) return false
          return this.finishLocalCancellation(session)
        })()
      }
      return persistence.cancelTask
    }
    if (persistence?.status === 'uncertain' || persistence?.status === 'persisted') return false
    if (session.state === 'cancelled') return session.cancelTask ?? true
    if (['rejected', 'timed-out', 'error'].includes(session.state)) return false
    if (!session.cancelTask) session.cancelTask = this.finishLocalCancellation(session)
    return session.cancelTask
  }

  private async finishLocalCancellation(session: ActivePlayerSession): Promise<boolean> {
    if (this.session !== session || this.closed || session.firstPersistence?.status === 'persisted' ||
        session.firstPersistence?.status === 'uncertain') return false
    session.cancelRequested = true
    session.code = ''
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer)
    if (session.state !== 'cancelled') session.state = transitionPlayerPairing(session.state, 'cancelled')
    await session.worker?.close().catch(() => undefined)
    session.worker = undefined
    await this.closePresentationOnce(session, 'cancelled')
    return true
  }

  private closePresentationOnce(session: ActivePlayerSession,
    outcome: 'rejected' | 'cancelled' | 'timed-out' | 'active' | 'error'): Promise<void> {
    if (!session.presentationCloseTask) {
      session.presentationCloseTask = Promise.resolve(this.presentation?.closePairing({ outcome })).then(() => undefined)
    }
    return session.presentationCloseTask
  }

  private async dispatch(request: PairingEnvelope): Promise<RemoteHttpResponse> {
    const session = this.session
    if (request.type === 'confirm/status') return this.status(request)
    if (!session || request.sessionId !== session.sessionId || request.operationId !== session.operationId) {
      if (request.type === 'confirm/prepared') return this.commitPrepared(request)
      if (request.type === 'confirm/final') return this.activate(request)
      return this.error(request, 409, 'RESULT_UNCERTAIN')
    }
    if (request.type === 'request/poll') return this.poll(request, session)
    if (request.type === 'request/cancel') return this.cancel(request, session)
    if (request.attemptId !== session.attemptId && request.type !== 'proof/ake-start') return this.error(request, 409, 'REVISION_CONFLICT')
    if (request.type === 'proof/ake-start') return this.akeStart(request, session)
    if (request.type === 'proof/ake-finish') return this.akeFinish(request, session)
    if (request.type === 'confirm/controller-bind') return this.controllerBind(request, session)
    if (request.type === 'confirm/prepared') return this.commitPrepared(request, session)
    if (request.type === 'confirm/final') return this.activate(request, session)
    return this.error(request, 400, 'INVALID_MESSAGE')
  }

  private async open(request: PairingEnvelope): Promise<RemoteHttpResponse> {
    const payload = request.payload
    const player = await this.store.read()
    const renewal = payload.purpose === 'renewal'
    if (renewal && !this.promoteRenewal) return this.error(request, 503, 'STORAGE_UNAVAILABLE')
    if (player.playerAuthority?.phase === 'active' && !renewal) return this.error(request, 409, 'ALREADY_BOUND')
    if (player.playerAuthority?.phase !== 'active' && renewal) return this.error(request, 409, 'REVISION_CONFLICT')
    if (renewal && player.playerAuthority?.controllerId !== payload.controllerId) return this.error(request, 409, 'ALREADY_BOUND')
    if (player.journals.some(item => item.role === 'player' && ['bound', 'committed', 'uncertain'].includes(item.phase))) {
      return this.error(request, 409, 'ALREADY_BOUND')
    }
    await this.store.assertSecureStorageAvailable()
    const expectedGeneration = String(player.playerAuthority?.credentialGeneration ?? 0)
    if (BigInt(expectedGeneration) >= BigInt(Number.MAX_SAFE_INTEGER - 16) ||
        player.authorityRevision >= Number.MAX_SAFE_INTEGER - 16) return this.error(request, 503, 'STORAGE_UNAVAILABLE')
    const session: ActivePlayerSession = {
      sessionId: encodeBase64Url(randomBytes(32)), operationId: encodeBase64Url(randomBytes(32)),
      nonceC: String(payload.nonceC), nonceP: encodeBase64Url(randomBytes(32)), capability: encodeBase64Url(randomBytes(32)),
      controllerId: String(payload.controllerId), displayName: String(payload.displayName),
      purpose: payload.purpose as 'initial' | 'renewal', baseCRevision: String(payload.baseCRevision),
      basePRevision: String(player.authorityRevision), expectedGeneration, targetGeneration: String(BigInt(expectedGeneration) + 1n),
      consentDeadline: this.clock.monotonicNow() + 120_000, codeDeadline: 0,
      state: 'awaiting-local-consent', code: '', attemptsUsed: 0, attemptId: '', cache: new Map(), serial: Promise.resolve(),
      cancelRequested: false
    }
    this.session = session
    this.scheduleDeadline(session, session.consentDeadline)
    void this.awaitConsent(session)
    return this.openResponse(request, session)
  }

  private openResponse(request: PairingEnvelope, session: ActivePlayerSession): RemoteHttpResponse {
    const response: PairingEnvelope = { version: 'kq-pair/2', type: 'response/opened',
      sessionId: session.sessionId, operationId: session.operationId, attemptId: '', payload: {
        playerId: this.identity.deviceId, nonceP: session.nonceP, sessionCapability: session.capability,
        basePRevision: session.basePRevision, baseCRevision: session.baseCRevision,
        expectedGeneration: session.expectedGeneration, targetGeneration: session.targetGeneration,
        serverName: `player-${this.identity.deviceId}.karaoke.invalid`,
        fingerprint: encodeBase64Url(Buffer.from(this.identity.certificateFingerprintSha256!, 'hex')),
        state: session.state
      } }
    return makeResponse(response)
  }

  private async awaitConsent(session: ActivePlayerSession): Promise<void> {
    const presentation = this.presentation
    if (!presentation || this.session !== session) return
    try {
      const accepted = await presentation.requestConsent({ displayName: session.displayName, purpose: session.purpose,
        expiresAt: session.consentDeadline })
      if (this.session !== session || this.closed || session.state !== 'awaiting-local-consent') return
      if (this.clock.monotonicNow() >= session.consentDeadline) {
        session.state = transitionPlayerPairing(session.state, 'timed-out')
        await presentation.closePairing({ outcome: 'timed-out' })
        return
      }
      if (!accepted) {
        session.state = transitionPlayerPairing(session.state, 'rejected')
        await presentation.closePairing({ outcome: 'rejected' })
        return
      }
      session.state = transitionPlayerPairing(session.state, 'code-ready')
      session.code = String(randomInt(0, 100_000_000)).padStart(8, '0')
      session.codeDeadline = this.clock.monotonicNow() + 120_000
      this.scheduleDeadline(session, session.codeDeadline)
      await presentation.showTemporaryCode({ groupedCode: `${session.code.slice(0, 4)} ${session.code.slice(4)}`,
        expiresAt: session.codeDeadline })
    } catch {
      if (this.session === session && session.state !== 'pending' && session.state !== 'active') {
        session.state = 'error'
        session.code = ''
        await Promise.resolve(presentation.closePairing({ outcome: 'error' })).catch(() => undefined)
      }
    }
  }

  private async poll(request: PairingEnvelope, session: ActivePlayerSession): Promise<RemoteHttpResponse> {
    if (!this.matchesCapability(request, session)) return this.error(request, 403, 'AUTH_FAILED')
    this.checkDeadline(session, session.state !== 'awaiting-local-consent')
    const remaining = session.state === 'awaiting-local-consent'
      ? session.consentDeadline - this.clock.monotonicNow()
      : session.codeDeadline - this.clock.monotonicNow()
    return makeResponse(responseEnvelope(request, 'response/state', {
      state: session.state, remainingSeconds: String(Math.max(0, Math.ceil(remaining / 1000))),
      attemptsRemaining: String(Math.max(0, 3 - session.attemptsUsed))
    }, ''))
  }

  private async cancel(request: PairingEnvelope, session: ActivePlayerSession): Promise<RemoteHttpResponse> {
    if (!this.matchesCapability(request, session)) return this.error(request, 403, 'AUTH_FAILED')
    if (['pending', 'committed', 'active', 'blocked'].includes(session.state) ||
        session.firstPersistence?.status === 'writing' || session.firstPersistence?.status === 'uncertain') {
      return this.error(request, 503, 'RESULT_UNCERTAIN')
    }
    if (session.state !== 'cancelled' && session.state !== 'rejected' && session.state !== 'timed-out') {
      await this.finishLocalCancellation(session)
    }
    return makeResponse(responseEnvelope(request, 'response/state', { state: session.state, remainingSeconds: '0',
      attemptsRemaining: String(Math.max(0, 3 - session.attemptsUsed)) }, ''))
  }

  private async akeStart(request: PairingEnvelope, session: ActivePlayerSession): Promise<RemoteHttpResponse> {
    if (!this.matchesCapability(request, session)) return this.error(request, 403, 'AUTH_FAILED')
    this.checkDeadline(session, true)
    if (session.state !== 'code-ready' && session.state !== 'awaiting-KE3') return this.error(request, 409, 'BUSY')
    if (session.attemptsUsed >= 3) return this.error(request, 429, 'RATE_LIMITED')
    if (session.state === 'awaiting-KE3') {
      await session.worker?.close()
      session.worker = undefined
    }
    session.state = transitionPlayerPairing(session.state, 'preparing-attempt')
    session.attemptId = request.attemptId
    try { await this.store.reserveAttempt(session.sessionId, session.attemptId) }
    catch (error) {
      session.state = transitionPlayerPairing(session.state, 'code-ready')
      return this.error(request, 429, error instanceof Error && error.message === 'PAIRING_LOCKED' ? 'RATE_LIMITED' : 'STORAGE_UNAVAILABLE')
    }
    session.attemptsUsed++
    session.context = this.context(session)
    try {
      session.worker = this.createWorker()
      const userIdentifier = opaqueUserIdentifier(session.sessionId, session.attemptId)
      await session.worker.run({ operation: 'player-register', password: session.code,
        context: session.context, userIdentifier })
      this.assertSessionCurrent(session)
      this.checkDeadline(session, true)
      const result = await session.worker.run<{ KE2: string }>({ operation: 'player-start',
        ke1: String(request.payload.KE1), userIdentifier })
      this.assertSessionCurrent(session)
      this.checkDeadline(session, true)
      session.state = transitionPlayerPairing(session.state, 'awaiting-KE3')
      return makeResponse(responseEnvelope(request, 'response/ake-response', { KE2: result.KE2 }))
    } catch (error) {
      await session.worker?.close()
      session.worker = undefined
      if (session.cancelRequested) session.state = 'cancelled'
      else if (session.state === 'preparing-attempt') session.state = transitionPlayerPairing(session.state, 'error')
      session.code = ''
      await Promise.resolve(this.presentation?.closePairing({ outcome: session.cancelRequested ? 'cancelled' : 'error' })).catch(() => undefined)
      return this.error(request, error instanceof Error && error.message === 'PAIRING_LOCKED' ? 429 : 503,
        error instanceof Error && error.message === 'PAIRING_LOCKED' ? 'RATE_LIMITED' :
          session.cancelRequested ? 'REJECTED' : 'STORAGE_UNAVAILABLE')
    }
  }

  private async akeFinish(request: PairingEnvelope, session: ActivePlayerSession): Promise<RemoteHttpResponse> {
    this.checkDeadline(session, true)
    if (session.state !== 'awaiting-KE3' || !session.worker || !session.attemptId) return this.error(request, 409, 'BUSY')
    let result: { playerBind: string; transcript: string; transcriptHash: string; recoveryRoot: string }
    try {
      result = await session.worker.run<{ playerBind: string; transcript: string; transcriptHash: string; recoveryRoot: string }>({
        operation: 'player-finish', ke3: String(request.payload.KE3)
      })
      this.assertSessionCurrent(session)
      this.checkDeadline(session, true)
    } catch {
      // Keep the durably reserved attempt charged on malformed or incorrect KE3.
      await session.worker?.close().catch(() => undefined)
      session.worker = undefined
      if (session.state === 'awaiting-KE3') session.state = transitionPlayerPairing(session.state, 'code-ready')
      return this.error(request, 403, 'AUTH_FAILED')
    }
    try { await this.store.completeAttempt(session.attemptId, true) }
    catch {
      await session.worker?.close().catch(() => undefined)
      session.worker = undefined
      session.code = ''
      session.state = 'error'
      await Promise.resolve(this.presentation?.closePairing({ outcome: 'error' })).catch(() => undefined)
      return this.error(request, 503, 'STORAGE_UNAVAILABLE')
    }
    session.code = ''
    session.playerBind = result.playerBind
    session.state = transitionPlayerPairing(session.state, 'awaiting-controller-bind')
    return makeResponse(responseEnvelope(request, 'response/ake-confirmed', { playerBind: result.playerBind }))
  }

  private async controllerBind(request: PairingEnvelope, session: ActivePlayerSession): Promise<RemoteHttpResponse> {
    this.checkDeadline(session, true)
    if (session.state !== 'awaiting-controller-bind' || !session.worker || !session.context) return this.error(request, 409, 'BUSY')
    let recoveryRoot: Buffer | undefined
    let token: Buffer | undefined
    let commitKey: Buffer | undefined
    try {
      const result = await session.worker.run<{ confirmed: boolean; transcript: string; transcriptHash: string; recoveryRoot: string }>({
        operation: 'player-confirm-controller-bind', controllerBind: String(request.payload.controllerBind)
      })
      this.assertSessionCurrent(session)
      this.checkDeadline(session, true)
      if (!result.confirmed) throw new Error('PAIRING_BINDING_FAILED')
      recoveryRoot = decodeBase64Url(result.recoveryRoot, 32)
      const transcript = decodeBase64Url(result.transcript)
      const transcriptHash = decodeBase64Url(result.transcriptHash, 32)
      if (!sha256(transcript).equals(transcriptHash)) throw new Error('PAIRING_TRANSCRIPT_INVALID')
      token = randomBytes(32)
      const pairingId = encodeBase64Url(randomBytes(32))
      const descriptor = {
        transcriptHash: encodeBase64Url(transcriptHash), pairingId, operationId: session.operationId,
        targetGeneration: session.targetGeneration, basePRevision: session.basePRevision,
        baseCRevision: session.baseCRevision, tokenHash: encodeBase64Url(sha256(token))
      }
      commitKey = derivePairingKey(recoveryRoot, transcriptHash, 'commit-player')
      const prepareReceipt = makeReceipt('prepare', commitKey, descriptor, sha256(encodeFields(
        'KQ-Pair-record', 'kq-pair/2', transcriptHash, decodeBase64Url(pairingId),
        decodeBase64Url(session.operationId), session.targetGeneration, session.basePRevision,
        session.baseCRevision, sha256(token))))
      const encryptedRecoveryRoot = await this.store.encryptSecret(recoveryRoot)
      this.assertSessionCurrent(session)
      this.checkDeadline(session, true)
      const encryptedToken = await this.store.encryptSecret(token)
      this.assertSessionCurrent(session)
      this.checkDeadline(session, true)
      const journal: PairingJournal = {
        operationId: session.operationId, attemptId: session.attemptId, sessionId: session.sessionId,
        pairingId, role: 'player', phase: 'bound', context: session.context,
        transcript: encodeBase64Url(transcript), transcriptHash: encodeBase64Url(transcriptHash),
        descriptor, encryptedRecoveryRoot, encryptedToken, tokenHash: descriptor.tokenHash,
        receipts: [prepareReceipt]
      }
      const persistence = this.admitFirstJournal(session, journal)
      const outcome = await persistence.completion
      if (outcome.kind !== 'persisted') {
        await session.worker.close().catch(() => undefined)
        session.worker = undefined
        if (outcome.kind === 'uncertain') await this.closePresentationOnce(session, 'error').catch(() => undefined)
        return this.error(request, outcome.kind === 'absent' && outcome.error instanceof Error &&
          outcome.error.message === 'PAIRING_REVISION_CONFLICT' ? 409 : 503,
        outcome.kind === 'absent' && outcome.error instanceof Error &&
          outcome.error.message === 'PAIRING_REVISION_CONFLICT' ? 'REVISION_CONFLICT' :
          outcome.kind === 'absent' && (session.cancelRequested || persistence.cancelAfterAdmission) ? 'REJECTED' :
            outcome.kind === 'uncertain' ? 'RESULT_UNCERTAIN' : 'STORAGE_UNAVAILABLE')
      }
      await session.worker.close()
      session.worker = undefined
      if (persistence.cancelAfterAdmission || this.closed || this.session !== session) {
        return this.error(request, 503, 'RESULT_UNCERTAIN')
      }
      const preparedData = { transcript: journal.transcript, descriptor, token: encodeBase64Url(token), receipt: prepareReceipt }
      return makeResponse(responseEnvelope(request, 'response/prepare', preparedData))
    } catch (error) {
      return this.error(request, error instanceof Error && error.message === 'PAIRING_REVISION_CONFLICT' ? 409 : 503,
        error instanceof Error && error.message === 'PAIRING_REVISION_CONFLICT' ? 'REVISION_CONFLICT' :
          error instanceof Error && ['PAIRING_SESSION_FENCED', 'PAIRING_CANCELLED'].includes(error.message) ? 'REJECTED' :
            error instanceof Error && error.message === 'PAIRING_EXPIRED' ? 'EXPIRED' : 'STORAGE_UNAVAILABLE')
    } finally {
      token?.fill(0)
      recoveryRoot?.fill(0)
      commitKey?.fill(0)
    }
  }

  /** Synchronous admission is the cancellation/write ordering point; after it, cancellation cannot be confirmed until reconciliation. */
  private admitFirstJournal(session: ActivePlayerSession, journal: PairingJournal): FirstPairingPersistence {
    this.assertSessionCurrent(session)
    this.checkDeadline(session, true)
    if (session.firstPersistence) throw new Error('PAIRING_REVISION_CONFLICT')
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer)
    const persistence: FirstPairingPersistence = {
      status: 'writing', cancelAfterAdmission: false,
      completion: Promise.resolve({ kind: 'uncertain', error: new Error('PAIRING_PERSISTENCE_NOT_STARTED') })
    }
    session.firstPersistence = persistence
    persistence.completion = this.writeFirstJournal(session, journal, persistence)
    return persistence
  }

  private async writeFirstJournal(session: ActivePlayerSession, journal: PairingJournal,
    persistence: FirstPairingPersistence): Promise<FirstPairingPersistenceOutcome> {
    try {
      await this.store.transact(state => {
        if (state.authorityRevision !== Number(session.basePRevision) ||
            ((state.playerAuthority?.phase === 'active') !== (session.purpose === 'renewal')) || state.journals.some(item => item.role === 'player' &&
              (['bound', 'committed', 'uncertain'].includes(item.phase) ||
                (item.phase === 'active' && session.purpose !== 'renewal')))) throw new Error('PAIRING_REVISION_CONFLICT')
        state.authorityRevision = Number(session.basePRevision) + 1
        state.journals.push(journal)
      })
      session.state = transitionPlayerPairing(session.state, 'pending')
      persistence.status = 'persisted'
      return { kind: 'persisted' }
    } catch (error) {
      try {
        const confirmed = await this.store.read()
        const found = confirmed.journals.find(item => item.role === 'player' && item.sessionId === session.sessionId &&
          item.operationId === session.operationId && item.attemptId === session.attemptId)
        if (found) {
          if (found.phase !== 'bound' || found.transcriptHash !== journal.transcriptHash ||
              found.pairingId !== journal.pairingId || found.context.attemptId !== journal.context.attemptId) {
            persistence.status = 'uncertain'
            session.state = transitionPlayerPairing(session.state, 'blocked')
            return { kind: 'uncertain', error }
          }
          session.state = transitionPlayerPairing(session.state, 'pending')
          persistence.status = 'persisted'
          return { kind: 'persisted' }
        }
        persistence.status = 'absent'
        session.state = persistence.cancelAfterAdmission
          ? transitionPlayerPairing(session.state, 'cancelled') : transitionPlayerPairing(session.state, 'error')
        return { kind: 'absent', error }
      } catch (reconcileError) {
        persistence.status = 'uncertain'
        session.state = transitionPlayerPairing(session.state, 'blocked')
        return { kind: 'uncertain', error: reconcileError }
      }
    }
  }

  private async commitPrepared(request: PairingEnvelope, session?: ActivePlayerSession): Promise<RemoteHttpResponse> {
    const journal = await this.findJournal(request)
    if (journal?.phase === 'committed' || journal?.phase === 'active') {
      try {
        const root = await this.store.decryptSecret(journal.encryptedRecoveryRoot)
        const descriptor = descriptorFromJournal(journal)
        const keyC = derivePairingKey(root, decodeBase64Url(journal.transcriptHash, 32), 'commit-controller')
        const previous = nextReceiptDigest(journal.receipts[0])
        const prepared = request.payload.receipt as { type: string; tag: string }
        const saved = journal.receipts.find(item => item.type === 'prepared')
        const valid = Boolean(saved && prepared.type === saved.type && prepared.tag === saved.tag &&
          verifyReceipt(prepared, keyC, descriptor, previous, 'prepared'))
        root.fill(0); keyC.fill(0)
        if (!valid) return this.error(request, 403, 'AUTH_FAILED')
      } catch { return this.error(request, 403, 'AUTH_FAILED') }
      const committed = [...journal.receipts].reverse().find(item => item.type === 'committed')
      if (committed) return makeResponse(responseEnvelope(request, 'response/committed', { receipt: committed }))
    }
    if (!journal || journal.phase !== 'bound') return this.error(request, 409, 'RESULT_UNCERTAIN')
    try {
      const root = await this.store.decryptSecret(journal.encryptedRecoveryRoot)
      const descriptor = descriptorFromJournal(journal)
      const keyC = derivePairingKey(root, decodeBase64Url(journal.transcriptHash, 32), 'commit-controller')
      const previous = nextReceiptDigest(journal.receipts[0])
      const receipt = request.payload.receipt as { type: string; tag: string }
      if (!verifyReceipt(receipt, keyC, descriptor, previous, 'prepared')) throw new Error('PAIRING_RECEIPT_INVALID')
      const keyP = derivePairingKey(root, decodeBase64Url(journal.transcriptHash, 32), 'commit-player')
      const committed = makeReceipt('committed', keyP, descriptor, nextReceiptDigest(receipt))
      await this.store.transact(state => {
        const current = state.journals.find(item => item.role === 'player' && item.pairingId === journal.pairingId)
        if (!current || current.phase !== 'bound' || state.authorityRevision !== Number(journal.context.basePRevision) + 1) {
          throw new Error('PAIRING_REVISION_CONFLICT')
        }
        current.receipts.push(receipt, committed)
        current.phase = 'committed'
        state.authorityRevision = Number(journal.context.basePRevision) + 2
      })
      root.fill(0); keyC.fill(0); keyP.fill(0)
      if (session && session.sessionId === request.sessionId) session.state = 'committed'
      return makeResponse(responseEnvelope(request, 'response/committed', { receipt: committed }))
    } catch (error) {
      return this.error(request, error instanceof Error && error.message === 'PAIRING_RECEIPT_INVALID' ? 403 : 503,
        error instanceof Error && error.message === 'PAIRING_RECEIPT_INVALID' ? 'AUTH_FAILED' : 'RESULT_UNCERTAIN')
    }
  }

  private async activate(request: PairingEnvelope, session?: ActivePlayerSession): Promise<RemoteHttpResponse> {
    const journal = await this.findJournal(request)
    if (journal?.phase === 'active') {
      if (journal.context.purpose === 'renewal') {
        try { await this.promoteRenewal?.() }
        catch { return this.error(request, 503, 'RESULT_UNCERTAIN') }
      }
      try {
        const root = await this.store.decryptSecret(journal.encryptedRecoveryRoot)
        const descriptor = descriptorFromJournal(journal)
        const transcriptHash = decodeBase64Url(journal.transcriptHash, 32)
        const keyC = derivePairingKey(root, transcriptHash, 'commit-controller')
        const final = request.payload.receipt as { type: string; tag: string }
        const savedFinal = journal.receipts.find(item => item.type === 'final')
        const committed = journal.receipts.find(item => item.type === 'committed')
        const valid = Boolean(savedFinal && committed && final.type === savedFinal.type && final.tag === savedFinal.tag &&
          verifyReceipt(final, keyC, descriptor, nextReceiptDigest(committed), 'final'))
        root.fill(0); keyC.fill(0)
        if (!valid) return this.error(request, 403, 'AUTH_FAILED')
      } catch { return this.error(request, 403, 'AUTH_FAILED') }
      const active = [...journal.receipts].reverse().find(item => item.type === 'active')
      if (active) return makeResponse(responseEnvelope(request, 'response/active', { receipt: active }))
    }
    if (!journal || journal.phase !== 'committed') return this.error(request, 409, 'RESULT_UNCERTAIN')
    try {
      const root = await this.store.decryptSecret(journal.encryptedRecoveryRoot)
      const descriptor = descriptorFromJournal(journal)
      const transcriptHash = decodeBase64Url(journal.transcriptHash, 32)
      const keyC = derivePairingKey(root, transcriptHash, 'commit-controller')
      const previous = nextReceiptDigest(journal.receipts[journal.receipts.length - 1])
      const final = request.payload.receipt as { type: string; tag: string }
      if (!verifyReceipt(final, keyC, descriptor, previous, 'final')) throw new Error('PAIRING_RECEIPT_INVALID')
      const keyP = derivePairingKey(root, transcriptHash, 'commit-player')
      const active = makeReceipt('active', keyP, descriptor, nextReceiptDigest(final))
      const encryptedToken = journal.encryptedToken
      if (!encryptedToken || !journal.tokenHash) throw new Error('PAIRING_CREDENTIAL_MISSING')
      await this.store.transact(state => {
        const current = state.journals.find(item => item.role === 'player' && item.pairingId === journal.pairingId)
        if (!current || current.phase !== 'committed' || state.authorityRevision !== Number(journal.context.basePRevision) + 2) {
          throw new Error('PAIRING_REVISION_CONFLICT')
        }
        current.receipts.push(final, active)
        current.phase = 'active'
        state.authorityRevision = Number(journal.context.basePRevision) + 3
        if (journal.context.purpose === 'renewal') {
          const renewal = state.renewal
          const previousAuthority = state.playerAuthority
          if (!renewal || renewal.phase !== 'staged' ||
              renewal.newFingerprint !== Buffer.from(decodeBase64Url(journal.context.fingerprint, 32)).toString('hex') ||
              !previousAuthority || previousAuthority.phase !== 'active' ||
              previousAuthority.controllerId !== journal.context.controllerId ||
              previousAuthority.certificateFingerprintSha256 !== renewal.oldFingerprint) {
            throw new Error('PAIRING_REVISION_CONFLICT')
          }
          for (const oldJournal of state.journals) {
            if (oldJournal.role === 'player' && oldJournal.phase === 'active' && oldJournal.pairingId !== journal.pairingId) {
              oldJournal.phase = 'revoked'
            }
          }
          renewal.phase = 'promoting'
        }
        state.playerAuthority = {
          controllerId: journal.context.controllerId,
          credentialGeneration: Number(journal.context.targetGeneration),
          authorityRevision: state.authorityRevision,
          certificateFingerprintSha256: Buffer.from(decodeBase64Url(journal.context.fingerprint)).toString('hex'),
          tokenHash: journal.tokenHash!, encryptedToken, encryptedRecoveryRoot: journal.encryptedRecoveryRoot,
          pairingId: journal.pairingId, phase: 'active', scopes: ['transport:control']
        }
      })
      root.fill(0); keyC.fill(0); keyP.fill(0)
      if (journal.context.purpose === 'renewal') {
        try { await this.promoteRenewal?.() }
        catch { return this.error(request, 503, 'RESULT_UNCERTAIN') }
      }
      if (session && session.sessionId === request.sessionId) {
        session.state = 'active'
        session.code = ''
        if (session.deadlineTimer) clearTimeout(session.deadlineTimer)
        await this.presentation?.closePairing({ outcome: 'active' })
      }
      return makeResponse(responseEnvelope(request, 'response/active', { receipt: active }))
    } catch (error) {
      return this.error(request, error instanceof Error && error.message === 'PAIRING_RECEIPT_INVALID' ? 403 : 503,
        error instanceof Error && error.message === 'PAIRING_RECEIPT_INVALID' ? 'AUTH_FAILED' : 'RESULT_UNCERTAIN')
    }
  }

  private async status(request: PairingEnvelope): Promise<RemoteHttpResponse> {
    const state = await this.store.read()
    const journal = state.journals.find(item => item.role === 'player' && item.sessionId === request.sessionId &&
      item.operationId === request.operationId && item.attemptId === request.attemptId)
    if (!journal) return this.error(request, 409, 'RESULT_UNCERTAIN')
    if (journal.context.purpose === 'renewal' && journal.phase === 'active' && state.renewal?.phase === 'promoting') {
      try { await this.promoteRenewal?.() }
      catch { return this.error(request, 503, 'RESULT_UNCERTAIN') }
    }
    try {
      const root = await this.store.decryptSecret(journal.encryptedRecoveryRoot)
      const descriptor = descriptorFromJournal(journal)
      const transcriptHash = decodeBase64Url(journal.transcriptHash, 32)
      const payload = request.payload
      const requestedPairing = String(payload.pairingId)
      if (requestedPairing !== '' && requestedPairing !== journal.pairingId) throw new Error('PAIRING_RECOVERY_REJECTED')
      const queryPhase = String(payload.localPhase)
      if (!['bound', 'prepared', 'committed', 'active'].includes(queryPhase)) throw new Error('PAIRING_RECOVERY_REJECTED')
      if (requestedPairing === '' && (queryPhase !== 'bound' || journal.phase !== 'bound')) throw new Error('PAIRING_RECOVERY_REJECTED')
      const expectedDigest = this.receiptDigestForPhase(journal, queryPhase, root)
      if (!timingSafeEqual(expectedDigest, decodeBase64Url(payload.receiptDigest, 32))) throw new Error('PAIRING_RECOVERY_REJECTED')
      const nonce = decodeBase64Url(payload.nonce, 32)
      const queryBytes = encodeFields('KQ-Pair-recovery', 'kq-pair/2', 'query', transcriptHash,
        requestedPairing ? decodeBase64Url(requestedPairing, 32) : Buffer.alloc(0),
        decodeBase64Url(journal.operationId), descriptor.targetGeneration, nonce, queryPhase, expectedDigest)
      const keyQController = derivePairingKey(root, transcriptHash, 'recovery-controller')
      if (!verifyMac(keyQController, queryBytes, String(payload.mac))) throw new Error('PAIRING_RECOVERY_REJECTED')
      const includePrepare = requestedPairing === '' && journal.phase === 'bound'
      let prepare: Record<string, unknown> | null = null
      let prepareDigest: Uint8Array = Buffer.alloc(32)
      if (includePrepare) {
        if (!journal.encryptedToken || !journal.tokenHash) throw new Error('PAIRING_CREDENTIAL_MISSING')
        const token = await this.store.decryptSecret(journal.encryptedToken)
        const first = journal.receipts.find(receipt => receipt.type === 'prepare')!
        prepare = { transcript: journal.transcript, descriptor, token: encodeBase64Url(token), receipt: first }
        prepareDigest = sha256(encodeFields(decodeBase64Url(journal.transcript),
          // Reconstruct B from the canonical descriptor rather than trusting a stored wire string.
          this.recordFromDescriptor(descriptor), token, encodeFields(first.type, decodeBase64Url(first.tag))))
        token.fill(0)
      }
      const receiptsBytes = Buffer.concat(journal.receipts.map(receipt => encodeFields(receipt.type, decodeBase64Url(receipt.tag))))
      const phase = journal.phase === 'bound' ? 'pending' : journal.phase
      const answerBytes = encodeFields('KQ-Pair-recovery', 'kq-pair/2', 'answer', transcriptHash,
        decodeBase64Url(journal.pairingId), decodeBase64Url(journal.operationId), descriptor.targetGeneration, nonce,
        phase, this.receiptDigestForCurrent(journal), receiptsBytes, prepareDigest)
      const keyQPlayer = derivePairingKey(root, transcriptHash, 'recovery-player')
      const mac = encodeBase64Url(rawHmac(keyQPlayer, answerBytes))
      const response = responseEnvelope(request, 'response/status-result', {
        pairingId: journal.pairingId, nonce: encodeBase64Url(nonce), phase,
        receiptDigest: encodeBase64Url(this.receiptDigestForCurrent(journal)),
        receipts: journal.receipts, prepare, mac
      })
      root.fill(0); keyQController.fill(0); keyQPlayer.fill(0)
      return makeResponse(response)
    } catch {
      return this.error(request, 403, 'AUTH_FAILED')
    }
  }

  private async findJournal(request: PairingEnvelope): Promise<PairingJournal | undefined> {
    const state = await this.store.read()
    return state.journals.find(item => item.role === 'player' && item.sessionId === request.sessionId &&
      item.operationId === request.operationId && item.attemptId === request.attemptId)
  }

  private context(session: ActivePlayerSession): PairingContextFields {
    return { purpose: session.purpose, sessionId: session.sessionId, operationId: session.operationId,
      attemptId: session.attemptId, nonceC: session.nonceC, nonceP: session.nonceP,
      controllerId: session.controllerId, playerId: this.identity.deviceId,
      fingerprint: encodeBase64Url(Buffer.from(this.identity.certificateFingerprintSha256!, 'hex')),
      serverName: `player-${this.identity.deviceId}.karaoke.invalid`, expectedGeneration: session.expectedGeneration,
      targetGeneration: session.targetGeneration, basePRevision: session.basePRevision,
      baseCRevision: session.baseCRevision }
  }

  private async serialize(session: ActivePlayerSession, operation: () => Promise<RemoteHttpResponse>): Promise<RemoteHttpResponse> {
    const previous = session.serial
    let release!: () => void
    session.serial = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await operation() }
    finally { release() }
  }

  private checkDeadline(session: ActivePlayerSession, code: boolean = false): void {
    const deadline = code ? session.codeDeadline : session.consentDeadline
    if (deadline && this.clock.monotonicNow() >= deadline) {
      session.code = ''
      if (!['pending', 'committed', 'active', 'cancelled', 'rejected', 'timed-out'].includes(session.state)) {
        session.state = 'timed-out'
        if (session.deadlineTimer) clearTimeout(session.deadlineTimer)
        void this.presentation?.closePairing({ outcome: 'timed-out' })
      }
      throw new Error('PAIRING_EXPIRED')
    }
  }

  private assertSessionCurrent(session: ActivePlayerSession): void {
    if (this.closed || this.session !== session || session.cancelRequested ||
        ['cancelled', 'timed-out', 'rejected', 'error'].includes(session.state)) throw new Error('PAIRING_SESSION_FENCED')
  }

  private scheduleDeadline(session: ActivePlayerSession, deadline: number): void {
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer)
    const check = (): void => {
      if (this.session !== session || this.closed || ['pending', 'committed', 'active', 'rejected', 'cancelled', 'timed-out'].includes(session.state)) return
      if (session.firstPersistence?.status === 'writing') return
      const remaining = deadline - this.clock.monotonicNow()
      if (remaining > 0) {
        session.deadlineTimer = setTimeout(check, remaining)
        session.deadlineTimer.unref()
        return
      }
      session.code = ''
      session.state = 'timed-out'
      void session.worker?.close()
      session.worker = undefined
      void this.presentation?.closePairing({ outcome: 'timed-out' })
    }
    session.deadlineTimer = setTimeout(check, Math.max(1, deadline - this.clock.monotonicNow()))
    session.deadlineTimer.unref()
  }

  private matchesCapability(request: PairingEnvelope, session: ActivePlayerSession): boolean {
    try { return timingSafeEqual(decodeBase64Url(String(request.payload.sessionCapability), 32),
      decodeBase64Url(session.capability, 32)) } catch { return false }
  }

  private receiptDigestForCurrent(journal: PairingJournal): Buffer {
    const last = journal.receipts[journal.receipts.length - 1]
    return last ? nextReceiptDigest(last) : Buffer.alloc(32)
  }

  private receiptDigestForPhase(journal: PairingJournal, phase: string, root: Uint8Array): Buffer {
    if (phase === 'bound') return Buffer.alloc(32)
    const descriptor = descriptorFromJournal(journal)
    if (phase === 'prepared') {
      const saved = journal.receipts.find(item => item.type === 'prepared')
      if (saved) return nextReceiptDigest(saved)
      const prepare = journal.receipts.find(item => item.type === 'prepare')
      if (!prepare) throw new Error('PAIRING_RECOVERY_REJECTED')
      const key = derivePairingKey(root, decodeBase64Url(journal.transcriptHash, 32), 'commit-controller')
      try {
        const predicted = makeReceipt('prepared', key, descriptor, nextReceiptDigest(prepare))
        return nextReceiptDigest(predicted)
      } finally { key.fill(0) }
    }
    if (phase === 'committed') {
      const final = [...journal.receipts].reverse().find(item => item.type === 'final')
      if (final) return nextReceiptDigest(final)
      const committed = [...journal.receipts].reverse().find(item => item.type === 'committed')
      if (!committed) throw new Error('PAIRING_RECOVERY_REJECTED')
      const key = derivePairingKey(root, decodeBase64Url(journal.transcriptHash, 32), 'commit-controller')
      try {
        const predicted = makeReceipt('final', key, descriptor, nextReceiptDigest(committed))
        return nextReceiptDigest(predicted)
      } finally { key.fill(0) }
    }
    if (phase === 'active') {
      const active = [...journal.receipts].reverse().find(item => item.type === 'active')
      return active ? nextReceiptDigest(active) : Buffer.alloc(32)
    }
    throw new Error('PAIRING_RECOVERY_REJECTED')
  }

  private recordFromDescriptor(descriptor: ReturnType<typeof descriptorFromJournal>): Buffer {
    return encodeFields('KQ-Pair-record', 'kq-pair/2', decodeBase64Url(descriptor.transcriptHash),
      decodeBase64Url(descriptor.pairingId), decodeBase64Url(descriptor.operationId), descriptor.targetGeneration,
      descriptor.basePRevision, descriptor.baseCRevision, decodeBase64Url(descriptor.tokenHash))
  }

  private error(request: PairingEnvelope, statusCode: number, code: string): RemoteHttpResponse {
    let envelope: PairingEnvelope
    if (request.sessionId === '' && request.operationId === '' && request.attemptId === '') {
      envelope = { version: 'kq-pair/2', type: 'response/error', sessionId: '', operationId: '', attemptId: '',
        payload: { code, state: 'error' } }
    } else envelope = responseEnvelope(request, 'response/error', { code, state: this.session?.state ?? 'error' })
    return { statusCode, contentType: 'application/json', body: encodePairingEnvelope(envelope) }
  }

  private rawError(statusCode: number, code: string): RemoteHttpResponse {
    return { statusCode, contentType: 'application/json', body: Buffer.from(JSON.stringify({ error: code })) }
  }
}
