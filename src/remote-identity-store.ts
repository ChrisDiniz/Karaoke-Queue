import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { RemoteDeviceIdentity, RemoteDeviceRole } from './remote-contracts'
import type { SecretProtector } from './remote-secret-protector'
import { generatePlayerCertificate, validatePlayerCertificate } from './remote-tls'

const MAX_IDENTITY_FILE_BYTES = 64 * 1024

interface StoredPlayerIdentity {
  schemaVersion: 1
  role: 'player'
  deviceId: string
  createdAt: string
  certificatePem: string
  certificateFingerprintSha256: string
  encryptedPrivateKey: string
}

interface StoredControllerIdentity {
  schemaVersion: 1
  role: 'controller'
  deviceId: string
  createdAt: string
}

type StoredIdentity = StoredPlayerIdentity | StoredControllerIdentity

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
}

function validateStored(value: unknown, role: RemoteDeviceRole): StoredIdentity {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || value.role !== role ||
      typeof value.deviceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.deviceId) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('REMOTE_IDENTITY_FILE_INVALID')
  }
  const keys = Object.keys(value).sort().join(',')
  if (role === 'controller') {
    if (keys !== 'createdAt,deviceId,role,schemaVersion') throw new Error('REMOTE_IDENTITY_FILE_INVALID')
    return value as unknown as StoredControllerIdentity
  }
  if (keys !== 'certificateFingerprintSha256,certificatePem,createdAt,deviceId,encryptedPrivateKey,role,schemaVersion') {
    throw new Error('REMOTE_IDENTITY_FILE_INVALID')
  }
  if (typeof value.certificatePem !== 'string' || value.certificatePem.length > 32 * 1024 ||
      typeof value.certificateFingerprintSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.certificateFingerprintSha256) ||
      typeof value.encryptedPrivateKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.encryptedPrivateKey) ||
      value.encryptedPrivateKey.length > 32 * 1024) throw new Error('REMOTE_IDENTITY_FILE_INVALID')
  return value as unknown as StoredPlayerIdentity
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(content, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryPath, filePath)
    if (process.platform !== 'win32') {
      await fs.chmod(filePath, 0o600)
      const directoryHandle = await fs.open(directory, 'r')
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    }
  } catch (error) {
    try { await handle?.close() } catch { /* preserve original filesystem error */ }
    try { await fs.unlink(temporaryPath) } catch { /* absent or already renamed */ }
    throw error
  }
}

export class RemoteIdentityStore {
  private readonly inFlight = new Map<RemoteDeviceRole, Promise<RemoteDeviceIdentity>>()

  constructor(
    private readonly userDataDirectory: string,
    private readonly secretProtector: SecretProtector,
    private readonly now: () => Date = () => new Date()
  ) {}

  loadOrCreatePlayerIdentity(): Promise<RemoteDeviceIdentity> {
    return this.coalesce('player', () => this.loadOrCreatePlayer())
  }

  loadOrCreateControllerIdentity(): Promise<RemoteDeviceIdentity> {
    return this.coalesce('controller', () => this.loadOrCreateController())
  }

  /** Reads the retained identity for local renewal recovery; callers must never expose it over TLS. */
  async loadPlayerIdentityForRenewal(): Promise<RemoteDeviceIdentity> {
    await this.secretProtector.assertAvailable()
    const existing = await this.read('player') as StoredPlayerIdentity | undefined
    if (!existing) throw new Error('REMOTE_PLAYER_IDENTITY_MISSING')
    const decrypted = await this.secretProtector.decrypt(Buffer.from(existing.encryptedPrivateKey, 'base64'))
    const certificate = validatePlayerCertificate(existing.certificatePem, decrypted.plaintext,
      existing.deviceId, this.now(), true)
    if (certificate.fingerprintSha256 !== existing.certificateFingerprintSha256) {
      throw new Error('REMOTE_IDENTITY_FINGERPRINT_MISMATCH')
    }
    if (decrypted.shouldReEncrypt) {
      const updated = { ...existing, encryptedPrivateKey: Buffer.from(decrypted.ciphertext).toString('base64') }
      await writeAtomically(this.identityPath('player'), `${JSON.stringify(updated)}\n`)
    }
    return { schemaVersion: 1, role: 'player', deviceId: existing.deviceId, createdAt: existing.createdAt,
      certificatePem: existing.certificatePem, certificateFingerprintSha256: certificate.fingerprintSha256,
      privateKeyPem: decrypted.plaintext }
  }

