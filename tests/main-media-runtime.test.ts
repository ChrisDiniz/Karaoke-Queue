import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Protocol } from 'electron'
import { createPlayerMusicCatalogDatabase } from '../database'
import { MainMediaRuntime } from '../src/main-media-runtime'

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
  return {
    events,
    info: (_origin: string, event: string) => events.push(event),
    warn: (_origin: string, event: string) => events.push(event),
    error: (_origin: string, event: string) => events.push(event)
  }
}

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
    assert.equal(runtime.library?.getSnapshot().counts.availableCodes, 0)
    assert.equal(Boolean(runtime.playback), false, 'the playback owner is created with the sequence composition')
    assert.equal(protocol.calls.filter(value => value === 'handle:kq-media').length, 1)

    const catalog = runtime.createCatalog(catalogDatabase)
    assert.equal(catalog.getMetadata().recordCount, 0)
    assert.equal(log.events.filter(value => value === 'PLAYER_MUSIC_CATALOG_READY').length, 1)
    const sequence = await runtime.createStandaloneSequence(() => { optionsDisposed++ })
    assert.equal(runtime.sequence, sequence)
    assert.equal(runtime.playback?.getState().status, 'idle')
    const snapshot = sequence.getSnapshot()
    if (snapshot.playbackCondition !== 'ready') throw new Error('new sequence should have a confirmed ready snapshot')
    assert.equal(snapshot.state.pending.length, 0)

    await sequence.dispose()
    assert.equal(optionsDisposed, 1)
    await catalogDatabase.close()
    runtime.mediaProtocol?.dispose(protocol.protocol)
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
  } finally {
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
