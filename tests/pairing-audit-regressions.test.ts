import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PairingStore } from '../src/pairing-store'
import { PairingAuthorizationAdapter, tokenHash } from '../src/pairing-authorization'
const id = (n: number) => Buffer.alloc(32, n).toString('base64url')
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kq-audit-'))
  let available = true
  const protector = {
    async assertAvailable() { if (!available) throw new Error('UNAVAILABLE') },
    async encrypt(s: string) { return Buffer.from(s) },
    async decrypt(b: Uint8Array) { return { plaintext: Buffer.from(b).toString(), ciphertext: b, shouldReEncrypt: false } }
  }
  const store = new PairingStore(dir, protector)
  const token = Buffer.alloc(32, 8)
  await store.transact(async s => { s.playerAuthority = {
    controllerId: '11111111-1111-4111-8111-111111111111', credentialGeneration: 1, authorityRevision: 1,
    certificateFingerprintSha256: 'a'.repeat(64), tokenHash: tokenHash(token),
    encryptedToken: await store.encryptSecret(token), encryptedRecoveryRoot: await store.encryptSecret(Buffer.alloc(32, 9)),
    pairingId: id(10), phase: 'active', scopes: ['transport:control']
  }; s.authorityRevision = 1 })
  return { dir, store, protector, token, unavailable() { available = false }, async cleanup() { await fs.rm(dir, { recursive: true, force: true }) } }
}
test('authorization and revalidation fail closed if secure storage becomes unavailable', async () => {
  const f = await fixture()
  try {
    const adapter = new PairingAuthorizationAdapter(f.store), signal = new AbortController().signal
    const peer = await adapter.authorizeBearer(f.token.toString('base64url'), '', signal)
    assert.ok(peer)
    f.unavailable()
    assert.equal(await adapter.authorizeBearer(f.token.toString('base64url'), '', signal), null)
    assert.equal(await adapter.isCurrent(peer, '', signal), false)
  } finally { await f.cleanup() }
})
test('a write before first admission after restart must not erase persistent cooldown', async () => {
  const f = await fixture()
  try {
    const clock = (boot: string) => ({ bootId: () => boot, monotonicNow: () => 1, utcNow: () => new Date() })
    const first = new PairingStore(f.dir, f.protector, clock('first'))
    await first.reserveAttempt(id(1), id(2))
    const restarted = new PairingStore(f.dir, f.protector, clock('second'))
    await restarted.transact(() => {})
    await assert.rejects(restarted.reserveAttempt(id(3), id(4)), /PAIRING_LOCKED/)
  } finally { await f.cleanup() }
})
test('local revocation during staged renewal persists across adapter restart', async () => {
  const f = await fixture()
  try {
    await f.store.transact(s => { s.renewal = { phase: 'staged', oldFingerprint: 'a'.repeat(64), newFingerprint: 'b'.repeat(64),
      encryptedOldBundle: 'YQ==', encryptedNewBundle: 'Yg==', startedAt: new Date().toISOString() } })
    await new PairingAuthorizationAdapter(f.store).revokeLocally()
    assert.equal((await f.store.read()).playerAuthority?.phase, 'revoked')
    assert.equal(await new PairingAuthorizationAdapter(f.store).authorizeBearer(f.token.toString('base64url'), '', new AbortController().signal), null)
  } finally { await f.cleanup() }
})
