import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Protocol } from 'electron'
import { createPlayerMusicCatalogDatabase } from '../database'
import { MainMediaRuntime } from '../src/main-media-runtime'
import { writeVideoLibraryConfiguration } from '../src/video-library-configuration'
import { VideoLibraryIndexStore } from '../src/video-library-index-store'

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kq-main-media-runtime-'))
}

function createProtocol() {
  const calls: string[] = []
  const protocol = {
    handle: (scheme: string) => calls.push(`handle:${scheme}`),
    unhandle: (scheme: string) => calls.push(`unhandle:${scheme}`)
  } as unknown as Protocol
  return { protocol, calls }
}

function logger() {
  const events: string[] = []
  const details: unknown[] = []
  return {
    events,
    details,
    info: (_origin: string, event: string, _message: string, detail?: unknown) => {
      events.push(event)
      if (detail !== undefined) details.push(detail)
    },
    warn: (_origin: string, event: string) => events.push(event),
    error: (_origin: string, event: string) => events.push(event)
  }
}

const testCatalogs = new Map<MainMediaRuntime, ReturnType<typeof createPlayerMusicCatalogDatabase>>()
function createTestCatalog(runtime: MainMediaRuntime, profile: string): void {
  const database = createPlayerMusicCatalogDatabase(profile)
  testCatalogs.set(runtime, database)
  runtime.createCatalog(database)
}
function closeTestCatalog(runtime: MainMediaRuntime): void {
  testCatalogs.get(runtime)?.close()
  testCatalogs.delete(runtime)
}

async function admitRuntime(runtime: MainMediaRuntime, profile: string): Promise<void> {
  createTestCatalog(runtime, profile)
  const sequence = await runtime.createStandaloneSequence(() => undefined)
  await sequence.resolveStartupRecovery()
  assert.equal(runtime.admitStandaloneReconciliation(), true)
}

test('Standalone F0 scan metrics are opt-in, aggregated, and do not alter the inventory', async () => {
  const previous = process.env.KQ_F0_DIAGNOSTICS
  const root = temporaryDirectory()
  const disabledProfile = temporaryDirectory()
  const enabledProfile = temporaryDirectory()
  fs.writeFileSync(path.join(root, '01001.mp4'), '')
  writeVideoLibraryConfiguration(disabledProfile, [root])
  writeVideoLibraryConfiguration(enabledProfile, [root])
  const disabledProtocol = createProtocol()
  const disabledLog = logger()
  const disabledRuntime = new MainMediaRuntime({ operatingMode: 'player', userDataDirectory: disabledProfile,
    protocol: disabledProtocol.protocol, logger: disabledLog, isShutdownStarted: () => false })
  const protocol = createProtocol()
  const log = logger()
  const runtime = new MainMediaRuntime({ operatingMode: 'player', userDataDirectory: enabledProfile,
    protocol: protocol.protocol, logger: log, isShutdownStarted: () => false })
  try {
    delete process.env.KQ_F0_DIAGNOSTICS
    const uninstrumented = await disabledRuntime.initializePlayerInfrastructure()
    await admitRuntime(disabledRuntime, disabledProfile)
    await new Promise<void>(resolve => setImmediate(resolve))
    await disabledRuntime.library?.refresh()
    assert.equal(disabledLog.events.includes('F0_LIBRARY_SCAN_METRICS'), false)
    assert.equal(disabledRuntime.library?.getScanMetrics().candidateFiles, 0)

    process.env.KQ_F0_DIAGNOSTICS = '1'
    const inventory = await runtime.initializePlayerInfrastructure()
    await admitRuntime(runtime, enabledProfile)
    await new Promise<void>(resolve => setImmediate(resolve))
    await runtime.library?.refresh()
    const reconciled = runtime.library?.getSnapshot()
    assert.equal(reconciled?.scanStatus, 'ready')
    assert.equal(reconciled?.counts.indexedFiles, 1)
    assert.deepEqual(reconciled?.counts, disabledRuntime.library?.getSnapshot().counts)
    assert.ok(log.events.includes('F0_LIBRARY_SCAN_METRICS'))
    const metrics = log.details.find(value => typeof value === 'object' && value !== null &&
      'phase' in value && value.phase === 'library-scan') as Record<string, unknown> | undefined
    assert.ok(metrics)
    assert.equal(typeof metrics.runId, 'string')
    assert.equal(typeof metrics.elapsedMs, 'number')
    assert.equal(metrics.indexedFiles, 1)
    assert.equal(metrics.candidateFiles, 1)
    assert.equal(Number(metrics.fileOpens) + Number(metrics.cacheHits), 1)
    assert.equal(metrics.fileCloses, metrics.fileOpens)
    assert.equal(JSON.stringify(metrics).includes(root), false)
    assert.equal(JSON.stringify(metrics).includes('01001'), false)
  } finally {
    if (previous === undefined) delete process.env.KQ_F0_DIAGNOSTICS
    else process.env.KQ_F0_DIAGNOSTICS = previous
    await runtime.disposeAfterFailedStartup(() => undefined)
    await disabledRuntime.disposeAfterFailedStartup(() => undefined)
    runtime.mediaProtocol?.dispose(protocol.protocol)
    closeTestCatalog(runtime)
    disabledRuntime.mediaProtocol?.dispose(disabledProtocol.protocol)
    closeTestCatalog(disabledRuntime)
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(disabledProfile, { recursive: true, force: true })
    fs.rmSync(enabledProfile, { recursive: true, force: true })
  }
})

