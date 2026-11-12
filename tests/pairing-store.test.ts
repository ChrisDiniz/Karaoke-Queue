import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { SecretProtector } from '../src/remote-secret-protector'
import { PairingStore, type PairingStoreClock } from '../src/pairing-store'
import { encodeBase64Url } from '../src/pairing-crypto'

class TestProtector implements SecretProtector {
  async assertAvailable(): Promise<void> {}
  async encrypt(plaintext: string): Promise<Uint8Array> { return Buffer.from(`enc:${plaintext}`) }
  async decrypt(ciphertext: Uint8Array) {
    const text = Buffer.from(ciphertext).toString('utf8')
    if (!text.startsWith('enc:')) throw new Error('BAD_TEST_CIPHERTEXT')
    return { plaintext: text.slice(4), ciphertext, shouldReEncrypt: false }
  }
}

function id(seed: number): string { return encodeBase64Url(Buffer.alloc(32, seed)) }

function clock(boot: string, state: { mono: number }): PairingStoreClock {
  return { monotonicNow: () => state.mono, utcNow: () => new Date('2026-11-12T12:00:00.000Z'), bootId: () => boot }
}

test('pairing store atomically confirms mutations, CAS conflicts and encrypted secrets fail closed', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kq-pairing-store-'))
  try {
    const state = { mono: 10 }
    const store = new PairingStore(directory, new TestProtector(), clock('boot-a', state))
    const created = await store.transact(candidate => { candidate.authorityRevision = 1 })
    assert.equal(created.state.storeRevision, 1)
    await assert.rejects(store.transact(candidate => { candidate.authorityRevision = 2 }, 0), /PAIRING_REVISION_CONFLICT/)
    const secret = Buffer.alloc(32, 9)
    assert.deepEqual(await store.decryptSecret(await store.encryptSecret(secret)), secret)
    const onDisk = await fs.readFile(path.join(directory, 'remote-authorization.json'), 'utf8')
    assert(!onDisk.includes(encodeBase64Url(secret)))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('persistent budget allows five reservations globally, three per session, then expires after monotonic ten minutes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kq-pairing-budget-'))
  try {
    const time = { mono: 100 }
    const store = new PairingStore(directory, new TestProtector(), clock('boot-a', time))
    const sameSession = id(20)
    await store.reserveAttempt(sameSession, id(1))
    await store.reserveAttempt(sameSession, id(2))
    await store.reserveAttempt(sameSession, id(3))
    await assert.rejects(store.reserveAttempt(sameSession, id(4)), /PAIRING_LOCKED/)
    await store.completeAttempt(id(1), true)
    await store.reserveAttempt(id(21), id(5))
    await store.reserveAttempt(id(22), id(6))
    await store.reserveAttempt(id(23), id(7))
    await assert.rejects(store.reserveAttempt(id(24), id(8)), /PAIRING_LOCKED/)
    time.mono += 10 * 60 * 1000 + 1
    await store.reserveAttempt(id(24), id(8))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('restart imposes a conservative monotonic cooldown for surviving reservations', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kq-pairing-restart-'))
  try {
    const before = { mono: 500 }
    const firstBoot = new PairingStore(directory, new TestProtector(), clock('boot-before', before))
    await firstBoot.reserveAttempt(id(31), id(41))
    const after = { mono: 1 }
    const nextBoot = new PairingStore(directory, new TestProtector(), clock('boot-after', after))
    await assert.rejects(nextBoot.reserveAttempt(id(32), id(42)), /PAIRING_LOCKED/)
    after.mono += 10 * 60 * 1000 + 1
    await nextBoot.reserveAttempt(id(32), id(42))
    assert.equal((await nextBoot.read()).attempts.length, 1)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('disk write failure does not publish candidate authority state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kq-pairing-write-failure-'))
  try {
    const first = new PairingStore(directory, new TestProtector(), clock('boot-a', { mono: 1 }),
      async () => { throw new Error('INJECTED_WRITE_FAILURE') })
    await assert.rejects(first.transact(candidate => { candidate.authorityRevision = 5 }))
    const state = await first.read()
    assert.equal(state.authorityRevision, 0)
    assert.equal(state.storeRevision, 0)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
