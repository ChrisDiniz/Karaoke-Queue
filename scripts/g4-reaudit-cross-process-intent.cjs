'use strict'
// Independent A4 regression: two Main owners sharing the same intent SQLite.
const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { MainRemoteRuntime } = require('../build/src/main-remote-runtime')
const { RemoteControlIntentStore } = require('../build/src/remote-control-intent')

if (process.argv[2] === '--older') {
  const runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: process.argv[3], safeStorage: {} })
  let release
  runtime.stopPlayer = () => new Promise(resolve => { release = resolve; process.send({ type: 'waiting' }) })
  process.once('message', () => release())
  runtime.setRemoteControlIntent('enabled').then(async () => {
    process.send({ type: 'enabled-confirmed' })
    runtime.stopPlayer = async () => {}
    await runtime.close()
    process.disconnect()
  }, async error => {
    process.send({ type: 'enabled-rejected', code: error instanceof Error ? error.message : 'UNKNOWN' })
    runtime.stopPlayer = async () => {}
    await runtime.close()
    process.disconnect()
  })
} else {
  ;(async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'g4-independent-cross-process-'))
    const runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory, safeStorage: {} })
    const child = fork(__filename, ['--older', directory], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('CHILD_EXIT_' + code)))
    })
    try {
      await new Promise(resolve => child.once('message', resolve))
      await runtime.setRemoteControlIntent('offline')
      assert.equal((await new RemoteControlIntentStore(directory).read()).intent, 'offline')
      child.send({ type: 'release' })
      const outcome = await new Promise(resolve => child.once('message', resolve))
      assert.equal(outcome.type, 'enabled-rejected')
      assert.equal(outcome.code, 'REMOTE_CONTROL_INTENT_REVISION_CONFLICT')
      await exited
      const reopened = await new RemoteControlIntentStore(directory).read()
      assert.deepEqual(reopened, { version: 1, intent: 'offline', revision: 1 })
      const restarted = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory, safeStorage: {} })
      try {
        await assert.rejects(restarted.startPlayer({ interfaceAddress: '127.0.0.1', displayName: 'A4 cross process', port: 1,
          authorization: {} }), /REMOTE_PLAYER_EXPLICITLY_OFFLINE/)
      } finally { await restarted.close() }
      console.log('A4 CROSS-PROCESS FIXED: obsolete Main rejected by SQLite revision CAS; offline remains durable', reopened)
    } finally {
      if (child.exitCode === null) { child.kill(); await exited.catch(() => undefined) }
      await runtime.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })().catch(error => { console.error(error); process.exitCode = 1 })
}
