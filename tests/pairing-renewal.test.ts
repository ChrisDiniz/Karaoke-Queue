import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PairingAuthorizationAdapter } from '../src/pairing-authorization'
import { PairingStore } from '../src/pairing-store'
import { PairingRenewalCoordinator } from '../src/pairing-renewal'
import { RemoteIdentityStore } from '../src/remote-identity-store'
import type { SecretProtector } from '../src/remote-secret-protector'
import { encodeBase64Url, sha256 } from '../src/pairing-crypto'
import { generatePlayerCertificate } from '../src/remote-tls'

class TestProtector implements SecretProtector {
  async assertAvailable(): Promise<void> {}
  async encrypt(value: string): Promise<Uint8Array> { return Buffer.from(`test-encrypted:${value}`) }
  async decrypt(value: Uint8Array) {
    const text = Buffer.from(value).toString('utf8')
    if (!text.startsWith('test-encrypted:')) throw new Error('TEST_SECRET_INVALID')
    return { plaintext: text.slice('test-encrypted:'.length), ciphertext: value, shouldReEncrypt: false }
  }
}

test('stage-first certificate renewal preserves old identity until commit and recovers after promotion journal failure', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kq-pairing-renewal-'))
  const protector = new TestProtector()
  let failNextPairingWrite = false
  const writer = async (filePath: string, content: string): Promise<void> => {
    if (failNextPairingWrite) {
      failNextPairingWrite = false
      throw new Error('INJECTED_RENEWAL_JOURNAL_WRITE_FAILURE')
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf8')
  }
  try {
    const playerId = '22222222-2222-4222-8222-222222222222'
    const controllerId = '11111111-1111-4111-8111-111111111111'
    const expiredBundle = await generatePlayerCertificate(playerId, new Date(Date.now() - 400 * 24 * 60 * 60 * 1000))
    const encryptedPrivateKey = await protector.encrypt(expiredBundle.privateKeyPem)
    const identityFile = path.join(directory, 'remote-player-identity.json')
    await fs.writeFile(identityFile, `${JSON.stringify({ schemaVersion: 1, role: 'player', deviceId: playerId,
      createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      certificatePem: expiredBundle.certificatePem, certificateFingerprintSha256: expiredBundle.fingerprintSha256,
      encryptedPrivateKey: Buffer.from(encryptedPrivateKey).toString('base64') })}\n`)

    const identities = new RemoteIdentityStore(directory, protector)
    const retained = await identities.loadPlayerIdentityForRenewal()
    assert.equal(retained.certificateFingerprintSha256, expiredBundle.fingerprintSha256)
    await assert.rejects(identities.loadOrCreatePlayerIdentity(), /REMOTE_CERTIFICATE_EXPIRED_OR_INVALID/)
    const store = new PairingStore(directory, protector, undefined, writer)
    const oldToken = Buffer.alloc(32, 11)
    const oldRoot = Buffer.alloc(32, 22)
    const oldPairingId = encodeBase64Url(Buffer.alloc(32, 33))
    await store.transact(async state => {
      state.authorityRevision = 3
      state.playerAuthority = { controllerId, credentialGeneration: 1, authorityRevision: 3,
        certificateFingerprintSha256: expiredBundle.fingerprintSha256, tokenHash: encodeBase64Url(sha256(oldToken)),
        encryptedToken: await store.encryptSecret(oldToken), encryptedRecoveryRoot: await store.encryptSecret(oldRoot),
        pairingId: oldPairingId, phase: 'active', scopes: ['transport:control'] }
    })
    const renewal = new PairingRenewalCoordinator(store, identities)
    const staged = await renewal.stage(retained)
    assert.notEqual(staged.certificateFingerprintSha256, retained.certificateFingerprintSha256)
    assert.equal((await store.read()).renewal?.phase, 'staged')
    assert.equal(JSON.parse(await fs.readFile(identityFile, 'utf8')).certificateFingerprintSha256,
      retained.certificateFingerprintSha256, 'staging leaves the current identity file untouched')
    await renewal.discardUncommitted()
    assert.equal((await store.read()).renewal, null)

    const stagedAgain = await renewal.stage(retained)
    const newToken = Buffer.alloc(32, 44)
    const newRoot = Buffer.alloc(32, 55)
    await store.transact(async state => {
      const current = state.playerAuthority!
      state.authorityRevision = 6
      current.credentialGeneration = 2
      current.authorityRevision = 6
      current.certificateFingerprintSha256 = stagedAgain.certificateFingerprintSha256!
      current.tokenHash = encodeBase64Url(sha256(newToken))
      current.encryptedToken = await store.encryptSecret(newToken)
      current.encryptedRecoveryRoot = await store.encryptSecret(newRoot)
      current.pairingId = encodeBase64Url(Buffer.alloc(32, 66))
      state.renewal!.phase = 'promoting'
    })
    failNextPairingWrite = true
    await assert.rejects(renewal.promoteCommitted(), /INJECTED_RENEWAL_JOURNAL_WRITE_FAILURE/)
    assert.equal(JSON.parse(await fs.readFile(identityFile, 'utf8')).certificateFingerprintSha256,
      stagedAgain.certificateFingerprintSha256, 'the prepared identity is promoted before marking completion')
    assert.equal((await store.read()).renewal?.phase, 'promoting', 'uncertain completion remains recoverable')

    await new PairingAuthorizationAdapter(store).revokeLocally()
    assert.equal((await store.read()).playerAuthority?.phase, 'revoked')
    await renewal.recoverBeforeListener()
    const recovered = await identities.loadOrCreatePlayerIdentity()
    assert.equal(recovered.certificateFingerprintSha256, stagedAgain.certificateFingerprintSha256)
    const durable = await store.read()
    assert.equal(durable.renewal?.phase, 'promoted')
    assert.equal(durable.playerAuthority?.phase, 'revoked', 'recovery never reauthorizes a locally revoked promotion')
    assert.equal(durable.renewal?.encryptedOldBundle, '')
    assert.equal(durable.renewal?.encryptedNewBundle, '')
    assert.equal(durable.playerAuthority?.tokenHash, encodeBase64Url(sha256(newToken)))
    oldToken.fill(0); oldRoot.fill(0); newToken.fill(0); newRoot.fill(0)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