test('Standalone media runtime creates one local catalog, recovery, library and volatile sequence', async () => {
  const userDataDirectory = temporaryDirectory()
  const protocol = createProtocol()
  const log = logger()
  const runtime = new MainMediaRuntime({ operatingMode: 'player', userDataDirectory,
    protocol: protocol.protocol, logger: log, isShutdownStarted: () => false })
  const catalogDatabase = createPlayerMusicCatalogDatabase(userDataDirectory)
  let optionsDisposed = 0
  try {
    const inventory = await runtime.initializePlayerInfrastructure()
    assert.ok(inventory)
    await runtime.library?.refresh()
    assert.equal(runtime.library?.getSnapshot().counts.availableCodes, 0)
    assert.equal(Boolean(runtime.playback), false, 'the playback owner is created with the sequence composition')
    assert.equal(protocol.calls.filter(value => value === 'handle:kq-media').length, 1)

    const catalog = runtime.createCatalog(catalogDatabase)
    assert.equal(catalog.getMetadata().recordCount, 0)
    assert.equal(log.events.filter(value => value === 'PLAYER_MUSIC_CATALOG_READY').length, 1)
    const sequence = await runtime.createStandaloneSequence(() => { optionsDisposed++ })
    assert.equal(runtime.sequence, sequence)
    assert.equal(runtime.playback?.getState().status, 'idle')
    assert.equal(sequence.getSnapshot().playbackCondition, 'blocked', 'Main must not admit commands before host preparation')
    await sequence.resolveStartupRecovery()
    const snapshot = sequence.getSnapshot()
    if (snapshot.playbackCondition !== 'ready') throw new Error('new sequence should have a confirmed ready snapshot')
    assert.equal(snapshot.state.pending.length, 0)

    await sequence.dispose()
    assert.equal(optionsDisposed, 1)
    await catalogDatabase.close()
    runtime.mediaProtocol?.dispose(protocol.protocol)
    closeTestCatalog(runtime)
    assert.deepEqual(protocol.calls, ['handle:kq-media', 'unhandle:kq-media'])
  } finally {
    try { await catalogDatabase.close() } catch {}
    fs.rmSync(userDataDirectory, { recursive: true, force: true })
  }
})

test('Combined media runtime attaches one manual authority to one playback service', async () => {
  const userDataDirectory = temporaryDirectory()
  const protocol = createProtocol()
  const runtime = new MainMediaRuntime({ operatingMode: 'combined', userDataDirectory,
    protocol: protocol.protocol, logger: logger(), isShutdownStarted: () => false })
  try {
    assert.ok(await runtime.initializePlayerInfrastructure())
    assert.equal(runtime.playback?.getState().status, 'idle')
    assert.ok(runtime.manual)
    assert.ok(runtime.recovery)
    await runtime.disposeAfterFailedStartup(() => undefined)
    runtime.mediaProtocol?.dispose(protocol.protocol)
    closeTestCatalog(runtime)
  } finally {
    fs.rmSync(userDataDirectory, { recursive: true, force: true })
  }
})