  /** Atomically promotes a locally staged, still-valid certificate bundle and confirms readback. */
  async replacePlayerIdentity(identity: RemoteDeviceIdentity): Promise<RemoteDeviceIdentity> {
    if (identity.role !== 'player' || !identity.privateKeyPem || !identity.certificatePem ||
        !identity.certificateFingerprintSha256) throw new Error('REMOTE_PLAYER_IDENTITY_INVALID')
    const inFlight = this.inFlight.get('player')
    if (inFlight) await inFlight.catch(() => undefined)
    await this.secretProtector.assertAvailable()
    const existing = await this.read('player') as StoredPlayerIdentity | undefined
    if (!existing || existing.deviceId !== identity.deviceId) throw new Error('REMOTE_IDENTITY_ID_MISMATCH')
    const certificate = validatePlayerCertificate(identity.certificatePem, identity.privateKeyPem,
      identity.deviceId, this.now())
    if (certificate.fingerprintSha256 !== identity.certificateFingerprintSha256) {
      throw new Error('REMOTE_IDENTITY_FINGERPRINT_MISMATCH')
    }
    const encryptedPrivateKey = await this.secretProtector.encrypt(identity.privateKeyPem)
    const candidate: StoredPlayerIdentity = {
      schemaVersion: 1, role: 'player', deviceId: identity.deviceId,
      createdAt: identity.createdAt, certificatePem: identity.certificatePem,
      certificateFingerprintSha256: certificate.fingerprintSha256,
      encryptedPrivateKey: Buffer.from(encryptedPrivateKey).toString('base64')
    }
    const serialized = `${JSON.stringify(candidate)}\n`
    await writeAtomically(this.identityPath('player'), serialized)
    const confirmedBytes = await fs.readFile(this.identityPath('player'), 'utf8')
    if (confirmedBytes !== serialized) throw new Error('REMOTE_IDENTITY_PROMOTION_UNCERTAIN')
    const confirmed = await this.loadOrCreatePlayer()
    if (confirmed.certificateFingerprintSha256 !== certificate.fingerprintSha256 ||
        confirmed.deviceId !== identity.deviceId) throw new Error('REMOTE_IDENTITY_PROMOTION_UNCERTAIN')
    return confirmed
  }

  private coalesce(role: RemoteDeviceRole, operation: () => Promise<RemoteDeviceIdentity>): Promise<RemoteDeviceIdentity> {
    const current = this.inFlight.get(role)
    if (current) return current
    const pending = operation().finally(() => {
      if (this.inFlight.get(role) === pending) this.inFlight.delete(role)
    })
    this.inFlight.set(role, pending)
    return pending
  }

  private identityPath(role: RemoteDeviceRole): string {
    return path.join(this.userDataDirectory, `remote-${role}-identity.json`)
  }

  private async read(role: RemoteDeviceRole): Promise<StoredIdentity | undefined> {
    let bytes: Buffer
    try {
      const filePath = this.identityPath(role)
      const metadata = await fs.lstat(filePath)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_IDENTITY_FILE_BYTES) {
        throw new Error('REMOTE_IDENTITY_FILE_INVALID')
      }
      bytes = await fs.readFile(filePath)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      if (error instanceof Error && error.message === 'REMOTE_IDENTITY_FILE_INVALID') throw error
      throw new Error('REMOTE_IDENTITY_READ_FAILED', { cause: error })
    }
    if (bytes.byteLength > MAX_IDENTITY_FILE_BYTES) throw new Error('REMOTE_IDENTITY_FILE_TOO_LARGE')
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch (error) { throw new Error('REMOTE_IDENTITY_FILE_INVALID', { cause: error }) }
    return validateStored(parsed, role)
  }

  private async loadOrCreateController(): Promise<RemoteDeviceIdentity> {
    const filePath = this.identityPath('controller')
    const existing = await this.read('controller')
    if (existing) return {
      schemaVersion: 1, role: 'controller', deviceId: existing.deviceId, createdAt: existing.createdAt
    }
    const candidate: StoredControllerIdentity = {
      schemaVersion: 1, role: 'controller', deviceId: randomUUID(), createdAt: this.now().toISOString()
    }
    await writeAtomically(filePath, `${JSON.stringify(candidate)}\n`)
    return { ...candidate }
  }

  private async loadOrCreatePlayer(): Promise<RemoteDeviceIdentity> {
    await this.secretProtector.assertAvailable()
    const filePath = this.identityPath('player')
    const existing = await this.read('player') as StoredPlayerIdentity | undefined
    if (existing) {
      const decrypted = await this.secretProtector.decrypt(Buffer.from(existing.encryptedPrivateKey, 'base64'))
      const certificate = validatePlayerCertificate(existing.certificatePem, decrypted.plaintext, existing.deviceId, this.now())
      if (certificate.fingerprintSha256 !== existing.certificateFingerprintSha256) {
        throw new Error('REMOTE_IDENTITY_FINGERPRINT_MISMATCH')
      }
      if (decrypted.shouldReEncrypt) {
        const updated: StoredPlayerIdentity = {
          ...existing,
          encryptedPrivateKey: Buffer.from(decrypted.ciphertext).toString('base64')
        }
        await writeAtomically(filePath, `${JSON.stringify(updated)}\n`)
      }
      return {
        schemaVersion: 1, role: 'player', deviceId: existing.deviceId,
        createdAt: existing.createdAt, certificatePem: existing.certificatePem,
        certificateFingerprintSha256: certificate.fingerprintSha256,
        privateKeyPem: decrypted.plaintext
      }
    }

    const deviceId = randomUUID()
    const bundle = await generatePlayerCertificate(deviceId, this.now())
    const encryptedPrivateKey = await this.secretProtector.encrypt(bundle.privateKeyPem)
    const candidate: StoredPlayerIdentity = {
      schemaVersion: 1, role: 'player', deviceId, createdAt: this.now().toISOString(),
      certificatePem: bundle.certificatePem,
      certificateFingerprintSha256: bundle.fingerprintSha256,
      encryptedPrivateKey: Buffer.from(encryptedPrivateKey).toString('base64')
    }
    await writeAtomically(filePath, `${JSON.stringify(candidate)}\n`)
    return {
      schemaVersion: 1, role: 'player', deviceId, createdAt: candidate.createdAt,
      certificatePem: bundle.certificatePem,
      certificateFingerprintSha256: bundle.fingerprintSha256,
      privateKeyPem: bundle.privateKeyPem
    }
  }
}
