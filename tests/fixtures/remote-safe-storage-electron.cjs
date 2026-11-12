'use strict'

const { app, safeStorage } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

app.whenReady().then(async () => {
  const directory = process.env.KQ_REMOTE_SAFE_STORAGE_TEST_DIR
  if (!directory || !path.isAbsolute(directory)) throw new Error('REMOTE_TEST_DIRECTORY_REQUIRED')
  const { ElectronSafeStorageSecretProtector } = require('../../build/src/remote-secret-protector.js')
  const { RemoteIdentityStore } = require('../../build/src/remote-identity-store.js')
  const protector = new ElectronSafeStorageSecretProtector(safeStorage, process.platform)
  const asyncAvailable = await safeStorage.isAsyncEncryptionAvailable()
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'platform-default'
  const secureLinuxBackends = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']
  const syncAvailable = process.platform === 'linux' && secureLinuxBackends.includes(backend)
    ? safeStorage.isEncryptionAvailable() : false
  let remoteEnabled = false
  let persistedIdentity = false
  let privateKeyProtected = false

  try {
    await protector.assertAvailable()
    const store = new RemoteIdentityStore(directory, protector)
    const first = await store.loadOrCreatePlayerIdentity()
    const reloaded = await new RemoteIdentityStore(directory, protector).loadOrCreatePlayerIdentity()
    const record = JSON.parse(await fs.readFile(path.join(directory, 'remote-player-identity.json'), 'utf8'))
    remoteEnabled = true
    persistedIdentity = first.deviceId === reloaded.deviceId && first.certificateFingerprintSha256 === reloaded.certificateFingerprintSha256
    privateKeyProtected = typeof record.encryptedPrivateKey === 'string' &&
      typeof record.privateKeyPem === 'undefined' && !JSON.stringify(record).includes('-----BEGIN PRIVATE KEY-----')
  } catch (error) {
    if (!(error instanceof Error) || !['SECRET_STORAGE_UNAVAILABLE', 'SECRET_STORAGE_UNSUPPORTED'].includes(error.message)) throw error
    if (process.platform === 'win32') throw new Error('WINDOWS_SAFE_STORAGE_UNAVAILABLE')
  }

  const result = { platform: process.platform, asyncAvailable, syncAvailable, backend,
    remoteEnabled, persistedIdentity, privateKeyProtected }
  process.stdout.write('\nKQ_REMOTE_SAFE_STORAGE_RESULT=' + JSON.stringify(result) + '\n')
  await app.quit()
}).catch(error => {
  process.stderr.write('KQ_REMOTE_SAFE_STORAGE_ERROR=' + (error instanceof Error ? error.message : 'UNKNOWN') + '\n')
  app.exit(1)
})
