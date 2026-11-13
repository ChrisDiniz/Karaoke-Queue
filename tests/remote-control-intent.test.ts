import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MainRemoteRuntime } from '../src/main-remote-runtime'
import { REMOTE_CONTROL_INTENT_DATABASE_FILENAME, RemoteControlIntentStore } from '../src/remote-control-intent'

function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kq-g4-remote-intent-'))
}

let nextChildRequest = 1
function intentProcess(directory: string): { child: ChildProcess; ready: Promise<void>; request(type: string, fields?: Record<string, unknown>): Promise<any> } {
  const child = fork(path.join(process.cwd(), 'scripts/remote-control-intent-process.cjs'), [directory], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (message: any) => {
      if (message?.type !== 'ready') return
      child.off('message', onMessage); resolve()
    }
    child.on('message', onMessage)
    child.once('error', reject)
    child.once('exit', code => { if (code !== 0) reject(new Error(`INTENT_PROCESS_EXIT_${code}`)) })
  })
  return { child, ready, request(type, fields = {}) {
    const id = `intent-${nextChildRequest++}`
    return new Promise((resolve, reject) => {
      const onMessage = (message: any) => {
        if (message?.id !== id) return
        child.off('message', onMessage)
        if (message.ok) resolve(message.value)
        else reject(new Error(String(message.code)))
      }
      child.on('message', onMessage)
      child.send({ id, type, ...fields }, error => {
        if (!error) return
        child.off('message', onMessage); reject(error)
      })
    })
  } }
}

function safeStorage() {
  return {
    getSelectedStorageBackend: () => 'gnome_libsecret',
    isEncryptionAvailable: () => true,
    isAsyncEncryptionAvailable: async () => true,
    encryptString: (value: string) => Buffer.from(`test-protected:${value}`),
    encryptStringAsync: async (value: string) => Buffer.from(`test-protected:${value}`),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('test-protected:')) throw new Error('TEST_SAFE_STORAGE_INVALID')
      return text.slice('test-protected:'.length)
    },
    decryptStringAsync: async (value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('test-protected:')) throw new Error('TEST_SAFE_STORAGE_INVALID')
      return { result: text.slice('test-protected:'.length), shouldReEncrypt: false }
    }
  }
}

