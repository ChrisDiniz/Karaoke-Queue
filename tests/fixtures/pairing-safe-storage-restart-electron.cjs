'use strict'

const { app, safeStorage } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

app.whenReady().then(async () => {
  const directory = process.env.KQ_PAIRING_SAFE_STORAGE_TEST_DIR
  const mode = process.env.KQ_PAIRING_SAFE_STORAGE_TEST_MODE
  if (!directory || !path.isAbsolute(directory) || !['write', 'read'].includes(mode)) {
    throw new Error('PAIRING_SAFE_STORAGE_TEST_ARGUMENTS_INVALID')
  }
  const { ElectronSafeStorageSecretProtector } = require('../../build/src/remote-secret-protector.js')
  const { PairingStore } = require('../../build/src/pairing-store.js')
  const { encodeBase64Url, sha256 } = require('../../build/src/pairing-crypto.js')
  const protector = new ElectronSafeStorageSecretProtector(safeStorage, process.platform)
  await protector.assertAvailable()
  const store = new PairingStore(directory, protector)
  if (mode === 'write') {
    const token = crypto.randomBytes(32)
    const recoveryRoot = crypto.randomBytes(32)
    const tokenHash = encodeBase64Url(sha256(token))
    await store.transact(async state => {
      state.authorityRevision = 3
      state.playerAuthority = {
        controllerId: '11111111-1111-4111-8111-111111111111', credentialGeneration: 1,
        authorityRevision: 3, certificateFingerprintSha256: 'a'.repeat(64), tokenHash,
        encryptedToken: await store.encryptSecret(token), encryptedRecoveryRoot: await store.encryptSecret(recoveryRoot),
        pairingId: encodeBase64Url(crypto.randomBytes(32)), phase: 'active', scopes: ['transport:control']
      }
    })
    const bytes = await fs.readFile(path.join(directory, 'remote-authorization.json'), 'utf8')
    if (bytes.includes(token.toString('base64url')) || bytes.includes(recoveryRoot.toString('base64url'))) {
      throw new Error('PAIRING_SECRET_PERSISTED_IN_CLEAR')
    }
    process.stdout.write('KQ_PAIRING_SAFE_STORAGE_RESULT=' + JSON.stringify({ mode, tokenHash, encryptedAtRest: true }) + '\n')
    token.fill(0)
    recoveryRoot.fill(0)
  } else {
    const expectedTokenHash = process.env.KQ_PAIRING_SAFE_STORAGE_EXPECTED_HASH
    const state = await store.read()
    if (state.playerAuthority?.phase !== 'active' || state.playerAuthority.tokenHash !== expectedTokenHash) {
      throw new Error('PAIRING_AUTHORITY_NOT_PERSISTED')
    }
    const token = await store.decryptSecret(state.playerAuthority.encryptedToken)
    const recoveryRoot = await store.decryptSecret(state.playerAuthority.encryptedRecoveryRoot)
    const authenticated = encodeBase64Url(sha256(token)) === expectedTokenHash && recoveryRoot.length === 32
    token.fill(0)
    recoveryRoot.fill(0)
    if (!authenticated) throw new Error('PAIRING_CREDENTIAL_RECOVERY_FAILED')
    process.stdout.write('KQ_PAIRING_SAFE_STORAGE_RESULT=' + JSON.stringify({ mode, recovered: true }) + '\n')
  }
  await app.quit()
}).catch(error => {
  process.stderr.write('KQ_PAIRING_SAFE_STORAGE_ERROR=' + (error instanceof Error ? error.message : 'UNKNOWN') + '\n')
  app.exit(1)
})
