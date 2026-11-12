import type { RemoteDeviceIdentity } from './remote-contracts'
import { generatePlayerCertificate, validatePlayerCertificate } from './remote-tls'
import { PairingStore, type PairingStoreState } from './pairing-store'
import { RemoteIdentityStore } from './remote-identity-store'

interface RenewalBundle {
  schemaVersion: 1
  role: 'player'
  deviceId: string
  createdAt: string
  certificatePem: string
  certificateFingerprintSha256: string
  privateKeyPem: string
}

function bundleFromIdentity(identity: RemoteDeviceIdentity): RenewalBundle {
  if (identity.role !== 'player' || !identity.certificatePem || !identity.privateKeyPem ||
      !identity.certificateFingerprintSha256) throw new Error('PAIRING_RENEWAL_IDENTITY_INVALID')
  const certificate = validatePlayerCertificate(identity.certificatePem, identity.privateKeyPem, identity.deviceId,
    new Date(), true)
  if (certificate.fingerprintSha256 !== identity.certificateFingerprintSha256) throw new Error('PAIRING_RENEWAL_IDENTITY_INVALID')
  return { schemaVersion: 1, role: 'player', deviceId: identity.deviceId, createdAt: identity.createdAt,
    certificatePem: identity.certificatePem, certificateFingerprintSha256: identity.certificateFingerprintSha256,
    privateKeyPem: identity.privateKeyPem }
}

function identityFromBundle(value: unknown): RemoteDeviceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PAIRING_RENEWAL_BUNDLE_INVALID')
  const bundle = value as Partial<RenewalBundle>
  if (bundle.schemaVersion !== 1 || bundle.role !== 'player' || typeof bundle.deviceId !== 'string' ||
      typeof bundle.createdAt !== 'string' || !Number.isFinite(Date.parse(bundle.createdAt)) ||
      typeof bundle.certificatePem !== 'string' || typeof bundle.certificateFingerprintSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(bundle.certificateFingerprintSha256) || typeof bundle.privateKeyPem !== 'string') {
    throw new Error('PAIRING_RENEWAL_BUNDLE_INVALID')
  }
  const certificate = validatePlayerCertificate(bundle.certificatePem, bundle.privateKeyPem, bundle.deviceId, new Date())
  if (certificate.fingerprintSha256 !== bundle.certificateFingerprintSha256) throw new Error('PAIRING_RENEWAL_BUNDLE_INVALID')
  return bundle as RemoteDeviceIdentity
}

/** Explicit, local stage-first annual certificate renewal. It never starts itself or grants remote authority. */
export class PairingRenewalCoordinator {
  constructor(private readonly store: PairingStore, private readonly identities: RemoteIdentityStore,
    private readonly now: () => Date = () => new Date()) {}

  async stage(currentIdentity: RemoteDeviceIdentity): Promise<RemoteDeviceIdentity> {
    const current = bundleFromIdentity(currentIdentity)
    const persisted = await this.store.read()
    if (persisted.playerAuthority?.phase !== 'active') throw new Error('PAIRING_RENEWAL_NOT_ACTIVE')
    if (persisted.playerAuthority.certificateFingerprintSha256 !== current.certificateFingerprintSha256) {
      throw new Error('PAIRING_RENEWAL_IDENTITY_MISMATCH')
    }
    if (persisted.renewal?.phase === 'promoting') return this.promoteCommitted()
    if (persisted.renewal?.phase === 'staged') return this.readBundle(persisted.renewal.encryptedNewBundle)
    if (persisted.renewal && persisted.renewal.phase !== 'promoted') throw new Error('PAIRING_RENEWAL_RESULT_UNCERTAIN')

    const generated = await generatePlayerCertificate(current.deviceId, this.now())
    const staged: RenewalBundle = { schemaVersion: 1, role: 'player', deviceId: current.deviceId,
      createdAt: this.now().toISOString(), certificatePem: generated.certificatePem,
      certificateFingerprintSha256: generated.fingerprintSha256, privateKeyPem: generated.privateKeyPem }
    if (staged.certificateFingerprintSha256 === current.certificateFingerprintSha256) {
      throw new Error('PAIRING_RENEWAL_CERTIFICATE_REUSED')
    }
    const encryptedOldBundle = await this.store.encryptSecret(Buffer.from(JSON.stringify(current), 'utf8'))
    const encryptedNewBundle = await this.store.encryptSecret(Buffer.from(JSON.stringify(staged), 'utf8'))
    await this.store.transact(state => {
      if (state.playerAuthority?.phase !== 'active' ||
          state.playerAuthority.certificateFingerprintSha256 !== current.certificateFingerprintSha256 ||
          (state.renewal && state.renewal.phase !== 'promoted')) throw new Error('PAIRING_REVISION_CONFLICT')
      state.renewal = { phase: 'staged', oldFingerprint: current.certificateFingerprintSha256,
        newFingerprint: staged.certificateFingerprintSha256, encryptedOldBundle, encryptedNewBundle,
        startedAt: this.now().toISOString() }
    })
    return identityFromBundle(staged)
  }

