import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isSupportedVideoExtension,
  parseVideoCode,
  VIDEO_LIBRARY_SUPPORTED_EXTENSIONS
} from '../src/video-library'
import {
  readVideoLibraryConfiguration,
  VideoLibraryConfigurationError,
  VIDEO_LIBRARY_CONFIGURATION_FILENAME,
  writeVideoLibraryConfiguration
} from '../src/video-library-configuration'
import { VideoLibraryService } from '../src/video-library-service'
import { VideoLibraryIndexStore } from '../src/video-library-index-store'

function temporaryDirectory(): { directory: string; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-video-library-'))
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

function indexedFileMetadata(filePath: string): { size: number; mtimeMs: number; device: string; inode: string } {
  const stats = fs.statSync(filePath, { bigint: true })
  return { size: Number(stats.size), mtimeMs: Number(stats.mtimeNs) / 1_000_000,
    device: stats.dev.toString(), inode: stats.ino.toString() }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(complete => { resolve = complete })
  return { promise, resolve }
}

test('video candidate extensions are recognized case-insensitively without claiming codec support', () => {
  for (const extension of VIDEO_LIBRARY_SUPPORTED_EXTENSIONS) {
    assert.equal(isSupportedVideoExtension(`00001${extension}`), true)
    assert.equal(isSupportedVideoExtension(`00001${extension.toUpperCase()}`), true)
  }
  for (const filename of ['00001.flv', '00001.txt', 'folder/00001.mp4', 'folder\\00001.mp4', '.mp4']) {
    assert.equal(isSupportedVideoExtension(filename), false, filename)
  }
})

test('video code parsing requires exactly five leading digits and an explicit filename boundary', () => {
  assert.equal(parseVideoCode('00001.mp4'), '00001')
  assert.equal(parseVideoCode('00123 - Queen.mp4'), '00123')
  assert.equal(parseVideoCode('01001_Always.mkv'), '01001')
  assert.equal(parseVideoCode('23242 Nome.webm'), '23242')

  for (const filename of [
    '1234.mp4',
    '123456.mp4',
    'x00123.mp4',
    ' 00123.mp4',
    '00123Queen.mp4',
    '00123.avi.mp4',
    'video 00123.mp4',
    '00123.flv'
  ]) {
    assert.equal(parseVideoCode(filename), undefined, filename)
  }
})

test('missing video library configuration defaults to no roots without creating a file', () => {
  const temp = temporaryDirectory()
  try {
    assert.deepEqual(readVideoLibraryConfiguration(temp.directory), { version: 1, roots: [] })
    assert.equal(fs.existsSync(path.join(temp.directory, VIDEO_LIBRARY_CONFIGURATION_FILENAME)), false)
  } finally { temp.cleanup() }
})

test('video library configuration persists normalized absolute roots and permits unavailable drives', () => {
  const temp = temporaryDirectory()
  try {
    const configuredRoot = path.join(temp.directory, 'future library', '..', 'media')
    const normalizedRoot = path.normalize(configuredRoot)
    writeVideoLibraryConfiguration(temp.directory, [configuredRoot])

    assert.deepEqual(readVideoLibraryConfiguration(temp.directory), { version: 1, roots: [normalizedRoot] })
    assert.equal(fs.existsSync(normalizedRoot), false, 'configuration should survive while a configured drive is unavailable')
  } finally { temp.cleanup() }
})

test('invalid video library configuration is rejected and preserved for repair', () => {
  const temp = temporaryDirectory()
  const invalidValues = [
    '{ invalid json',
    JSON.stringify({ version: 2, roots: [] }),
    JSON.stringify({ version: 1, roots: ['relative/path'] }),
    JSON.stringify({ version: 1, roots: [temp.directory, temp.directory] }),
    JSON.stringify({ version: 1, roots: [temp.directory], extra: true }),
    JSON.stringify({ version: 1, roots: [123] })
  ]

  try {
    for (const contents of invalidValues) {
      const filePath = path.join(temp.directory, VIDEO_LIBRARY_CONFIGURATION_FILENAME)
      fs.writeFileSync(filePath, contents)
      const original = fs.readFileSync(filePath)
      assert.throws(() => readVideoLibraryConfiguration(temp.directory), VideoLibraryConfigurationError)
      assert.deepEqual(fs.readFileSync(filePath), original, 'invalid configuration must not be rewritten or deleted')
    }

    const filePath = path.join(temp.directory, VIDEO_LIBRARY_CONFIGURATION_FILENAME)
    fs.writeFileSync(filePath, Buffer.from([0xc3, 0x28]))
    const original = fs.readFileSync(filePath)
    assert.throws(() => readVideoLibraryConfiguration(temp.directory), VideoLibraryConfigurationError)
    assert.deepEqual(fs.readFileSync(filePath), original, 'invalid UTF-8 must remain available for explicit repair')
  } finally { temp.cleanup() }
})

test('invalid writes leave the existing video library configuration unchanged', () => {
  const temp = temporaryDirectory()
  try {
    writeVideoLibraryConfiguration(temp.directory, [temp.directory])
    const filePath = path.join(temp.directory, VIDEO_LIBRARY_CONFIGURATION_FILENAME)
    const original = fs.readFileSync(filePath)
    assert.throws(() => writeVideoLibraryConfiguration(temp.directory, ['relative']), VideoLibraryConfigurationError)
    assert.deepEqual(fs.readFileSync(filePath), original)
  } finally { temp.cleanup() }
})

test('video library scan indexes recursive candidates and keeps paths out of public inventory', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(root, '00001.mp4'), '')
  fs.writeFileSync(path.join(root, 'nested', '00002 - descrição.webm'), '')
  fs.writeFileSync(path.join(root, '00003.txt'), '')
  fs.writeFileSync(path.join(root, 'without-code.mkv'), '')

  const library = new VideoLibraryService([root], { collectScanMetrics: true })
  try {
    const snapshot = await library.refresh()
    assert.equal(snapshot.scanStatus, 'ready')
    assert.equal(snapshot.configuredRootCount, 1)
    assert.equal(snapshot.scannedRootCount, 1)
    assert.deepEqual(snapshot.items.map(item => [item.musicCode, item.availability]), [
      ['00001', 'available'], ['00002', 'available']
    ])
    assert.equal(snapshot.counts.availableCodes, 2)
    assert.equal(snapshot.counts.invalidFilenames, 1)
    const metrics = library.getScanMetrics()
    assert.equal(metrics.directoriesEnumerated, 2)
    assert.equal(metrics.entriesEnumerated, 5)
    assert.equal(metrics.lstatCalls, 7)
    assert.equal(metrics.statCalls, 3)
    assert.equal(metrics.realpathCalls, 4)
    assert.equal(metrics.candidateFiles, 3)
    assert.equal(metrics.fileOpens, 2)
    assert.equal(metrics.fileCloses, 2)
    assert.equal(metrics.bytesRead, 0, 'indexing inspects metadata without reading video contents')
    assert.ok(metrics.durationMs >= 0)
    assert.equal(JSON.stringify(metrics).includes(root), false, 'diagnostics must not reveal local paths')
    assert.deepEqual(await library.lookup('00002'), {
      status: 'available', musicCode: '00002', filePath: path.join(root, 'nested', '00002 - descrição.webm')
    })

    const serializedPublicState = JSON.stringify(snapshot)
    assert.equal(serializedPublicState.includes(root), false, 'inventory snapshots must not expose absolute paths')
    assert.equal(JSON.stringify(library.getDiagnostics()).includes(root), false,
      'diagnostics may contain relative filenames but must not expose absolute paths')
    assert.equal(library.getDiagnostics().some(item => item.code === 'INVALID_FILENAME'), true)
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('video library scan counters stay disabled unless explicitly requested', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, '01001.mp4'), '')
  const library = new VideoLibraryService([root])
  try {
    const snapshot = await library.refresh()
    assert.equal(snapshot.counts.indexedFiles, 1)
    assert.deepEqual(library.getScanMetrics(), {
      durationMs: 0, directoriesEnumerated: 0, entriesEnumerated: 0, lstatCalls: 0,
      statCalls: 0, realpathCalls: 0, candidateFiles: 0, cacheHits: 0,
      fileOpens: 0, fileCloses: 0, bytesRead: 0, playbackYieldCount: 0, playbackYieldDurationMs: 0
    })
    assert.equal(library.getScanDiagnosticSnapshot().scanInProgress, false)
    assert.equal(library.getScanDiagnosticSnapshot().scanStatus, 'ready')
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('ambiguous duplicate codes are never selected and become available after refresh resolves the collision', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  fs.mkdirSync(root)
  const first = path.join(root, '00123.mp4')
  const second = path.join(root, '00123 - alternative.MKV')
  fs.writeFileSync(first, '')
  fs.writeFileSync(second, '')
  const library = new VideoLibraryService([root])

  try {
    const duplicateSnapshot = await library.refresh()
    assert.deepEqual(duplicateSnapshot.items, [{ musicCode: '00123', availability: 'ambiguous', candidateCount: 2 }])
    assert.equal((await library.lookup('00123')).status, 'ambiguous')
    assert.deepEqual(library.getDiagnostics().find(item => item.code === 'DUPLICATE_CODE')?.conflictingPaths,
      ['0:00123 - alternative.MKV', '0:00123.mp4'])

    fs.unlinkSync(second)
    const resolvedSnapshot = await library.refresh()
    assert.deepEqual(resolvedSnapshot.items, [{ musicCode: '00123', availability: 'available', candidateCount: 1 }])
    assert.deepEqual(await library.lookup('00123'), { status: 'available', musicCode: '00123', filePath: first })
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('refresh adds new files, reports removed codes, and uses a stable pathless inventory revision', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  fs.mkdirSync(root)
  const first = path.join(root, '01001.mp4')
  fs.writeFileSync(first, '')
  const library = new VideoLibraryService([root])

  try {
    const initial = await library.refresh()
    const initialRevision = initial.revision
    fs.writeFileSync(path.join(root, '01002.MP4'), '')
    fs.unlinkSync(first)

    const refreshed = await library.refresh()
    assert.deepEqual(refreshed.items, [
      { musicCode: '01001', availability: 'missing', candidateCount: 0 },
      { musicCode: '01002', availability: 'available', candidateCount: 1 }
    ])
    assert.notEqual(refreshed.revision, initialRevision)

    const repeated = await library.refresh()
    assert.equal(repeated.revision, refreshed.revision,
      'equivalent inventories must have a deterministic revision independent of scan timestamp')
    assert.ok(Number.isFinite(Date.parse(repeated.scannedAt ?? '')),
      'each completed scan records a valid completion time')
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('reconciliation detects renamed candidates and reopens same-size replacements with preserved timestamps', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  fs.mkdirSync(root)
  const firstPath = path.join(root, '00001.mp4')
  const renamedPath = path.join(root, '00002.mp4')
  fs.writeFileSync(firstPath, 'original')
  const stableTime = new Date('2026-11-10T12:00:00.000Z')
  fs.utimesSync(firstPath, stableTime, stableTime)
  const library = new VideoLibraryService([root], { collectScanMetrics: true })
  try {
    assert.deepEqual((await library.refresh()).items.map(item => item.musicCode), ['00001'])
    fs.renameSync(firstPath, renamedPath)
    assert.deepEqual((await library.refresh()).items, [
      { musicCode: '00001', availability: 'missing', candidateCount: 0 },
      { musicCode: '00002', availability: 'available', candidateCount: 1 }
    ], 'the prior code remains visible as missing after a complete scan confirms the rename')

    const previousPath = path.join(root, '00002.previous')
    fs.renameSync(renamedPath, previousPath)
    fs.writeFileSync(renamedPath, 'replaced')
    fs.utimesSync(renamedPath, stableTime, stableTime)
    const oldStats = fs.statSync(previousPath, { bigint: true })
    const newStats = fs.statSync(renamedPath, { bigint: true })
    assert.equal(newStats.size, oldStats.size)
    assert.equal(newStats.mtimeNs, oldStats.mtimeNs)
    assert.notEqual(newStats.ino, oldStats.ino, 'the retained old file prevents inode reuse during this fixture')

    const replacement = await library.refresh()
    assert.equal(replacement.items.find(item => item.musicCode === '00002')?.availability, 'available')
    assert.equal(library.getScanMetrics().fileOpens, 1,
      'a replacement with the same relative path, size, and timestamp must be reopened when file identity changes')
    assert.equal((await library.lookup('00002')).status, 'available')
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('reconfiguring library roots replaces inventory and rescans the selected directory', async () => {
  const temp = temporaryDirectory()
  const firstRoot = path.join(temp.directory, 'first-media')
  const secondRoot = path.join(temp.directory, 'second-media')
  fs.mkdirSync(firstRoot)
  fs.mkdirSync(secondRoot)
  fs.writeFileSync(path.join(firstRoot, '00001.mp4'), '')
  fs.writeFileSync(path.join(secondRoot, '00002.mp4'), '')
  const library = new VideoLibraryService([firstRoot])
  try {
    assert.deepEqual(library.roots, [path.resolve(firstRoot)])
    assert.deepEqual((await library.refresh()).items.map(item => item.musicCode), ['00001'])
    const configured = await library.configureRoots([secondRoot])
    assert.deepEqual(library.roots, [path.resolve(secondRoot)])
    assert.deepEqual(configured.items.map(item => item.musicCode), ['00002'])
    assert.equal((await library.lookup('00001')).status, 'missing', 'entries from the replaced root must not remain selectable')
    assert.equal((await library.lookup('00002')).status, 'available')
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('a missing configured root degrades the scan and preserves prior codes as unknown', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, '09999.mp4'), '')
  const library = new VideoLibraryService([root])

  try {
    const ready = await library.refresh()
    assert.equal(ready.items[0].availability, 'available')
    fs.renameSync(root, `${root}-offline`)

    const degraded = await library.refresh()
    assert.equal(degraded.scanStatus, 'degraded')
    assert.equal(degraded.configuredRootCount, 1)
    assert.equal(degraded.scannedRootCount, 0)
    assert.equal(degraded.unavailableRootCount, 1)
    assert.deepEqual(degraded.items, [{ musicCode: '09999', availability: 'unknown', candidateCount: 1 }])
    assert.equal((await library.lookup('09999')).status, 'unknown')
    assert.equal(library.getDiagnostics().some(item => item.code === 'ROOT_UNAVAILABLE'), true)
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('lookup reports unknown before a complete inventory and missing only after an empty successful scan', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  fs.mkdirSync(root)
  const library = new VideoLibraryService([root])

  try {
    assert.deepEqual(await library.lookup('12345'), { status: 'unknown', musicCode: '12345' })
    await library.refresh()
    assert.deepEqual(await library.lookup('12345'), { status: 'missing', musicCode: '12345' })
    fs.rmSync(root, { recursive: true, force: true })
    await library.refresh()
    assert.deepEqual(await library.lookup('12345'), { status: 'unknown', musicCode: '12345' })
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('lookup revalidates an indexed file and does not return a deleted path', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  fs.mkdirSync(root)
  const filePath = path.join(root, '00042.avi')
  fs.writeFileSync(filePath, '')
  const library = new VideoLibraryService([root])

  try {
    await library.refresh()
    fs.unlinkSync(filePath)
    assert.deepEqual(await library.lookup('00042'), { status: 'missing', musicCode: '00042' })
    assert.deepEqual(await library.lookup('42'), { status: 'invalid-code', musicCode: '42' })
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('a refresh requested during an active scan runs after it and publishes the newer inventory', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, '00001.mp4'), '')
  const library = new VideoLibraryService([root])
  const entered = deferred()
  const release = deferred()
  const internals = library as unknown as {
    scanRoot: (configuredRoot: string, rootId: string, rootIndex: number) => Promise<unknown>
  }
  const scanRoot = internals.scanRoot.bind(library)
  let scanCalls = 0
  internals.scanRoot = async (...args) => {
    scanCalls++
    if (scanCalls === 1) {
      entered.resolve()
      await release.promise
    }
    return scanRoot(...args)
  }

  try {
    const first = library.refresh()
    await entered.promise
    assert.equal(library.getSnapshot().scanStatus, 'scanning')
    assert.deepEqual(library.getSnapshot().items, [], 'an incomplete scan must not publish a partial index')
    fs.writeFileSync(path.join(root, '00002.mp4'), '')
    const second = library.refresh()
    assert.equal(first, second, 'concurrent refresh requests must share the serialized refresh operation')
    release.resolve()
    const snapshot = await first
    assert.equal(scanCalls, 2, 'the queued refresh must run after the active scan')
    assert.equal(snapshot.scanStatus, 'ready')
    assert.equal(snapshot.counts.availableCodes, 2)
    assert.equal(snapshot.items.some(item => item.musicCode === '00002' && item.availability === 'available'), true,
      'the refresh request arriving during a scan must not leave its final inventory stale')
    library.close()
    await assert.rejects(library.refresh(), /encerrada/)
  } finally {
    release.resolve()
    library.close()
    temp.cleanup()
  }
})

test('a persisted inventory is usable while reconciliation waits for playback and publishes only a complete generation', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  fs.mkdirSync(root)
  const firstPath = path.join(root, '00001.mp4')
  fs.writeFileSync(firstPath, '')
  const firstStats = indexedFileMetadata(firstPath)
  const store = new VideoLibraryIndexStore(path.join(temp.directory, 'profile'))
  await store.writeComplete({ generation: 1, configuredRoots: [root], roots: [{
    configuredPath: root, canonicalRoot: fs.realpathSync(root), entries: [{ relativePath: '00001.mp4',
      musicCode: '00001', size: firstStats.size, mtimeMs: firstStats.mtimeMs,
      device: firstStats.device, inode: firstStats.inode }]
  }] })
  const library = new VideoLibraryService([root], { indexStore: store, collectScanMetrics: true })
  try {
    assert.equal(await library.restorePersistentIndex(), 'restored')
    assert.equal(library.getSnapshot().scanStatus, 'ready')
    assert.equal(library.getSnapshot().counts.availableCodes, 1)

    library.setPlaybackActive(true)
    const reconcile = library.refresh()
    assert.equal(library.getSnapshot().scanStatus, 'scanning')
    assert.equal((await library.lookup('00001')).status, 'available',
      'the complete published generation stays playable while filesystem reconciliation yields')
    fs.writeFileSync(path.join(root, '00002.mp4'), '')
    assert.equal(library.getSnapshot().counts.availableCodes, 1,
      'a pending scan must not publish a partially observed directory')

    library.setPlaybackActive(false)
    const complete = await reconcile
    assert.equal(complete.scanStatus, 'ready')
    assert.deepEqual(complete.items.map(item => item.musicCode), ['00001', '00002'])
    const persisted = await store.read([root])
    assert.equal(persisted.status, 'valid')
    if (persisted.status === 'valid') assert.equal(persisted.index.generation, 2)
    assert.equal(library.getScanMetrics().cacheHits, 1)
    assert.equal(library.getScanMetrics().fileOpens, 1,
      'only the newly discovered candidate is opened during reconciliation')
    assert.ok(library.getScanMetrics().playbackYieldCount > 0,
      'opt-in metrics should prove the scan yielded while playback was active')
    assert.ok(library.getScanMetrics().playbackYieldDurationMs >= 0)
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('availability probe preserves cached inventory on removal and reconciles after the same configured root returns', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  const profile = path.join(temp.directory, 'profile')
  fs.mkdirSync(root)
  const mediaPath = path.join(root, '00031.mp4')
  fs.writeFileSync(mediaPath, '')
  const stats = indexedFileMetadata(mediaPath)
  const store = new VideoLibraryIndexStore(profile)
  await store.writeComplete({ generation: 2, configuredRoots: [root], roots: [{
    configuredPath: root, canonicalRoot: fs.realpathSync(root), entries: [{ relativePath: '00031.mp4',
      musicCode: '00031', size: stats.size, mtimeMs: stats.mtimeMs, device: stats.device, inode: stats.inode }]
  }] })
  const library = new VideoLibraryService([root], { indexStore: store })
  try {
    assert.equal(await library.restorePersistentIndex(), 'restored')
    assert.equal((await library.probeAvailability()).scanStatus, 'ready')
    assert.equal(library.getAvailabilitySummary().availableRoots, 1)

    fs.rmSync(root, { recursive: true, force: true })
    const removed = await library.probeAvailability()
    assert.equal(removed.scanStatus, 'degraded')
    assert.equal(removed.items[0]?.availability, 'unknown')
    assert.equal(library.getAvailabilitySummary().unavailableRoots, 1)
    assert.equal((await store.read([root])).status, 'valid', 'temporary removal must not delete the persisted index')

    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, '00031.mp4'), 'restored')
    const reconnected = await library.probeAvailability()
    assert.ok(reconnected.scanStatus === 'ready' || reconnected.scanStatus === 'scanning')
    assert.equal(library.getAvailabilitySummary().availableRoots, 1)
    await library.refresh()
    assert.equal(library.getSnapshot().scanStatus, 'ready')
    assert.equal(library.getAvailabilitySummary().availableRoots, 1)
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('availability probe coalesces work and refuses automatic remapping to a different device identity', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  fs.mkdirSync(root)
  const mediaPath = path.join(root, '00041.mp4')
  fs.writeFileSync(mediaPath, '')
  const stats = fs.statSync(mediaPath, { bigint: true })
  const store = new VideoLibraryIndexStore(path.join(temp.directory, 'profile'))
  await store.writeComplete({ generation: 1, configuredRoots: [root], roots: [{
    configuredPath: root, canonicalRoot: fs.realpathSync(root), entries: [{ relativePath: '00041.mp4',
      musicCode: '00041', size: Number(stats.size), mtimeMs: Number(stats.mtimeNs) / 1_000_000,
      device: (stats.dev + 1n).toString(), inode: stats.ino.toString() }]
  }] })
  const library = new VideoLibraryService([root], { indexStore: store })
  try {
    assert.equal(await library.restorePersistentIndex(), 'restored')
    const probe = library.probeAvailability()
    assert.equal(library.probeAvailability(), probe, 'simultaneous callers share one in-flight root probe')
    const snapshot = await probe
    assert.equal(snapshot.scanStatus, 'degraded')
    assert.equal(library.getAvailabilitySummary().volumeMismatchRoots, 1)
    const refresh = await library.refresh()
    assert.equal(refresh.scanStatus, 'degraded', 'refresh does not index a changed device by reusing the same path')
    assert.equal((await library.lookup('00041')).status, 'unknown')
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('a root probe completing after configuration changes cannot publish the old root state', async () => {
  const temp = temporaryDirectory()
  const oldRoot = path.join(temp.directory, 'old')
  const newRoot = path.join(temp.directory, 'new')
  fs.mkdirSync(oldRoot)
  fs.mkdirSync(newRoot)
  fs.writeFileSync(path.join(oldRoot, '00051.mp4'), '')
  fs.writeFileSync(path.join(newRoot, '00052.mp4'), '')
  const library = new VideoLibraryService([oldRoot])
  await library.refresh()
  const entered = deferred()
  const release = deferred()
  const originalRealpath = fs.promises.realpath
  let blockOldRoot = true
  fs.promises.realpath = (async (value: fs.PathLike, ...args: unknown[]) => {
    if (blockOldRoot && String(value) === oldRoot) {
      blockOldRoot = false
      entered.resolve()
      await release.promise
    }
    return originalRealpath.call(fs.promises, value as never, ...(args as never[]))
  }) as typeof fs.promises.realpath
  try {
    const oldProbe = library.probeAvailability()
    await entered.promise
    const newRootScan = library.configureRoots([newRoot])
    release.resolve()
    await oldProbe
    const current = await newRootScan
    assert.deepEqual(library.roots, [newRoot])
    assert.deepEqual(current.items.map(item => item.musicCode), ['00052'])
    assert.equal(library.getAvailabilitySummary().availableRoots, 1)
  } finally {
    fs.promises.realpath = originalRealpath
    release.resolve()
    library.close()
    temp.cleanup()
  }
})

test('changing roots cancels obsolete scan publication and reconciles only the new root', async () => {
  const temp = temporaryDirectory()
  const oldRoot = path.join(temp.directory, 'old')
  const newRoot = path.join(temp.directory, 'new')
  fs.mkdirSync(oldRoot)
  fs.mkdirSync(newRoot)
  fs.writeFileSync(path.join(oldRoot, '00011.mp4'), '')
  fs.writeFileSync(path.join(newRoot, '00022.mp4'), '')
  const library = new VideoLibraryService([oldRoot])
  const entered = deferred()
  const release = deferred()
  const internals = library as unknown as { scanRoot: (...args: any[]) => Promise<any> }
  const originalScanRoot = internals.scanRoot.bind(library)
  let delayed = true
  internals.scanRoot = async (...args: any[]) => {
    if (delayed) {
      delayed = false
      entered.resolve()
      await release.promise
    }
    return originalScanRoot(...args)
  }
  try {
    const obsoleteScan = library.refresh()
    await entered.promise
    const configured = library.configureRoots([newRoot])
    assert.equal(library.getSnapshot().configuredRootCount, 1)
    assert.deepEqual(library.getSnapshot().items, [], 'old-root inventory is cleared after the user changes the root')
    release.resolve()
    const snapshot = await configured
    await obsoleteScan
    assert.equal(snapshot.scanStatus, 'ready')
    assert.deepEqual(snapshot.items.map(item => item.musicCode), ['00022'])
    assert.deepEqual(library.roots, [newRoot])
  } finally {
    release.resolve()
    library.close()
    temp.cleanup()
  }
})

test('closing during an active scan prevents a partially built snapshot from being published', async () => {
  const temp = temporaryDirectory()
  let library: VideoLibraryService | undefined
  const scanCaptured = deferred()
  const release = deferred()

  try {
    const root = path.join(temp.directory, 'media')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, '00011.mp4'), '')
    library = new VideoLibraryService([root])
    const baseline = await library.refresh()
    assert.deepEqual(baseline.items, [{ musicCode: '00011', availability: 'available', candidateCount: 1 }])

    const addedFile = path.join(root, '00012.mp4')
    fs.writeFileSync(addedFile, '')
    const internals = library as unknown as {
      scanRoot: (configuredRoot: string, rootId: string, rootIndex: number) => Promise<unknown>
    }
    const scanRoot = internals.scanRoot.bind(library)
    internals.scanRoot = async (...args) => {
      const completedScan = await scanRoot(...args)
      scanCaptured.resolve()
      await release.promise
      return completedScan
    }

    const pending = library.refresh()
    await scanCaptured.promise
    library.close()
    release.resolve()
    const snapshot = await pending
    assert.equal(snapshot.scanStatus, 'closed')
    assert.equal(snapshot.revision, baseline.revision)
    assert.deepEqual(snapshot.items, baseline.items, 'shutdown must retain the previous complete snapshot')
    assert.equal(snapshot.items.some(item => item.musicCode === '00012'), false,
      'a complete scan result awaiting publication must be discarded after shutdown')
    await assert.rejects(library.refresh(), /encerrada/)
  } finally {
    release.resolve()
    library?.close()
    temp.cleanup()
  }
})

test('recursive scan does not follow symbolic links or Windows junctions', async () => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'media')
  const outside = path.join(temp.directory, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, '05000.mp4'), '')
  fs.writeFileSync(path.join(root, '00001.mp4'), '')
  const cycle = path.join(root, 'cycle-to-root')
  if (process.platform === 'win32') {
    fs.symlinkSync(outside, path.join(root, 'linked-directory'), 'junction')
    fs.symlinkSync(root, cycle, 'junction')
  } else {
    fs.symlinkSync(path.join(outside, '05000.mp4'), path.join(root, '05000.mp4'))
    fs.symlinkSync(outside, path.join(root, 'linked-directory'), 'dir')
    fs.symlinkSync(root, cycle, 'dir')
  }
  const library = new VideoLibraryService([root])

  try {
    const snapshot = await library.refresh()
    assert.deepEqual(snapshot.items, [{ musicCode: '00001', availability: 'available', candidateCount: 1 }])
    assert.equal(library.getDiagnostics().filter(item => item.code === 'UNSAFE_ENTRY').length,
      process.platform === 'win32' ? 2 : 3)
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('a background permit rechecks playback when idle is followed synchronously by another active attempt', async () => {
  const temp = temporaryDirectory()
  fs.writeFileSync(path.join(temp.directory, '00001.mp4'), '')
  const library = new VideoLibraryService([temp.directory], { collectScanMetrics: true })
  try {
    library.setPlaybackActive(true)
    const scanning = library.refresh()
    library.setPlaybackActive(false)
    library.setPlaybackActive(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(library.getScanMetrics().realpathCalls, 0, 'a resolved waiter is not a permit if playback became active again')
    assert.equal(library.getScanMetrics().statCalls, 0)
    library.setPlaybackActive(false)
    assert.equal((await scanning).scanStatus, 'ready')
  } finally {
    library.close()
    temp.cleanup()
  }
})

test('a completed private scan waits for playback before publishing its new generation', async () => {
  const temp = temporaryDirectory()
  fs.writeFileSync(path.join(temp.directory, '00001.mp4'), '')
  const library = new VideoLibraryService([temp.directory], { collectScanMetrics: true })
  let entered!: () => void
  let release!: () => void
  const readyToPublish = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  try {
    await library.refresh()
    const prior = library.getSnapshot()
    fs.writeFileSync(path.join(temp.directory, '00002.mp4'), '')
    const internals = library as unknown as { scanRoot(...args: unknown[]): Promise<unknown> }
    const scanRoot = internals.scanRoot.bind(library)
    internals.scanRoot = async (...args) => {
      const candidate = await scanRoot(...args)
      entered()
      await barrier
      return candidate
    }
    const scanning = library.refresh()
    await readyToPublish
    library.setPlaybackActive(true)
    release()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(library.getSnapshot().revision, prior.revision, 'playback must retain the published capability revision')
    assert.equal(library.getSnapshot().counts.availableCodes, 1, 'a candidate completed during playback stays private')
    library.setPlaybackActive(false)
    assert.equal((await scanning).counts.availableCodes, 2)
  } finally {
    release()
    library.close()
    temp.cleanup()
  }
})
