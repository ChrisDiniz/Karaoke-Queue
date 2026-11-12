import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { DiscoveryCandidate, RemoteDeviceIdentity } from './remote-contracts'
import { createBootstrapChannel } from './remote-clients'
import type { BootstrapOperation, BootstrapResponse } from './remote-clients'
import { probeBootstrapCertificate } from './remote-tls'
import type { BootstrapCertificateCandidate } from './remote-tls'
import { decodeBase64Url, derivePairingKey, encodeBase64Url, encodeFields, makeReceipt,
  nextReceiptDigest, opaqueUserIdentifier, pairingMac, sha256, verifyReceipt, buildPairingRecord } from './pairing-crypto'
import type { PairingContextFields, PairingDescriptor } from './pairing-crypto'
import { MainOpaqueWorker } from './opaque-worker-client'
import type { OpaqueWorkerPort } from './opaque-worker-client'
import { PairingStore, type PairingJournal } from './pairing-store'
import { encodePairingEnvelope, parsePairingEnvelope } from './pairing-wire'
import type { PairingEnvelope } from './pairing-wire'

export interface PairingManagementPresentationPort {
  readonly approvedForProduction: boolean
  enterTemporaryCode(input: { playerName: string; expiresAt: number; signal: AbortSignal }): Promise<string | null>
  closePairing?(input: { outcome: 'cancelled' | 'active' | 'error' }): Promise<void> | void
}

export interface PairingControllerClock {
  monotonicNow(): number
  wait(ms: number, signal?: AbortSignal): Promise<void>
}

