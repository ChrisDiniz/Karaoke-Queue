// Regression reproducer for G4 re-audit A4.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { MainRemoteRuntime } = require('../build/src/main-remote-runtime')
const { RemoteControlIntentStore } = require('../build/src/remote-control-intent')

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'g4-reaudit-intent-race-'))
  // No crypto or network calls are substituted: this scenario exercises Main intent ordering
  // and real SQLite. The barrier represents a listener shutdown still in progress.
  const runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory, safeStorage: {} })
  const store = new RemoteControlIntentStore(directory)
  let release
  const barrier = new Promise(resolve => { release = resolve })
  let stops = 0
  runtime.stopPlayer = () => ++stops === 1 ? barrier : Promise.resolve()
  try {
    const olderEnable = runtime.setRemoteControlIntent('enabled').then(() => null, error => error)
    await runtime.setRemoteControlIntent('offline')
    assert.equal((await store.read()).intent, 'offline', 'newer offline is confirmed durably')
    release()
    assert.match(olderEnable && (await olderEnable).message,
      /REMOTE_PLAYER_START_FENCED|REMOTE_CONTROL_INTENT_TRANSITION_FENCED/)
    const afterRestart = await new RemoteControlIntentStore(directory).read()
    assert.equal(afterRestart.intent, 'offline', 'the older enable is fenced before durable admission')
    const restarted = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory, safeStorage: {} })
    try {
      await assert.rejects(restarted.startPlayer({ interfaceAddress: '127.0.0.1', displayName: 'A4', port: 1,
        authorization: {} }), /REMOTE_PLAYER_EXPLICITLY_OFFLINE/)
    } finally { await restarted.close() }
    console.log('A4 FIXED: superseded enable cannot overwrite offline; a new Main runtime remains offline', afterRestart)
  } finally {
    release()
    await runtime.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