test('Standalone opens from a persisted complete inventory while an absent USB root reconciles in background', async () => {
  const userDataDirectory = temporaryDirectory()
  const root = path.join(userDataDirectory, 'removable-media')
  fs.mkdirSync(root)
  const mediaPath = path.join(root, '00123.mp4')
  fs.writeFileSync(mediaPath, '')
  const mediaStats = fs.statSync(mediaPath, { bigint: true })
  writeVideoLibraryConfiguration(userDataDirectory, [root])
  await new VideoLibraryIndexStore(userDataDirectory).writeComplete({ generation: 4,
    configuredRoots: [root], roots: [{ configuredPath: root, canonicalRoot: fs.realpathSync(root), entries: [{
      relativePath: '00123.mp4', musicCode: '00123', size: Number(mediaStats.size),
      mtimeMs: Number(mediaStats.mtimeNs) / 1_000_000, device: mediaStats.dev.toString(), inode: mediaStats.ino.toString()
    }] }] })
  fs.rmSync(root, { recursive: true, force: true })

  const protocol = createProtocol()
  const runtime = new MainMediaRuntime({ operatingMode: 'player', userDataDirectory,
    protocol: protocol.protocol, logger: logger(), isShutdownStarted: () => false })
  try {
    const startupSnapshot = await runtime.initializePlayerInfrastructure()
    assert.equal(startupSnapshot?.scanStatus, 'ready')
    assert.deepEqual(startupSnapshot?.items, [{ musicCode: '00123', availability: 'available', candidateCount: 1 }],
      'initialization returns the last complete cache without awaiting the missing drive scan')
    await new Promise<void>(resolve => setImmediate(resolve))
    const reconciled = await runtime.library?.refresh()
    assert.equal(reconciled?.scanStatus, 'degraded')
    assert.equal(reconciled?.items[0]?.availability, 'unknown',
      'temporary root loss preserves the cached code as unknown rather than deleting the inventory')
    assert.deepEqual(runtime.library?.roots, [root])
  } finally {
    await runtime.disposeAfterFailedStartup(() => undefined)
    runtime.mediaProtocol?.dispose(protocol.protocol)
    closeTestCatalog(runtime)
    fs.rmSync(userDataDirectory, { recursive: true, force: true })
  }
})

test('Combined keeps the Management runtime available when its optional video-library configuration is invalid', async () => {
  const userDataDirectory = temporaryDirectory()
  const protocol = createProtocol()
  const log = logger()
  const configPath = path.join(userDataDirectory, 'video-library.json')
  const originalConfig = Buffer.from('{invalid legacy video-library configuration')
  fs.writeFileSync(configPath, originalConfig)
  const runtime = new MainMediaRuntime({ operatingMode: 'combined', userDataDirectory,
    protocol: protocol.protocol, logger: log, isShutdownStarted: () => false })
  try {
    const inventory = await runtime.initializePlayerInfrastructure()
    assert.ok(inventory)
    assert.equal(inventory.configuredRootCount, 0)
    assert.equal(runtime.library?.getSnapshot().counts.availableCodes, 0)
    assert.ok(runtime.manual, 'Combined playback remains composed with an empty library service')
    assert.ok(log.events.includes('VIDEO_LIBRARY_CONFIGURATION_INVALID'))
    assert.deepEqual(fs.readFileSync(configPath), originalConfig,
      'invalid media configuration must be reported and preserved without an automatic repair')
    await runtime.disposeAfterFailedStartup(() => undefined)
    runtime.mediaProtocol?.dispose(protocol.protocol)
    closeTestCatalog(runtime)
  } finally {
    fs.rmSync(userDataDirectory, { recursive: true, force: true })
  }
})

test('media runtime retains ownership of acquired resources when startup stops after library scan', async () => {
  const userDataDirectory = temporaryDirectory()
  const protocol = createProtocol()
  const runtime = new MainMediaRuntime({ operatingMode: 'combined', userDataDirectory,
    protocol: protocol.protocol, logger: logger(), isShutdownStarted: () => true })
  try {
    assert.equal(await runtime.initializePlayerInfrastructure(), undefined)
    assert.ok(runtime.library)
    assert.ok(runtime.recovery)
    assert.equal(runtime.playback, undefined)
    assert.deepEqual(protocol.calls, [])
    await runtime.disposeAfterFailedStartup(() => undefined)
  } finally {
    fs.rmSync(userDataDirectory, { recursive: true, force: true })
  }
})

