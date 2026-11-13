'use strict'

const { createKaraokeDatabase } = require('../build/database.js')
const { MainRemoteRuntime } = require('../build/src/main-remote-runtime.js')

const profile = process.argv[2]
const address = process.argv[3]
let database
let runtime
let closeTask
let latestRemoteState = null

function testSafeStorage() {
  return {
    getSelectedStorageBackend() { return 'gnome_libsecret' },
    isEncryptionAvailable() { return true },
    async isAsyncEncryptionAvailable() { return true },
    encryptString(value) { return Buffer.from(`test-protected:${value}`) },
    async encryptStringAsync(value) { return Buffer.from(`test-protected:${value}`) },
    decryptString(value) {
      const text = Buffer.from(value).toString('utf8')
      if (!text.startsWith('test-protected:')) throw new Error('TEST_SAFE_STORAGE_INVALID')
      return text.slice('test-protected:'.length)
    },
    async decryptStringAsync(value) {
      const text = Buffer.from(value).toString('utf8')
      if (!text.startsWith('test-protected:')) throw new Error('TEST_SAFE_STORAGE_INVALID')
      return { result: text.slice('test-protected:'.length), shouldReEncrypt: false }
    }
  }
}

async function close() {
  if (closeTask) return closeTask
  closeTask = (async () => {
    await runtime?.close()
    database?.close()
  })()
  return closeTask
}

process.on('message', message => {
  if (message?.type === 'get-remote-state') {
    process.send({ type: 'remote-state-snapshot', id: message.id, state: latestRemoteState })
    return
  }
  if (message?.type !== 'close') return
  void close().then(() => {
    process.send({ type: 'closed', id: message.id })
    process.disconnect()
  }, error => {
    process.send({ type: 'failure', id: message.id, code: error?.message ?? 'MANAGEMENT_CLOSE_FAILED' })
    process.exitCode = 1
  })
})

async function main() {
  database = createKaraokeDatabase(profile)
  runtime = new MainRemoteRuntime({ mode: 'controller', userDataDirectory: profile, safeStorage: testSafeStorage(),
    logger: {
      info(event, details) {
        if (event === 'REMOTE_RECONNECTION_STATE') {
          latestRemoteState = details
          process.send({ type: 'remote-state', state: details?.state, connectionId: details?.connectionId,
            reason: details?.reason, details })
          if (details?.state === 'synchronized') process.send({ type: 'synchronized', connectionId: details.connectionId, details })
          if (details?.state === 'backoff') process.send({ type: 'backoff', reason: details.reason, details })
        }
      },
      warn(event, details) { process.send({ type: 'warning', event, details }) },
      error(event, details) { process.send({ type: 'failure', code: details?.code ?? event }) }
    } })
  await runtime.resumeManagementReconnection(database, [address])
  process.send({ type: 'started' })
}

main().catch(error => {
  process.stderr.write('PAIRING_MANAGEMENT_FIXTURE_FATAL=' + (error?.stack ?? error?.message ?? 'UNKNOWN') + '\n')
  process.send({ type: 'fatal', code: error?.message ?? 'UNKNOWN' })
  process.exitCode = 1
})
