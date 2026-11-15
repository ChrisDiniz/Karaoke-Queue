import assert from 'node:assert/strict'
import test from 'node:test'
import { advancePairingUiEventCursor, getCandidatePairingAction, safeReason, toRemoteUiCandidate, toRemoteUiConnection,
  toPlayerTransportConnection } from '../src/remote-ui-contracts'
import type { DiscoveryCandidate } from '../src/remote-contracts'
import type { RemotePeerStatus } from '../src/remote-reconnection-service'
import type { RemoteUiSnapshot } from '../src/remote-ui-contracts'
import { describePlayerPairingError } from '../src/standalone-remote-pairing-view'
import { connectionLabel, connectionTone, describeManagementPairingError } from '../src/ui/remote-devices-view'

test('Renderer connection DTO never confuses synchronization with business-control authority', () => {
  const status: RemotePeerStatus = { playerId: 'player-1', state: 'synchronized', reason: null,
    retryAt: null, connectionId: 'connection-1', synchronized: true }
  assert.deepEqual(toRemoteUiConnection(status), {
    deviceId: 'player-1', deviceRole: 'player', state: 'synchronized', reason: null,
    retryAt: null, reconciled: true
  })
  assert.equal(toPlayerTransportConnection('controller-1', 'authorized').reconciled, false)
})

test('Management connection cards present every transport/reconciliation state without implying business authority', () => {
  const cases = [
    ['disabled', 'Reconexão desativada', 'offline'],
    ['backoff', 'Aguardando nova tentativa', 'pending'],
    ['connecting', 'Conectando', 'pending'],
    ['authorized', 'Transporte autenticado', 'info'],
    ['reconciling', 'Conciliando estado', 'pending'],
    ['synchronized', 'Reconciliado tecnicamente · sem controle de negócio', 'info'],
    ['conflict', 'Conflito de confiança', 'error'],
    ['recovery_required', 'Recuperação necessária', 'error'],
    ['stopping', 'Encerrando conexão', 'pending'],
    ['blocked', 'Conexão bloqueada', 'error'],
    ['closed', 'Conexão encerrada', 'offline']
  ] as const
  for (const [state, label, tone] of cases) {
    const connection = { deviceId: 'player-1', deviceRole: 'player' as const, state,
      reason: null, retryAt: null, reconciled: state === 'synchronized' }
    assert.equal(connectionLabel(connection), label, `state ${state} has specific user-facing copy`)
    assert.equal(connectionTone(state), tone, `state ${state} gets its functional status tone`)
  }
})

test('discovery DTO marks all mDNS identity claims unverified and bounds display fields', () => {
  const candidate: DiscoveryCandidate = { candidateId: 'candidate-1', instanceName: 'host',
    displayName: 'x'.repeat(100), deviceIdClaim: 'untrusted-claim', interfaceAddress: '192.168.1.2',
    addresses: ['192.168.1.4', 'a'.repeat(46)], port: 44321, observedAt: 1, expiresAt: 20, verified: false }
  const dto = toRemoteUiCandidate(candidate)
  assert.equal(dto.displayName.length, 64)
  assert.deepEqual(dto.addresses, ['192.168.1.4'])
  assert.equal(dto.verified, false)
  assert.equal(dto.claimedDeviceId, 'untrusted-claim')
})

test('candidate pairing action recovers journal-only initial pairing and blocks uncertain duplication', () => {
  const candidate: DiscoveryCandidate = { candidateId: 'candidate-1', instanceName: 'host', displayName: 'Player',
    deviceIdClaim: 'expected-player', interfaceAddress: '192.168.1.2', addresses: ['192.168.1.2'],
    port: 44321, observedAt: 1, expiresAt: 20, verified: false }
  const snapshot: RemoteUiSnapshot = { revision: 1, role: 'management', intent: 'enabled', listener: 'stopped',
    listenerEndpoint: null, discovery: 'ready', candidates: [], connections: [], operations: [], savedDevices: [],
    pairingRecoveries: [{ playerId: 'expected-player', recoveryActionAvailable: true }],
    pairingStoreStatus: 'available',
    playerPairing: 'unavailable', errorCode: null }
  assert.deepEqual(getCandidatePairingAction(snapshot, toRemoteUiCandidate(candidate)),
    { kind: 'recovery', playerId: 'expected-player' },
    'a pre-authority journal renders recovery rather than starting a duplicate initial pairing')

  const uncertainSnapshot = { ...snapshot, pairingRecoveries: [{ playerId: 'expected-player', recoveryActionAvailable: false }] }
  assert.deepEqual(getCandidatePairingAction(uncertainSnapshot, toRemoteUiCandidate(candidate)),
    { kind: 'recovery-blocked', playerId: 'expected-player' },
    'an uncertain journal blocks duplicate pairing without offering unsupported recovery')

  const unrelatedSnapshot = { ...snapshot, pairingRecoveries: [{ playerId: 'another-player', recoveryActionAvailable: true }] }
  assert.deepEqual(getCandidatePairingAction(unrelatedSnapshot, toRemoteUiCandidate(candidate)), { kind: 'initial' },
    'an unrelated discovery identity cannot select another Player journal')
  assert.deepEqual(getCandidatePairingAction({ ...snapshot, pairingStoreStatus: 'unavailable' }, toRemoteUiCandidate(candidate)),
    { kind: 'unavailable' }, 'an unreadable durable pairing journal never offers a new or recovery pairing')
})

test('connection errors become bounded codes before reaching the Renderer', () => {
  assert.equal(safeReason('REMOTE_CERTIFICATE_EXPIRED'), 'REMOTE_CERTIFICATE_EXPIRED')
  assert.equal(safeReason('/home/private/certificate.pem'), 'REMOTE_CONNECTION_ERROR')
  assert.equal(safeReason('stack line\nsecret'), 'REMOTE_CONNECTION_ERROR')
})

test('secure-storage and pairing-journal failures receive explicit safe recovery copy', () => {
  assert.match(describePlayerPairingError('SECRET_STORAGE_UNAVAILABLE'), /cofre seguro não está disponível/)
  assert.match(describePlayerPairingError('SECRET_STORAGE_UNSUPPORTED'), /não oferece o cofre seguro/)
  assert.match(describeManagementPairingError('PAIRING_STORE_READ_FAILED') ?? '', /dados foram preservados/)
  assert.match(describeManagementPairingError('PAIRING_STORE_INVALID') ?? '', /permanecem bloqueados/)
  assert.equal(describeManagementPairingError('/private/profile'), undefined,
    'unknown internal paths and exception details are never echoed into the UI')
})

test('pairing UI ignores stale, mismatched, and post-terminal events from earlier sessions', () => {
  const first = advancePairingUiEventCursor({ revision: 0, terminal: false },
    { requestId: 'request-a', revision: 1 })
  assert.deepEqual(first, { requestId: 'request-a', revision: 1, terminal: false })
  assert.equal(advancePairingUiEventCursor(first!, { requestId: 'request-a', revision: 0 }), null)
  assert.equal(advancePairingUiEventCursor(first!, { requestId: 'request-b', revision: 1 }), null)
  const closed = advancePairingUiEventCursor(first!, { requestId: 'request-a', revision: 1 }, true)
  assert.deepEqual(closed, { requestId: 'request-a', revision: 1, terminal: true })
  assert.equal(advancePairingUiEventCursor(closed!, { requestId: 'request-a', revision: 1 }), null)
  assert.deepEqual(advancePairingUiEventCursor(closed!, { requestId: 'request-b', revision: 2 }),
    { requestId: 'request-b', revision: 2, terminal: false })
})