const systemClock: PairingControllerClock = {
  monotonicNow: () => Number(process.hrtime.bigint() / 1_000_000n),
  wait(ms, signal) {
    if (signal?.aborted) return Promise.reject(new Error('PAIRING_CANCELLED'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve() }, ms)
      const abort = (): void => { clearTimeout(timer); cleanup(); reject(new Error('PAIRING_CANCELLED')) }
      const cleanup = (): void => signal?.removeEventListener('abort', abort)
      timer.unref()
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

export interface PairingCandidateSelection {
  candidate: DiscoveryCandidate
  displayName: string
  purpose: 'initial' | 'renewal'
}

export interface PairingControllerResult {
  playerId: string
  pairingId: string
  credentialGeneration: number
  certificateFingerprintSha256: string
  phase: 'active-awaiting-reconciliation'
}

type Channel = ReturnType<typeof createBootstrapChannel>

function id32(): string { return encodeBase64Url(randomBytes(32)) }

function normalizeCode(value: string): string {
  const normalized = value.includes(' ') ? value.replace(' ', '') : value
  if (!/^\d{8}$/.test(normalized)) throw new Error('PAIRING_CODE_INVALID')
  return normalized
}

function descriptorMatches(descriptor: Record<string, unknown>, context: PairingContextFields,
  transcriptHash: string, token: Uint8Array): boolean {
  return descriptor.transcriptHash === transcriptHash && descriptor.operationId === context.operationId &&
    descriptor.targetGeneration === context.targetGeneration && descriptor.basePRevision === context.basePRevision &&
    descriptor.baseCRevision === context.baseCRevision && descriptor.tokenHash === encodeBase64Url(sha256(token)) &&
    typeof descriptor.pairingId === 'string' && decodeBase64Url(descriptor.pairingId, 32).length === 32
}

function buildEnvelope(type: string, sessionId: string, operationId: string, attemptId: string,
  payload: Record<string, unknown>): PairingEnvelope {
  return { version: 'kq-pair/2', type, sessionId, operationId, attemptId, payload }
}

function receiptDigest(receipts: readonly { type: string; tag: string }[]): Buffer {
  const last = receipts[receipts.length - 1]
  return last ? nextReceiptDigest(last) : Buffer.alloc(32)
}

function validateReceiptPrefix(receipts: readonly { type: string; tag: string }[], descriptor: PairingDescriptor,
  root: Uint8Array): void {
  const sequence = ['prepare', 'prepared', 'committed', 'final', 'active']
  if (receipts.length < 1 || receipts.length > sequence.length ||
      receipts.some((receipt, index) => receipt.type !== sequence[index])) throw new Error('PAIRING_RECOVERY_INVALID')
  const transcriptHash = decodeBase64Url(descriptor.transcriptHash, 32)
  const keyP = derivePairingKey(root, transcriptHash, 'commit-player')
  const keyC = derivePairingKey(root, transcriptHash, 'commit-controller')
  try {
    let previous = sha256(buildPairingRecord(descriptor))
    for (const receipt of receipts) {
      const key = receipt.type === 'prepare' || receipt.type === 'committed' || receipt.type === 'active' ? keyP : keyC
      if (!verifyReceipt(receipt, key, descriptor, previous,
        receipt.type as 'prepare' | 'prepared' | 'committed' | 'final' | 'active')) throw new Error('PAIRING_RECOVERY_INVALID')
      previous = nextReceiptDigest(receipt)
    }
  } finally { keyP.fill(0); keyC.fill(0) }
}

/** Main-only Controller side. Production callers must supply an approved local code-entry presentation port. */
export class PairingControllerClient {
  private inFlight = false
  private closed = false
  private activeAbort: AbortController | undefined
  private activeCompletion: Promise<void> | undefined

  constructor(
    private readonly identity: () => Promise<RemoteDeviceIdentity>,
    private readonly store: PairingStore,
    private readonly presentation: PairingManagementPresentationPort,
    private readonly clock: PairingControllerClock = systemClock,
    private readonly probe: (address: string, port: number) => Promise<BootstrapCertificateCandidate> = (address, port) =>
      probeBootstrapCertificate(address, port),
    private readonly channelFactory: (address: string, port: number, pin: BootstrapCertificateCandidate) => Channel =
      (address, port, pin) => createBootstrapChannel({ address, port, candidatePin: pin }),
    private readonly createWorker: () => OpaqueWorkerPort = () => new MainOpaqueWorker()
  ) {
    if (presentation.approvedForProduction !== true) throw new Error('PAIRING_PRESENTATION_UNAPPROVED')
  }

  async pair(selection: PairingCandidateSelection, signal = new AbortController().signal): Promise<PairingControllerResult> {
    if (this.closed) throw new Error('PAIRING_CONTROLLER_CLOSED')
    if (this.inFlight) throw new Error('PAIRING_BUSY')
    this.inFlight = true
    const localAbort = new AbortController()
    this.activeAbort = localAbort
    let complete!: () => void
    this.activeCompletion = new Promise<void>(resolve => { complete = resolve })
    signal = AbortSignal.any([signal, localAbort.signal])
    let channel: Channel | undefined
    let sessionId = ''
    let operationId = ''
    let sessionCapability = ''
    let currentAttemptId = ''
    let worker: OpaqueWorkerPort | undefined
    let code = ''
    const transientSecrets: Buffer[] = []
    try {
      if (signal.aborted) throw new Error('PAIRING_CANCELLED')
      await this.store.assertSecureStorageAvailable()
      const controller = await this.identity()
      if (signal.aborted) throw new Error('PAIRING_CANCELLED')
      if (controller.role !== 'controller') throw new Error('PAIRING_CONTROLLER_IDENTITY_INVALID')
      const address = selection.candidate.addresses[0] ?? selection.candidate.interfaceAddress
      const pin = await this.probe(address, selection.candidate.port)
      const playerId = pin.deviceIdClaim
      if (!playerId || (selection.candidate.deviceIdClaim && selection.candidate.deviceIdClaim !== playerId)) {
        throw new Error('PAIRING_DISCOVERY_IDENTITY_MISMATCH')
      }
      const durableState = await this.store.read()
      const existing = durableState.controllerAuthorities[playerId]
      if (durableState.journals.some(item => item.role === 'controller' && item.context.playerId === playerId &&
          ['bound', 'prepared', 'committed', 'uncertain'].includes(item.phase))) {
        throw new Error('PAIRING_RESULT_UNCERTAIN')
      }
      if (selection.purpose === 'initial' && existing?.phase === 'active') throw new Error('PAIRING_ALREADY_ACTIVE')
      if (selection.purpose === 'renewal' && existing?.phase !== 'active') throw new Error('PAIRING_RENEWAL_REQUIRED')
      const baseCRevision = String(existing?.authorityRevision ?? 0)
      channel = this.channelFactory(address, selection.candidate.port, pin)
      const nonceC = id32()
      const open = buildEnvelope('request/open', '', '', '', {
        controllerId: controller.deviceId, displayName: selection.displayName, nonceC,
        purpose: selection.purpose, baseCRevision, profile: 'opaque-3dh-ristretto255-sha512-argon2id-m65536-t3-p4'
      })
      const opened = await this.send(channel, 'request', open, signal)
      if (opened.type !== 'response/opened' || opened.payload.playerId !== playerId ||
          opened.payload.serverName !== pin.serverName || opened.payload.fingerprint !== encodeBase64Url(Buffer.from(pin.fingerprintSha256, 'hex')) ||
          BigInt(String(opened.payload.targetGeneration)) !== BigInt(String(opened.payload.expectedGeneration)) + 1n ||
          String(opened.payload.baseCRevision) !== baseCRevision) throw new Error('PAIRING_OPEN_RESPONSE_INVALID')
      sessionId = opened.sessionId
      operationId = opened.operationId
      sessionCapability = String(opened.payload.sessionCapability)
      const nonceP = String(opened.payload.nonceP)
      const basePRevision = String(opened.payload.basePRevision)
      const expectedGeneration = String(opened.payload.expectedGeneration)
      const targetGeneration = String(opened.payload.targetGeneration)
      await this.waitUntilCodeReady(channel, opened, sessionCapability, signal)
      const remaining = await this.pollState(channel, opened, sessionCapability)
      let codeDeadline = this.clock.monotonicNow() + Number(remaining.payload.remainingSeconds) * 1000
      let lastError: Error | undefined

      for (let attempt = 0; attempt < 3; attempt++) {
        this.assertLive(codeDeadline, signal)
        const entered = await this.presentation.enterTemporaryCode({ playerName: selection.candidate.displayName,
          expiresAt: codeDeadline, signal })
        if (entered === null) throw new Error('PAIRING_CANCELLED')
        this.assertLive(codeDeadline, signal)
        code = normalizeCode(entered)
        currentAttemptId = id32()
        await this.store.reserveAttempt(sessionId, currentAttemptId)
        this.assertLive(codeDeadline, signal)
        const context: PairingContextFields = {
          purpose: selection.purpose, sessionId, operationId, attemptId: currentAttemptId, nonceC, nonceP,
          controllerId: controller.deviceId, playerId, fingerprint: encodeBase64Url(Buffer.from(pin.fingerprintSha256, 'hex')),
          serverName: pin.serverName, expectedGeneration, targetGeneration, basePRevision, baseCRevision
        }
        const userIdentifier = opaqueUserIdentifier(sessionId, currentAttemptId)
        worker = this.createWorker()
        const attemptWorker = worker
        try {
          const started = await attemptWorker.run<{ KE1: string }>({ operation: 'controller-start', password: code, context })
          this.assertLive(codeDeadline, signal)
          const proof = buildEnvelope('proof/ake-start', sessionId, operationId, currentAttemptId,
            { sessionCapability, KE1: started.KE1 })
          const response = await this.send(channel, 'proof', proof, signal)
          this.assertLive(codeDeadline, signal)
          if (response.type !== 'response/ake-response') throw new Error('PAIRING_AKE_RESPONSE_INVALID')
          const finished = await attemptWorker.run<{ KE3: string }>({ operation: 'controller-finish', password: code,
            ke2: String(response.payload.KE2) })
          this.assertLive(codeDeadline, signal)
          code = ''
          await this.store.completeAttempt(currentAttemptId, true)
          const finish = buildEnvelope('proof/ake-finish', sessionId, operationId, currentAttemptId, { KE3: finished.KE3 })
          const authenticated = await this.send(channel, 'proof', finish, signal)
          if (authenticated.type !== 'response/ake-confirmed') throw new Error('PAIRING_PLAYER_CONFIRMATION_INVALID')
          const schedule = await attemptWorker.run<{ controllerBind: string; transcript: string; transcriptHash: string; recoveryRoot: string }>({
            operation: 'controller-confirm-player-bind', playerBind: String(authenticated.payload.playerBind)
          })
          await worker.close()
          worker = undefined
          const transcript = decodeBase64Url(schedule.transcript)
          const transcriptHash = decodeBase64Url(schedule.transcriptHash, 32)
          if (!sha256(transcript).equals(transcriptHash)) throw new Error('PAIRING_TRANSCRIPT_INVALID')
          const root = decodeBase64Url(schedule.recoveryRoot, 32)
          transientSecrets.push(root)
          const boundJournal: PairingJournal = {
            operationId, attemptId: currentAttemptId, sessionId, pairingId: '', role: 'controller', phase: 'bound',
            context, transcript: schedule.transcript, transcriptHash: schedule.transcriptHash, descriptor: {},
            encryptedRecoveryRoot: await this.store.encryptSecret(root), receipts: []
          }
          await this.store.transact(state => {
            if (state.journals.some(item => item.role === 'controller' && item.context.playerId === playerId &&
                ['bound', 'prepared', 'committed', 'uncertain'].includes(item.phase))) {
              throw new Error('PAIRING_RESULT_UNCERTAIN')
            }
            state.journals.push(boundJournal)
          })
          const bind = buildEnvelope('confirm/controller-bind', sessionId, operationId, currentAttemptId,
            { controllerBind: schedule.controllerBind })
          const preparedResponse = await this.send(channel, 'confirm', bind, signal)
          if (preparedResponse.type !== 'response/prepare') throw new Error('PAIRING_PREPARE_INVALID')
          const descriptor = preparedResponse.payload.descriptor as Record<string, unknown>
          const token = decodeBase64Url(preparedResponse.payload.token, 32)
          transientSecrets.push(token)
          const keyP = derivePairingKey(root, transcriptHash, 'commit-player')
          transientSecrets.push(keyP)
          const previous0 = sha256(encodeFields('KQ-Pair-record', 'kq-pair/2', transcriptHash,
            decodeBase64Url(String(descriptor.pairingId), 32), decodeBase64Url(operationId), targetGeneration,
            basePRevision, baseCRevision, sha256(token)))
          if (!descriptorMatches(descriptor, context, schedule.transcriptHash, token) ||
              preparedResponse.payload.transcript !== schedule.transcript ||
              !verifyReceipt(preparedResponse.payload.receipt as { type: string; tag: string }, keyP,
                descriptor as never, previous0, 'prepare')) throw new Error('PAIRING_PREPARE_INVALID')
          const keyC = derivePairingKey(root, transcriptHash, 'commit-controller')
          transientSecrets.push(keyC)
          const encryptedToken = await this.store.encryptSecret(token)
          const preparedReceipt = makeReceipt('prepared', keyC, descriptor as never,
            nextReceiptDigest(preparedResponse.payload.receipt as { type: string; tag: string }))
          await this.store.transact(state => {
            const journal = state.journals.find(item => item.role === 'controller' && item.sessionId === sessionId && item.attemptId === currentAttemptId)
            if (!journal || journal.phase !== 'bound') throw new Error('PAIRING_REVISION_CONFLICT')
            journal.pairingId = String(descriptor.pairingId)
            journal.descriptor = descriptor as Record<string, string>
            journal.encryptedToken = encryptedToken
            journal.tokenHash = String(descriptor.tokenHash)
            journal.receipts = [preparedResponse.payload.receipt as { type: string; tag: string }, preparedReceipt]
            journal.phase = 'prepared'
            const currentAuthority = state.controllerAuthorities[playerId]
            if ((currentAuthority?.authorityRevision ?? 0) !== Number(baseCRevision)) throw new Error('PAIRING_REVISION_CONFLICT')
          })
          const preparedConfirm = buildEnvelope('confirm/prepared', sessionId, operationId, currentAttemptId,
            { receipt: preparedReceipt })
          const committedResponse = await this.send(channel, 'confirm', preparedConfirm, signal)
          if (committedResponse.type !== 'response/committed' || !verifyReceipt(committedResponse.payload.receipt as { type: string; tag: string },
              keyP, descriptor as never, nextReceiptDigest(preparedReceipt), 'committed')) throw new Error('PAIRING_COMMIT_RECEIPT_INVALID')
          const finalReceipt = makeReceipt('final', keyC, descriptor as never,
            nextReceiptDigest(committedResponse.payload.receipt as { type: string; tag: string }))
          await this.store.transact(state => {
            const journal = state.journals.find(item => item.role === 'controller' && item.pairingId === descriptor.pairingId)
            if (!journal || journal.phase !== 'prepared') throw new Error('PAIRING_REVISION_CONFLICT')
            journal.receipts.push(committedResponse.payload.receipt as { type: string; tag: string }, finalReceipt)
            journal.phase = 'committed'
          })
          const final = buildEnvelope('confirm/final', sessionId, operationId, currentAttemptId, { receipt: finalReceipt })
          const activeResponse = await this.send(channel, 'confirm', final, signal)
          if (activeResponse.type !== 'response/active' || !verifyReceipt(activeResponse.payload.receipt as { type: string; tag: string },
              keyP, descriptor as never, nextReceiptDigest(finalReceipt), 'active')) throw new Error('PAIRING_ACTIVE_RECEIPT_INVALID')
          const encryptedRoot = boundJournal.encryptedRecoveryRoot
          await this.store.transact(state => {
            const journal = state.journals.find(item => item.role === 'controller' && item.pairingId === descriptor.pairingId)
            if (!journal || journal.phase !== 'committed') throw new Error('PAIRING_REVISION_CONFLICT')
            for (const oldJournal of state.journals) {
              if (oldJournal.role === 'controller' && oldJournal.context.playerId === playerId &&
                  oldJournal.phase === 'active' && oldJournal.pairingId !== descriptor.pairingId) oldJournal.phase = 'revoked'
            }
            journal.receipts.push(activeResponse.payload.receipt as { type: string; tag: string })
            journal.phase = 'active'
            const authorityRevision = Number(baseCRevision) + 3
            state.controllerAuthorities[playerId] = {
              playerId, credentialGeneration: Number(targetGeneration), authorityRevision,
              certificatePem: pin.certificatePem, certificateFingerprintSha256: pin.fingerprintSha256,
              serverName: pin.serverName, address, port: selection.candidate.port,
              encryptedToken, encryptedRecoveryRoot: encryptedRoot, pairingId: String(descriptor.pairingId), phase: 'active'
            }
            state.authorityRevision++
          })
          for (const secret of transientSecrets) secret.fill(0)
          transientSecrets.length = 0
          await attemptWorker.close()
          worker = undefined
          await this.presentation.closePairing?.({ outcome: 'active' })
          return { playerId, pairingId: String(descriptor.pairingId), credentialGeneration: Number(targetGeneration),
            certificateFingerprintSha256: pin.fingerprintSha256, phase: 'active-awaiting-reconciliation' }
        } catch (error) {
          code = ''
          await attemptWorker.close().catch(() => undefined)
          worker = undefined
          if (error instanceof Error && error.message === 'PAIRING_AUTH_FAILED') {
            lastError = error
            codeDeadline = this.clock.monotonicNow() + Number((await this.pollState(channel, opened, sessionCapability)).payload.remainingSeconds) * 1000
            continue
          }
          throw error
        } finally { code = '' }
      }
      throw lastError ?? new Error('PAIRING_ATTEMPTS_EXHAUSTED')
    } catch (error) {
      if (sessionId && channel && signal.aborted) {
        const cancel = buildEnvelope('request/cancel', sessionId, operationId, '', { sessionCapability })
        await this.send(channel, 'request', cancel).catch(() => undefined)
      }
      throw error
    } finally {
      for (const secret of transientSecrets) secret.fill(0)
      code = ''
      await worker?.close().catch(() => undefined)
      channel?.close()
      if (this.activeAbort === localAbort) this.activeAbort = undefined
      this.inFlight = false
      complete()
      this.activeCompletion = undefined
    }
  }

  /** Recovers only a locally persisted bilateral operation, authenticated by its saved recovery root. */
  async recover(selection: PairingCandidateSelection, signal = new AbortController().signal): Promise<PairingControllerResult> {
    if (this.closed) throw new Error('PAIRING_CONTROLLER_CLOSED')
    if (this.inFlight) throw new Error('PAIRING_BUSY')
    this.inFlight = true
    const localAbort = new AbortController()
    this.activeAbort = localAbort
    let complete!: () => void
    this.activeCompletion = new Promise<void>(resolve => { complete = resolve })
    signal = AbortSignal.any([signal, localAbort.signal])
    let channel: Channel | undefined
    const transientSecrets: Buffer[] = []
    try {
      if (signal.aborted) throw new Error('PAIRING_CANCELLED')
      await this.store.assertSecureStorageAvailable()
      const controller = await this.identity()
      if (controller.role !== 'controller') throw new Error('PAIRING_CONTROLLER_IDENTITY_INVALID')
      const address = selection.candidate.addresses[0] ?? selection.candidate.interfaceAddress
      const pin = await this.probe(address, selection.candidate.port)
      const playerId = pin.deviceIdClaim
      if (!playerId || playerId !== selection.candidate.deviceIdClaim) throw new Error('PAIRING_DISCOVERY_IDENTITY_MISMATCH')
      const state = await this.store.read()
      const journal = state.journals.find(item => item.role === 'controller' && item.context.playerId === playerId &&
        ['bound', 'prepared', 'committed'].includes(item.phase))
      if (!journal) {
        const active = state.controllerAuthorities[playerId]
        if (active?.phase === 'active') {
          return { playerId, pairingId: active.pairingId, credentialGeneration: active.credentialGeneration,
            certificateFingerprintSha256: active.certificateFingerprintSha256, phase: 'active-awaiting-reconciliation' }
        }
        throw new Error('PAIRING_RESULT_UNCERTAIN')
      }
      if (journal.context.controllerId !== controller.deviceId || journal.context.purpose !== selection.purpose ||
          journal.context.serverName !== pin.serverName || journal.context.fingerprint !==
            encodeBase64Url(Buffer.from(pin.fingerprintSha256, 'hex'))) throw new Error('PAIRING_RECOVERY_IDENTITY_MISMATCH')
      const root = await this.store.decryptSecret(journal.encryptedRecoveryRoot)
      transientSecrets.push(root)
      const transcript = decodeBase64Url(journal.transcript)
      const transcriptHash = decodeBase64Url(journal.transcriptHash, 32)
      if (!sha256(transcript).equals(transcriptHash)) throw new Error('PAIRING_RECOVERY_INVALID')
      const phase = journal.phase as 'bound' | 'prepared' | 'committed'
      const knownReceipts = journal.receipts
      const phaseDigest = phase === 'bound' ? Buffer.alloc(32) : receiptDigest(knownReceipts)
      const nonce = randomBytes(32)
      const pairingId = phase === 'bound' ? Buffer.alloc(0) : decodeBase64Url(journal.pairingId, 32)
      const keyQuery = derivePairingKey(root, transcriptHash, 'recovery-controller')
      transientSecrets.push(keyQuery)
      const queryMac = pairingMac(keyQuery, 'KQ-Pair-recovery', 'kq-pair/2', 'query', transcriptHash,
        pairingId, decodeBase64Url(journal.operationId, 32), journal.context.targetGeneration,
        nonce, phase, phaseDigest)
      const status = buildEnvelope('confirm/status', journal.sessionId, journal.operationId, journal.attemptId, {
        pairingId: phase === 'bound' ? '' : journal.pairingId, nonce: encodeBase64Url(nonce), localPhase: phase,
        receiptDigest: encodeBase64Url(phaseDigest), mac: encodeBase64Url(queryMac)
      })
      channel = this.channelFactory(address, selection.candidate.port, pin)
      const response = await this.send(channel, 'confirm', status, signal)
      if (response.type !== 'response/status-result' || response.sessionId !== journal.sessionId ||
          response.operationId !== journal.operationId || response.attemptId !== journal.attemptId ||
          response.payload.nonce !== encodeBase64Url(nonce)) throw new Error('PAIRING_RECOVERY_RESPONSE_INVALID')
      const responsePairingId = decodeBase64Url(response.payload.pairingId, 32)
      if (phase !== 'bound' && !timingSafeEqual(responsePairingId, pairingId)) throw new Error('PAIRING_RECOVERY_RESPONSE_INVALID')
      const remoteReceipts = response.payload.receipts as Array<{ type: string; tag: string }>
      if (!Array.isArray(remoteReceipts) || remoteReceipts.length < 1 || remoteReceipts.length > 5 ||
          !timingSafeEqual(receiptDigest(remoteReceipts), decodeBase64Url(response.payload.receiptDigest, 32))) {
        throw new Error('PAIRING_RECOVERY_RESPONSE_INVALID')
      }
      const expectedCount = response.payload.phase === 'pending' ? 1 : response.payload.phase === 'committed' ? 3 : 5
      if (remoteReceipts.length !== expectedCount) throw new Error('PAIRING_RECOVERY_RESPONSE_INVALID')
      let descriptor: PairingDescriptor
      let token: Buffer
      let prepareDigest: Uint8Array = Buffer.alloc(32)
      const prepare = response.payload.prepare as { transcript: string; descriptor: PairingDescriptor;
        token: string; receipt: { type: string; tag: string } } | null
      if (prepare !== null) {
        if (phase !== 'bound' || prepare.transcript !== journal.transcript) throw new Error('PAIRING_RECOVERY_RESPONSE_INVALID')
        descriptor = prepare.descriptor
        token = decodeBase64Url(prepare.token, 32)
        transientSecrets.push(token)
        const record = buildPairingRecord(descriptor)
        prepareDigest = sha256(encodeFields(transcript, record, token,
          encodeFields(prepare.receipt.type, decodeBase64Url(prepare.receipt.tag, 32))))
      } else {
        if (phase === 'bound') throw new Error('PAIRING_RECOVERY_PREPARE_MISSING')
        descriptor = journal.descriptor as unknown as PairingDescriptor
        if (!journal.encryptedToken) throw new Error('PAIRING_CREDENTIAL_MISSING')
        token = await this.store.decryptSecret(journal.encryptedToken)
        transientSecrets.push(token)
      }
      if (descriptor.pairingId !== response.payload.pairingId ||
          !descriptorMatches(descriptor as unknown as Record<string, unknown>, journal.context, journal.transcriptHash, token)) {
        throw new Error('PAIRING_RECOVERY_DESCRIPTOR_INVALID')
      }
      validateReceiptPrefix(remoteReceipts, descriptor, root)
      for (const known of journal.receipts) {
        const index = remoteReceipts.findIndex(receipt => receipt.type === known.type)
        if (index >= 0 && remoteReceipts[index].tag !== known.tag) throw new Error('PAIRING_RECOVERY_RECEIPT_INVALID')
      }
      const prepareReceipt = remoteReceipts[0]
      if (prepare && (prepare.receipt.type !== prepareReceipt.type || prepare.receipt.tag !== prepareReceipt.tag)) {
        throw new Error('PAIRING_RECOVERY_PREPARE_INVALID')
      }
      const receiptBytes = Buffer.concat(remoteReceipts.map(item => encodeFields(item.type, decodeBase64Url(item.tag, 32))))
      const keyAnswer = derivePairingKey(root, transcriptHash, 'recovery-player')
      transientSecrets.push(keyAnswer)
      const expectedAnswer = pairingMac(keyAnswer, 'KQ-Pair-recovery', 'kq-pair/2', 'answer', transcriptHash,
        responsePairingId, decodeBase64Url(journal.operationId, 32), journal.context.targetGeneration,
        nonce, String(response.payload.phase), decodeBase64Url(response.payload.receiptDigest, 32), receiptBytes, prepareDigest)
      transientSecrets.push(expectedAnswer)
      if (!timingSafeEqual(decodeBase64Url(String(response.payload.mac), 32), expectedAnswer)) {
        throw new Error('PAIRING_RECOVERY_AUTH_FAILED')
      }
      keyQuery.fill(0)
      expectedAnswer.fill(0)

      const keyP = derivePairingKey(root, transcriptHash, 'commit-player')
      const keyC = derivePairingKey(root, transcriptHash, 'commit-controller')
      transientSecrets.push(keyP, keyC)
      let preparedReceipt: { type: string; tag: string }
      if (phase === 'bound') {
        const record = buildPairingRecord(descriptor)
        if (!verifyReceipt(prepareReceipt, keyP, descriptor, sha256(record), 'prepare')) {
          throw new Error('PAIRING_RECOVERY_PREPARE_INVALID')
        }
        const encryptedToken = await this.store.encryptSecret(token)
        preparedReceipt = makeReceipt('prepared', keyC, descriptor, nextReceiptDigest(prepareReceipt))
        await this.store.transact(candidate => {
          const current = candidate.journals.find(item => item.role === 'controller' && item.sessionId === journal.sessionId &&
            item.operationId === journal.operationId && item.attemptId === journal.attemptId)
          if (!current || current.phase !== 'bound' ||
              (candidate.controllerAuthorities[playerId]?.authorityRevision ?? 0) !== Number(journal.context.baseCRevision)) {
            throw new Error('PAIRING_REVISION_CONFLICT')
          }
          current.pairingId = descriptor.pairingId
          current.descriptor = descriptor as unknown as Record<string, string>
          current.encryptedToken = encryptedToken
          current.tokenHash = descriptor.tokenHash
          current.receipts = [prepareReceipt, preparedReceipt]
          current.phase = 'prepared'
        })
        journal.pairingId = descriptor.pairingId
        journal.descriptor = descriptor as unknown as Record<string, string>
        journal.encryptedToken = encryptedToken
        journal.tokenHash = descriptor.tokenHash
        journal.receipts = [prepareReceipt, preparedReceipt]
        journal.phase = 'prepared'
      } else {
        preparedReceipt = journal.receipts.find(item => item.type === 'prepared')!
        if (!preparedReceipt || !verifyReceipt(preparedReceipt, keyC, descriptor, nextReceiptDigest(prepareReceipt), 'prepared')) {
          throw new Error('PAIRING_RECOVERY_RECEIPT_INVALID')
        }
      }
      if (phase !== 'committed') {
        const prepared = buildEnvelope('confirm/prepared', journal.sessionId, journal.operationId, journal.attemptId,
          { receipt: preparedReceipt })
        const committedResponse = await this.send(channel, 'confirm', prepared, signal)
        if (committedResponse.type !== 'response/committed' ||
            !verifyReceipt(committedResponse.payload.receipt as { type: string; tag: string }, keyP,
              descriptor, nextReceiptDigest(preparedReceipt), 'committed')) throw new Error('PAIRING_COMMIT_RECEIPT_INVALID')
        const finalReceipt = makeReceipt('final', keyC, descriptor,
          nextReceiptDigest(committedResponse.payload.receipt as { type: string; tag: string }))
        await this.store.transact(candidate => {
          const current = candidate.journals.find(item => item.role === 'controller' && item.pairingId === descriptor.pairingId)
          if (!current || current.phase !== 'prepared') throw new Error('PAIRING_REVISION_CONFLICT')
          current.receipts.push(committedResponse.payload.receipt as { type: string; tag: string }, finalReceipt)
          current.phase = 'committed'
        })
        journal.receipts = [...journal.receipts, committedResponse.payload.receipt as { type: string; tag: string }, finalReceipt]
        journal.pairingId = descriptor.pairingId
        journal.phase = 'committed'
      }
      const finalReceipt = journal.receipts.find(item => item.type === 'final')
      if (!finalReceipt || !verifyReceipt(finalReceipt, keyC, descriptor,
          nextReceiptDigest(journal.receipts.find(item => item.type === 'committed')!), 'final')) {
        throw new Error('PAIRING_RECOVERY_RECEIPT_INVALID')
      }
      const final = buildEnvelope('confirm/final', journal.sessionId, journal.operationId, journal.attemptId,
        { receipt: finalReceipt })
      const activeResponse = await this.send(channel, 'confirm', final, signal)
      if (activeResponse.type !== 'response/active' ||
          !verifyReceipt(activeResponse.payload.receipt as { type: string; tag: string }, keyP,
            descriptor, nextReceiptDigest(finalReceipt), 'active')) throw new Error('PAIRING_ACTIVE_RECEIPT_INVALID')
      const encryptedRecoveryRoot = journal.encryptedRecoveryRoot
      const encryptedToken = journal.encryptedToken ?? await this.store.encryptSecret(token)
      await this.store.transact(candidate => {
        const current = candidate.journals.find(item => item.role === 'controller' && item.pairingId === descriptor.pairingId)
        if (!current || !['committed', 'active'].includes(current.phase)) throw new Error('PAIRING_REVISION_CONFLICT')
        if ((candidate.controllerAuthorities[playerId]?.authorityRevision ?? 0) !== Number(journal.context.baseCRevision)) {
          throw new Error('PAIRING_REVISION_CONFLICT')
        }
        for (const oldJournal of candidate.journals) {
          if (oldJournal.role === 'controller' && oldJournal.context.playerId === playerId &&
              oldJournal.phase === 'active' && oldJournal.pairingId !== descriptor.pairingId) oldJournal.phase = 'revoked'
        }
        if (current.phase === 'committed') current.receipts.push(activeResponse.payload.receipt as { type: string; tag: string })
        current.phase = 'active'
        const authorityRevision = Number(journal.context.baseCRevision) + 3
        candidate.controllerAuthorities[playerId] = {
          playerId, credentialGeneration: Number(journal.context.targetGeneration), authorityRevision,
          certificatePem: pin.certificatePem, certificateFingerprintSha256: pin.fingerprintSha256,
          serverName: pin.serverName, address, port: selection.candidate.port,
          encryptedToken, encryptedRecoveryRoot, pairingId: descriptor.pairingId, phase: 'active'
        }
        candidate.authorityRevision++
      })
      await Promise.resolve(this.presentation.closePairing?.({ outcome: 'active' })).catch(() => undefined)
      return { playerId, pairingId: descriptor.pairingId, credentialGeneration: Number(journal.context.targetGeneration),
        certificateFingerprintSha256: pin.fingerprintSha256, phase: 'active-awaiting-reconciliation' }
    } catch (error) {
      if (signal.aborted) await this.presentation.closePairing?.({ outcome: 'cancelled' })
      throw error
    } finally {
      for (const secret of transientSecrets) secret.fill(0)
      channel?.close()
      this.activeAbort = undefined
      this.inFlight = false
      complete()
      this.activeCompletion = undefined
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.activeAbort?.abort()
    await this.activeCompletion
  }

  private async waitUntilCodeReady(channel: Channel, opened: PairingEnvelope, capability: string, signal: AbortSignal): Promise<void> {
    let deadline = this.clock.monotonicNow() + 120_000
    for (;;) {
      this.assertLive(deadline, signal)
      const state = await this.pollState(channel, opened, capability)
      if (state.payload.state === 'code-ready') return
      if (['rejected', 'cancelled', 'timed-out', 'error', 'blocked'].includes(String(state.payload.state))) {
        throw new Error(`PAIRING_${String(state.payload.state).toUpperCase().replace(/-/g, '_')}`)
      }
      deadline = this.clock.monotonicNow() + Number(state.payload.remainingSeconds) * 1000
      await this.clock.wait(10_000, signal)
    }
  }

  private async pollState(channel: Channel, opened: PairingEnvelope, capability: string): Promise<PairingEnvelope> {
    const poll = buildEnvelope('request/poll', opened.sessionId, opened.operationId, '', { sessionCapability: capability })
    return this.send(channel, 'request', poll)
  }

  private async send(channel: Channel, operation: BootstrapOperation, message: PairingEnvelope,
    signal?: AbortSignal): Promise<PairingEnvelope> {
    const bytes = encodePairingEnvelope(message)
    let response: BootstrapResponse
    for (let quotaRetry = 0; ; quotaRetry++) {
      response = await channel.request(operation, bytes, signal)
      if (response.statusCode !== 429 || quotaRetry >= 2) break
      await this.clock.wait(6_000, signal)
    }
    if (response.statusCode === 429) throw new Error('PAIRING_RATE_LIMITED')
    if (response.statusCode < 200 || response.statusCode >= 300) {
      try {
        const failed = parsePairingEnvelope(response.body)
        const code = failed.type === 'response/error' ? String(failed.payload.code) : 'REMOTE_REQUEST_FAILED'
        throw new Error(code === 'AUTH_FAILED' ? 'PAIRING_AUTH_FAILED' : `PAIRING_${code}`)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('PAIRING_')) throw error
        throw new Error(response.statusCode === 503 ? 'PAIRING_RESULT_UNCERTAIN' : 'PAIRING_REMOTE_REQUEST_FAILED')
      }
    }
    let parsed: PairingEnvelope
    try { parsed = parsePairingEnvelope(response.body) }
    catch { throw new Error('PAIRING_RESPONSE_INVALID') }
    return parsed
  }

  private assertLive(deadline: number, signal: AbortSignal): void {
    if (signal.aborted) throw new Error('PAIRING_CANCELLED')
    if (this.clock.monotonicNow() >= deadline) throw new Error('PAIRING_EXPIRED')
  }
}