  async stagedIdentity(): Promise<RemoteDeviceIdentity> {
    const state = await this.store.read()
    if (!state.renewal || !['staged', 'promoting'].includes(state.renewal.phase)) {
      throw new Error('PAIRING_RENEWAL_NOT_STAGED')
    }
    return this.readBundle(state.renewal.encryptedNewBundle)
  }

  /** Must be called only after the bilateral pairing transaction durably changes to promoting. */
  async promoteCommitted(): Promise<RemoteDeviceIdentity> {
    const state = await this.store.read()
    if (state.renewal?.phase === 'promoted') return this.identities.loadOrCreatePlayerIdentity()
    if (state.renewal?.phase !== 'promoting') throw new Error('PAIRING_RENEWAL_NOT_COMMITTED')
    const identity = await this.readBundle(state.renewal.encryptedNewBundle)
    if (identity.certificateFingerprintSha256 !== state.renewal.newFingerprint) {
      throw new Error('PAIRING_RENEWAL_FINGERPRINT_MISMATCH')
    }
    const confirmed = await this.identities.replacePlayerIdentity(identity)
    await this.store.transact(candidate => {
      if (candidate.renewal?.phase !== 'promoting' ||
          candidate.renewal.newFingerprint !== confirmed.certificateFingerprintSha256 ||
          !candidate.playerAuthority || !['active', 'revoked'].includes(candidate.playerAuthority.phase) ||
          candidate.playerAuthority.certificateFingerprintSha256 !== confirmed.certificateFingerprintSha256) {
        throw new Error('PAIRING_RENEWAL_RESULT_UNCERTAIN')
      }
      candidate.renewal = { ...candidate.renewal, phase: 'promoted', encryptedOldBundle: '', encryptedNewBundle: '' }
    })
    return confirmed
  }

  /** A stage with no committed pairing is discarded only when the old identity still owns authority. */
  async discardUncommitted(): Promise<void> {
    await this.store.transact(state => {
      const renewal = state.renewal
      if (!renewal || renewal.phase === 'promoted') return
      if (renewal.phase !== 'staged' || state.playerAuthority?.phase !== 'active' ||
          state.playerAuthority.certificateFingerprintSha256 !== renewal.oldFingerprint ||
          state.journals.some(item => item.role === 'player' && ['bound', 'committed', 'uncertain'].includes(item.phase))) {
        throw new Error('PAIRING_RENEWAL_RESULT_UNCERTAIN')
      }
      state.renewal = null
    })
  }

  async recoverBeforeListener(): Promise<void> {
    const state: PairingStoreState = await this.store.read()
    if (state.renewal?.phase === 'promoting') await this.promoteCommitted()
    if (state.renewal?.phase === 'revoked') throw new Error('PAIRING_RENEWAL_REVOKED')
  }

  private async readBundle(encrypted: string): Promise<RemoteDeviceIdentity> {
    const bytes = await this.store.decryptSecret(encrypted)
    try { return identityFromBundle(JSON.parse(bytes.toString('utf8'))) }
    finally { bytes.fill(0) }
  }
}