for (const cached of [false, true]) {
  test(`Standalone admits one scan only after operational recovery gate (cached=${cached})`, async () => {
    const profile = temporaryDirectory()
    const root = path.join(profile, 'media')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, '00001.mp4'), '')
    writeVideoLibraryConfiguration(profile, [root])
    if (cached) {
      const { VideoLibraryService } = await import('../src/video-library-service')
      const seed = new VideoLibraryService([root], { indexStore: new VideoLibraryIndexStore(profile) })
      await seed.refresh()
      seed.close()
    }
    const protocol = createProtocol()
    let shutdown = false
    const runtime = new MainMediaRuntime({ operatingMode: 'player', userDataDirectory: profile,
      protocol: protocol.protocol, logger: logger(), isShutdownStarted: () => shutdown })
    const originalReaddir = fs.promises.readdir
    let entered!: () => void
    let release!: () => void
    const enteredScan = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    let reads = 0
    fs.promises.readdir = (async (...args: unknown[]) => {
      if (args[0] === root) { reads++; entered(); await barrier }
      return (originalReaddir as Function)(...args)
    }) as typeof fs.promises.readdir
    try {
      await runtime.initializePlayerInfrastructure()
      assert.equal(runtime.library?.getSnapshot().counts.indexedFiles, cached ? 1 : 0)
      assert.equal(runtime.admitStandaloneReconciliation(), false)
      await runtime.probeLibraryAvailability()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(reads, 0, 'no directory enumeration before host/sequence composition')
      createTestCatalog(runtime, profile)
      const sequence = await runtime.createStandaloneSequence(() => undefined)
      assert.equal(runtime.admitStandaloneReconciliation(), false, 'unresolved recovery is not a ready gate')
      await runtime.probeLibraryAvailability()
      assert.equal(reads, 0, 'show/focus probes cannot bypass the startup gate')
      await sequence.resolveStartupRecovery()
      assert.equal(runtime.admitStandaloneReconciliation(), true)
      assert.equal(runtime.admitStandaloneReconciliation(), true, 'duplicate readiness must be idempotent')
      await enteredScan
      assert.equal(sequence.getSnapshot().playbackCondition, 'ready', 'slow scan does not block operational state')
      assert.equal(reads, 1)
      shutdown = true
      const disposing = runtime.disposeAfterFailedStartup(() => undefined)
      assert.equal(runtime.admitStandaloneReconciliation(), false)
      release()
      await disposing
      assert.equal(reads, 1, 'late I/O completion cannot start another scan')
      assert.equal(runtime.library?.getSnapshot().scanStatus, 'closed')
    } finally {
      release()
      fs.promises.readdir = originalReaddir
      await runtime.disposeAfterFailedStartup(() => undefined)
      runtime.mediaProtocol?.dispose(protocol.protocol)
    closeTestCatalog(runtime)
      fs.rmSync(profile, { recursive: true, force: true })
    }
  })
}

test('shutdown before the operational gate permanently prevents scan admission and probes', async () => {
  const profile = temporaryDirectory()
  const protocol = createProtocol()
  let shutdown = false
  const runtime = new MainMediaRuntime({ operatingMode: 'player', userDataDirectory: profile,
    protocol: protocol.protocol, logger: logger(), isShutdownStarted: () => shutdown })
  try {
    await runtime.initializePlayerInfrastructure()
    createTestCatalog(runtime, profile)
    const sequence = await runtime.createStandaloneSequence(() => undefined)
    await sequence.resolveStartupRecovery()
    shutdown = true
    assert.equal(runtime.admitStandaloneReconciliation(), false)
    assert.equal(await runtime.probeLibraryAvailability(), undefined)
    await runtime.disposeAfterFailedStartup(() => undefined)
    shutdown = false
    assert.equal(runtime.admitStandaloneReconciliation(), false, 'late ready does not resurrect a disposed runtime')
  } finally {
    runtime.mediaProtocol?.dispose(protocol.protocol)
    closeTestCatalog(runtime)
    fs.rmSync(profile, { recursive: true, force: true })
  }
})