async function availablePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function isListening(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

function noOpAdvertiser() {
  return { async start() {}, async update() {}, async stop() {} }
}

test('remote control intent defaults closed and compare-and-set serializes concurrent writers', async () => {
  const directory = await temporaryDirectory()
  const store = new RemoteControlIntentStore(directory)
  try {
    assert.deepEqual(await store.read(), { version: 1, intent: 'disabled', revision: 0 })
    const results = await Promise.allSettled([
      store.set('enabled', 0), store.set('offline', 0)
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    const selected = await store.read()
    assert.ok(selected.intent === 'enabled' || selected.intent === 'offline')
    assert.equal(selected.revision, 1)
    const database = new DatabaseSync(path.join(directory, REMOTE_CONTROL_INTENT_DATABASE_FILENAME))
    try {
      assert.equal((database.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
      assert.equal(Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 1)
      assert.equal(Number((database.prepare('PRAGMA application_id').get() as { application_id: number }).application_id), 0x4b514943)
      assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM remote_control_intent').get()?.count), 1)
    } finally { database.close() }
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('two Main processes coalesce first SQLite initialization and only one CAS writer wins', async () => {
  const directory = await temporaryDirectory()
  const first = intentProcess(directory), second = intentProcess(directory)
  try {
    await Promise.all([first.ready, second.ready])
    const initialized = await Promise.all([first.request('read'), second.request('read')])
    assert.deepEqual(initialized, [
      { version: 1, intent: 'disabled', revision: 0 },
      { version: 1, intent: 'disabled', revision: 0 }
    ])
    const writes = await Promise.allSettled([
      first.request('set', { intent: 'offline', expectedRevision: 0 }),
      second.request('set', { intent: 'enabled', expectedRevision: 0 })
    ])
    assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = writes.find(result => result.status === 'rejected')
    assert.equal(rejected?.status, 'rejected')
    assert.match(rejected.reason.message, /REMOTE_CONTROL_INTENT_REVISION_CONFLICT/)
    const current = await new RemoteControlIntentStore(directory).read()
    assert.equal(current.revision, 1)
    assert.ok(current.intent === 'offline' || current.intent === 'enabled')
  } finally {
    for (const process of [first, second]) {
      if (process.child.exitCode !== null) continue
      await process.request('close').catch(() => undefined)
      await new Promise<void>(resolve => process.child.once('exit', () => resolve()))
    }
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('legacy local intent is imported into SQLite without deleting the source evidence', async () => {
  const directory = await temporaryDirectory()
  const legacyPath = path.join(directory, 'remote-control-intent.json')
  const legacy = JSON.stringify({ version: 1, intent: 'offline', revision: 7 }) + '\n'
  await fs.writeFile(legacyPath, legacy, { mode: 0o600 })
  try {
    const store = new RemoteControlIntentStore(directory)
    assert.deepEqual(await store.read(), { version: 1, intent: 'offline', revision: 7 })
    assert.equal(await fs.readFile(legacyPath, 'utf8'), legacy, 'migration retains the previous durable record')
    assert.equal((await fs.stat(path.join(directory, REMOTE_CONTROL_INTENT_DATABASE_FILENAME))).isFile(), true)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('explicit Player offline survives runtime restart and fences the real WSS listener until an explicit enable', async () => {
  const directory = await temporaryDirectory()
  const port = await availablePort()
  const playerOptions = { interfaceAddress: '127.0.0.1', displayName: 'Player fixture', port }
  const first = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory,
    safeStorage: safeStorage(), createAdvertiser: noOpAdvertiser })
  try {
    await first.configurePlayerPairingPresentation({ approvedForProduction: true,
      async requestConsent() { return true }, async showTemporaryCode() {}, async closePairing() {} })
    await first.startPlayer({ ...playerOptions, authorization: first.createPlayerPairingAuthorization() })
    assert.equal(await isListening(port), true, 'Player start resolves only after its actual TLS/WSS listener is live')
    await first.setRemoteControlIntent('offline')
    assert.equal(await isListening(port), false, 'the persisted offline transition closes the runtime listener')
  } finally { await first.close() }

  const restarted = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory,
    safeStorage: safeStorage(), createAdvertiser: noOpAdvertiser })
  try {
    await assert.rejects(restarted.startPlayer({ ...playerOptions,
      authorization: restarted.createPlayerPairingAuthorization() }), /REMOTE_PLAYER_EXPLICITLY_OFFLINE/)
    assert.deepEqual(await new RemoteControlIntentStore(directory).read(), { version: 1, intent: 'offline', revision: 1 })
    assert.equal(await isListening(port), false, 'restart cannot reopen a listener behind the saved local offline intent')

    await restarted.setRemoteControlIntent('enabled')
    await restarted.startPlayer({ ...playerOptions, authorization: restarted.createPlayerPairingAuthorization() })
    assert.equal(await isListening(port), true, 'only an explicit local enable makes the listener eligible again')
  } finally {
    await restarted.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('loss of the initialized offline database blocks Player Main startup and ignores stale legacy enabled', async () => {
  const directory = await temporaryDirectory()
  const port = await availablePort()
  const options = { interfaceAddress: '127.0.0.1', displayName: 'Player recovery fixture', port }
  const first = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory,
    safeStorage: safeStorage(), createAdvertiser: noOpAdvertiser })
  try {
    await first.startPlayer({ ...options, authorization: first.createPlayerPairingAuthorization() })
    await first.setRemoteControlIntent('offline')
  } finally { await first.close() }
  await fs.writeFile(path.join(directory, 'remote-control-intent.json'),
    JSON.stringify({ version: 1, intent: 'enabled', revision: 1 }))
  await fs.unlink(path.join(directory, REMOTE_CONTROL_INTENT_DATABASE_FILENAME))

  const restarted = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory,
    safeStorage: safeStorage(), createAdvertiser: noOpAdvertiser })
  try {
    await assert.rejects(restarted.startPlayer({ ...options,
      authorization: restarted.createPlayerPairingAuthorization() }), /REMOTE_PLAYER_INTENT_RECOVERY_REQUIRED/)
    assert.equal((await new RemoteControlIntentStore(directory).read()).intent, 'recovery_required')
    assert.equal(await isListening(port), false, 'the uncertain intent cannot authorize the Main WSS listener')

    await restarted.setRemoteControlIntent('enabled')
    await restarted.startPlayer({ ...options, authorization: restarted.createPlayerPairingAuthorization() })
    assert.equal(await isListening(port), true, 'a new local enabled choice explicitly recovers missing state')
  } finally {
    await restarted.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('existing identity evidence prevents legacy JSON from being treated as first-run migration', async () => {
  const directory = await temporaryDirectory()
  try {
    await fs.writeFile(path.join(directory, 'remote-player-identity.json'), '{}')
    await fs.writeFile(path.join(directory, 'remote-control-intent.json'),
      JSON.stringify({ version: 1, intent: 'enabled', revision: 12 }))
    assert.equal((await new RemoteControlIntentStore(directory).read()).intent, 'recovery_required')
    assert.equal(await fs.access(path.join(directory, REMOTE_CONTROL_INTENT_DATABASE_FILENAME)).then(() => true, () => false),
      false, 'uncertain recovery does not silently recreate a store')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('legacy enabled migration cannot supersede a later offline decision after database loss', async () => {
  const directory = await temporaryDirectory()
  try {
    await fs.writeFile(path.join(directory, 'remote-control-intent.json'),
      JSON.stringify({ version: 1, intent: 'enabled', revision: 2 }))
    const store = new RemoteControlIntentStore(directory)
    assert.equal((await store.read()).intent, 'enabled', 'legacy migration is allowed only without newer remote evidence')
    assert.equal((await store.set('offline', 2)).intent, 'offline')
    await fs.writeFile(path.join(directory, 'remote-player-identity.json'), '{}')
    await fs.unlink(path.join(directory, REMOTE_CONTROL_INTENT_DATABASE_FILENAME))
    assert.equal((await new RemoteControlIntentStore(directory).read()).intent, 'recovery_required')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('zero-byte crash residue and corrupt schema fail closed without consuming legacy intent', async () => {
  const directory = await temporaryDirectory()
  const databasePath = path.join(directory, REMOTE_CONTROL_INTENT_DATABASE_FILENAME)
  try {
    await fs.writeFile(path.join(directory, 'remote-control-intent.json'),
      JSON.stringify({ version: 1, intent: 'enabled', revision: 1 }))
    await fs.writeFile(databasePath, Buffer.alloc(0))
    await assert.rejects(new RemoteControlIntentStore(directory).read(), /REMOTE_CONTROL_INTENT_DATABASE_INVALID/)
    assert.equal(await fs.readFile(path.join(directory, 'remote-control-intent.json'), 'utf8'),
      JSON.stringify({ version: 1, intent: 'enabled', revision: 1 }))
    await fs.rm(databasePath)

    const database = new DatabaseSync(databasePath)
    try { database.exec('CREATE TABLE unrelated(value TEXT); PRAGMA application_id = 99; PRAGMA user_version = 1;') }
    finally { database.close() }
    await assert.rejects(new RemoteControlIntentStore(directory).read(), /REMOTE_CONTROL_INTENT_DATABASE_UNSUPPORTED/)
    assert.equal((await fs.stat(databasePath)).size > 0, true, 'invalid evidence remains intact')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('SQLite file corruption preserves evidence and never restores default eligibility', async () => {
  const directory = await temporaryDirectory()
  const pathToDatabase = path.join(directory, REMOTE_CONTROL_INTENT_DATABASE_FILENAME)
  try {
    const store = new RemoteControlIntentStore(directory)
    await store.read()
    const original = await fs.readFile(pathToDatabase)
    const corrupted = Buffer.from(original)
    corrupted[0] = 0
    await fs.writeFile(pathToDatabase, corrupted)
    await assert.rejects(store.read(), /REMOTE_CONTROL_INTENT_DATABASE_CORRUPT/)
    assert.equal((await fs.stat(pathToDatabase)).size > 0, true)
    await assert.rejects(store.set('enabled', 0), /REMOTE_CONTROL_INTENT_DATABASE_CORRUPT/,
      'an explicit normal mode change cannot silently replace corrupt durable evidence')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('fresh install bootstraps closed once; malformed legacy migration leaves no enabled store', async () => {
  const directory = await temporaryDirectory()
  try {
    const store = new RemoteControlIntentStore(directory)
    assert.deepEqual(await store.read(), { version: 1, intent: 'disabled', revision: 0 })
    await fs.rm(directory, { recursive: true, force: true })
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'remote-control-intent.json'), '{invalid')
    await assert.rejects(new RemoteControlIntentStore(directory).read(), /REMOTE_CONTROL_INTENT_INVALID/)
    assert.equal(await fs.access(path.join(directory, REMOTE_CONTROL_INTENT_DATABASE_FILENAME)).then(() => true, () => false),
      false, 'failed migration does not create a default-enabled or partially initialized store')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('failed explicit write rejects and does not report the desired offline state', async () => {
  const blocker = await temporaryDirectory()
  try {
    const parent = path.join(blocker, 'not-a-directory')
    await fs.writeFile(parent, 'x')
    const store = new RemoteControlIntentStore(path.join(parent, 'profile'))
    await assert.rejects(store.set('offline', 0))
    assert.equal(await fs.readFile(parent, 'utf8'), 'x')
  } finally { await fs.rm(blocker, { recursive: true, force: true }) }
})

test('write failure before SQLite commit rolls back; lost commit acknowledgement remains uncertain', async () => {
  const directory = await temporaryDirectory()
  try {
    const base = new RemoteControlIntentStore(directory)
    await base.read()
    const failedBeforeCommit = new RemoteControlIntentStore(directory, {
      beforeCommit() { throw new Error('TEST_WRITE_FAILED_BEFORE_COMMIT') }
    })
    await assert.rejects(failedBeforeCommit.set('offline', 0), /TEST_WRITE_FAILED_BEFORE_COMMIT/)
    assert.equal((await base.read()).intent, 'disabled', 'rollback leaves the previously confirmed intent unchanged')

    const lostAcknowledgement = new RemoteControlIntentStore(directory, {
      afterCommit() { throw new Error('TEST_WRITE_ACK_LOST') }
    })
    await assert.rejects(lostAcknowledgement.set('offline', 0), /TEST_WRITE_ACK_LOST/)
    assert.equal((await base.read()).intent, 'offline', 'readback after restart discovers the committed decision')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('truncated intent state cannot reopen Player listener; explicit local recovery is required', async () => {
  const directory = await temporaryDirectory()
  const port = await availablePort()
  const options = { interfaceAddress: '127.0.0.1', displayName: 'Player corruption fixture', port }
  const runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory,
    safeStorage: safeStorage(), createAdvertiser: noOpAdvertiser })
  try {
    await runtime.startPlayer({ ...options, authorization: runtime.createPlayerPairingAuthorization() })
    await runtime.setRemoteControlIntent('offline')
  } finally { await runtime.close() }
  await fs.truncate(path.join(directory, REMOTE_CONTROL_INTENT_DATABASE_FILENAME), 0)
  const restarted = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory,
    safeStorage: safeStorage(), createAdvertiser: noOpAdvertiser })
  try {
    await assert.rejects(restarted.startPlayer({ ...options,
      authorization: restarted.createPlayerPairingAuthorization() }), /REMOTE_CONTROL_INTENT_DATABASE_INVALID/)
    assert.equal(await isListening(port), false)
  } finally { await restarted.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('A4: a stale enable waiting for Player shutdown cannot overwrite a newer confirmed offline choice', async () => {
  const directory = await temporaryDirectory()
  const runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory, safeStorage: safeStorage() })
  const store = new RemoteControlIntentStore(directory)
  let release!: () => void, entered!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  let stops = 0
  ;(runtime as any).stopPlayer = async () => { if (++stops === 1) { entered(); await barrier } }
  try {
    const staleEnable = runtime.setRemoteControlIntent('enabled')
    await reached
    await runtime.setRemoteControlIntent('offline')
    assert.equal((await store.read()).intent, 'offline')
    release()
    await assert.rejects(staleEnable, /REMOTE_PLAYER_START_FENCED/)
    assert.equal((await new RemoteControlIntentStore(directory).read()).intent, 'offline',
      'reopened SQLite retains the later local decision')
    const verifier = intentProcess(directory)
    try {
      await verifier.ready
      assert.equal((await verifier.request('read')).intent, 'offline',
        'an independent Main process observes the confirmed offline decision')
      await verifier.request('close')
      await new Promise<void>(resolve => verifier.child.once('exit', () => resolve()))
    } finally {
      if (verifier.child.exitCode === null) {
        await verifier.request('close').catch(() => undefined)
        await new Promise<void>(resolve => verifier.child.once('exit', () => resolve()))
      }
    }
    await assert.rejects(runtime.startPlayer({ interfaceAddress: '127.0.0.1', displayName: 'A4', port: 1,
      authorization: { async authorizeBearer() { return null }, async isCurrent() { return false } } }),
    /REMOTE_PLAYER_EXPLICITLY_OFFLINE/)
  } finally { release(); await runtime.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('A4: two overlapping offline choices retain the latest durable decision', async () => {
  const directory = await temporaryDirectory()
  const runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory, safeStorage: safeStorage() })
  try {
    const outcomes = await Promise.allSettled([
      runtime.setRemoteControlIntent('offline'), runtime.setRemoteControlIntent('offline')
    ])
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1,
      'only the latest request reports successful confirmation')
    assert.equal((await new RemoteControlIntentStore(directory).read()).intent, 'offline')
  } finally { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('A4: an offline request superseded during shutdown cannot report stale success', async () => {
  const directory = await temporaryDirectory()
  const runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory, safeStorage: safeStorage() })
  const originalSet = (runtime as any).remoteIntent.set.bind((runtime as any).remoteIntent)
  let release!: () => void, entered!: () => void, persisted!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const stopping = new Promise<void>(resolve => { entered = resolve })
  const offlineCommitted = new Promise<void>(resolve => { persisted = resolve })
  let stopCount = 0
  ;(runtime as any).stopPlayer = async () => { if (++stopCount === 1) { entered(); await barrier } }
  ;(runtime as any).remoteIntent.set = async (intent: string, revision: number | undefined, canAdmit: () => boolean) => {
    const value = await originalSet(intent, revision, canAdmit)
    if (intent === 'offline') persisted()
    return value
  }
  try {
    const staleOffline = runtime.setRemoteControlIntent('offline')
    await Promise.all([stopping, offlineCommitted])
    await runtime.setRemoteControlIntent('enabled')
    release()
    await assert.rejects(staleOffline, /REMOTE_PLAYER_START_FENCED/)
    assert.equal((await new RemoteControlIntentStore(directory).read()).intent, 'enabled',
      'the later explicit enable remains the confirmed local choice')
  } finally { release(); await runtime.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('A4: generation guard is checked at SQLite admission after asynchronous preparation', async () => {
  const directory = await temporaryDirectory()
  const runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory, safeStorage: safeStorage() })
  const store = new RemoteControlIntentStore(directory)
  const originalSet = (runtime as any).remoteIntent.set.bind((runtime as any).remoteIntent)
  let release!: () => void, entered!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  ;(runtime as any).remoteIntent.set = async (intent: string, revision: number | undefined, canAdmit: () => boolean) => {
    if (intent === 'enabled') { entered(); await barrier }
    return originalSet(intent, revision, canAdmit)
  }
  try {
    const staleEnable = runtime.setRemoteControlIntent('enabled')
    await reached
    await runtime.setRemoteControlIntent('offline')
    release()
    await assert.rejects(staleEnable, /REMOTE_CONTROL_INTENT_TRANSITION_FENCED/)
    assert.equal((await store.read()).intent, 'offline')
  } finally { release(); await runtime.close(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('A4: concurrent explicit enables elect the newest request; close fences a pending enable', async () => {
  const directory = await temporaryDirectory()
  const runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory, safeStorage: safeStorage() })
  const store = new RemoteControlIntentStore(directory)
  try {
    const attempts = await Promise.allSettled([
      runtime.setRemoteControlIntent('enabled'), runtime.setRemoteControlIntent('enabled')
    ])
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal((await store.read()).intent, 'enabled')
  } finally { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }) }

  const closingDirectory = await temporaryDirectory()
  const closing = new MainRemoteRuntime({ mode: 'player', userDataDirectory: closingDirectory, safeStorage: safeStorage() })
  let release!: () => void, entered!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  ;(closing as any).stopPlayer = async () => { entered(); await barrier }
  const pendingEnable = closing.setRemoteControlIntent('enabled')
  await reached
  const close = closing.close()
  release()
  await assert.rejects(pendingEnable, /REMOTE_RUNTIME_CLOSED/)
  await close
  assert.equal((await new RemoteControlIntentStore(closingDirectory).read()).intent, 'disabled')
  await fs.rm(closingDirectory, { recursive: true, force: true })
})

test('A4: a newer enabled choice fences Player startup awaiting the persisted intent', async () => {
  const directory = await temporaryDirectory()
  const port = await availablePort()
  const runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory,
    safeStorage: safeStorage(), createAdvertiser: noOpAdvertiser })
  const intentStore = (runtime as any).remoteIntent as RemoteControlIntentStore
  const originalRead = intentStore.read.bind(intentStore)
  let release!: () => void, entered!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  let firstRead = true
  intentStore.read = async () => {
    if (firstRead) { firstRead = false; entered(); await barrier }
    return originalRead()
  }
  try {
    const staleStartup = runtime.startPlayer({ interfaceAddress: '127.0.0.1', displayName: 'A4 startup race', port,
      authorization: runtime.createPlayerPairingAuthorization() })
    await reached
    await runtime.setRemoteControlIntent('enabled')
    release()
    await assert.rejects(staleStartup, /REMOTE_PLAYER_START_FENCED/)
    assert.equal((await originalRead()).intent, 'enabled',
      'the latest explicit enable remains durable after the older startup is fenced')
    assert.equal(await isListening(port), false, 'the stale startup never opens a listener after the new transition')
  } finally { release(); await runtime.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