for (const recoveryStatus of ['paused', 'playing', 'pending', 'uncertain'] as const) {
  test(`old ${recoveryStatus} recovery keeps scan gate closed until fresh host containment is confirmed`, async () => {
    const profile = temporaryDirectory()
    const { PlayerPlaybackRecoveryStore } = await import('../src/player-playback-recovery-store')
    const updatedAt = new Date().toISOString()
    new PlayerPlaybackRecoveryStore(profile).write({ version: 1, revision: 1, status: recoveryStatus,
      attemptId: '37d8fb42-d5ab-44ea-b064-d9a3626c33e7', musicCode: '00001', playbackStatus: recoveryStatus === 'pending' ? 'loading' : recoveryStatus,
      lastTransition: recoveryStatus === 'pending' ? 'load-intent' : recoveryStatus === 'uncertain' ? 'playback-uncertain'
        : recoveryStatus === 'paused' ? 'playback-paused' : 'playback-started', updatedAt, startedAt: updatedAt })
    const protocol = createProtocol()
    const runtime = new MainMediaRuntime({ operatingMode: 'player', userDataDirectory: profile,
      protocol: protocol.protocol, logger: logger(), isShutdownStarted: () => false })
    let clearEntered!: () => void
    let clearReleased!: () => void
    const entered = new Promise<void>(resolve => { clearEntered = resolve })
    const barrier = new Promise<void>(resolve => { clearReleased = resolve })
    try {
      await runtime.initializePlayerInfrastructure()
      createTestCatalog(runtime, profile)
      const sequence = await runtime.createStandaloneSequence(() => undefined)
      runtime.playback!.attachHost({ hostEpoch: 'fresh-host', ready: Promise.resolve(),
        send: async command => { if (command.type === 'clear') { clearEntered(); await barrier } },
        subscribe: () => () => undefined, dispose: () => undefined, terminate: async () => true })
      const resolving = sequence.resolveStartupRecovery()
      await entered
      assert.equal(runtime.admitStandaloneReconciliation(), false)
      assert.equal(await runtime.probeLibraryAvailability(), undefined)
      assert.equal(sequence.getSnapshot().playbackCondition, 'blocked')
      clearReleased()
      await resolving
      assert.equal(new PlayerPlaybackRecoveryStore(profile).read()?.status, 'dismissed')
      assert.equal(runtime.admitStandaloneReconciliation(), true)
    } finally {
      clearReleased()
      await runtime.disposeAfterFailedStartup(() => undefined)
      runtime.mediaProtocol?.dispose(protocol.protocol)
    closeTestCatalog(runtime)
      fs.rmSync(profile, { recursive: true, force: true })
    }
  })
}

test('failed recovery containment leaves reconciliation and probes blocked', async () => {
  const profile = temporaryDirectory()
  const { PlayerPlaybackRecoveryStore } = await import('../src/player-playback-recovery-store')
  const updatedAt = new Date().toISOString()
  new PlayerPlaybackRecoveryStore(profile).write({ version: 1, revision: 1, status: 'paused',
    attemptId: '37d8fb42-d5ab-44ea-b064-d9a3626c33e7', musicCode: '00001', playbackStatus: 'paused', lastTransition: 'playback-paused', updatedAt, startedAt: updatedAt })
  const protocol = createProtocol()
  const runtime = new MainMediaRuntime({ operatingMode: 'player', userDataDirectory: profile,
    protocol: protocol.protocol, logger: logger(), isShutdownStarted: () => false })
  try {
    await runtime.initializePlayerInfrastructure()
    createTestCatalog(runtime, profile)
    const sequence = await runtime.createStandaloneSequence(() => undefined)
    await assert.rejects(sequence.resolveStartupRecovery(), { code: 'RECOVERY_UNAVAILABLE' })
    assert.equal(runtime.admitStandaloneReconciliation(), false)
    assert.equal(await runtime.probeLibraryAvailability(), undefined)
    assert.equal(new PlayerPlaybackRecoveryStore(profile).read()?.status, 'paused')
  } finally {
    await runtime.disposeAfterFailedStartup(() => undefined)
    runtime.mediaProtocol?.dispose(protocol.protocol)
    closeTestCatalog(runtime)
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
