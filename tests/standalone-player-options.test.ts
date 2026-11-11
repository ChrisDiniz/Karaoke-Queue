import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPlayerMusicCatalogDatabase } from '../database'
import { MusicCatalogError, parseMusicCatalogCsv } from '../src/music-catalog'
import { MusicCatalogService } from '../src/music-catalog-service'
import { isStandalonePlayerLibraryChangeAllowed, StandalonePlayerOptionsService } from '../src/standalone-player-options'
import { readVideoLibraryConfiguration } from '../src/video-library-configuration'
import { VideoLibraryService } from '../src/video-library-service'

function temporaryDirectory(): { directory: string; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-standalone-options-'))
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

function readyState(operationalState: 'idle' | 'playing' | 'paused', pending: unknown[] = []): unknown {
  return {
    playbackCondition: 'ready',
    state: {
      operationalState,
      current: operationalState === 'idle' ? null : { entryId: 'entry-1', attemptId: 'attempt-1', musicCode: '01001' },
      pending
    }
  }
}

test('library change gate requires confirmed idle playback and an empty pending sequence', () => {
  assert.equal(isStandalonePlayerLibraryChangeAllowed(readyState('idle') as never), true)
  assert.equal(isStandalonePlayerLibraryChangeAllowed(readyState('idle', [{ musicCode: '01002' }]) as never), false)
  assert.equal(isStandalonePlayerLibraryChangeAllowed(readyState('playing') as never), false)
  assert.equal(isStandalonePlayerLibraryChangeAllowed(readyState('paused') as never), false)
  for (const playbackCondition of ['blocked', 'uncertain', 'transitioning']) {
    assert.equal(isStandalonePlayerLibraryChangeAllowed({ playbackCondition } as never), false, playbackCondition)
  }
})

test('options service persists selected roots, reports real ready/degraded scans, and never exposes absolute paths', async t => {
  const temp = temporaryDirectory()
  let library: VideoLibraryService | undefined
  let database: ReturnType<typeof createPlayerMusicCatalogDatabase> | undefined
  let catalog: MusicCatalogService | undefined
  let options: StandalonePlayerOptionsService | undefined
  t.after(async () => {
    options?.dispose()
    await catalog?.close()
    library?.close()
    database?.close()
    temp.cleanup()
  })
  const root = path.join(temp.directory, 'videos')
  const emptyRoot = path.join(temp.directory, 'empty')
  const unavailableRoot = path.join(temp.directory, 'removed-drive')
  fs.mkdirSync(root)
  fs.mkdirSync(emptyRoot)
  fs.writeFileSync(path.join(root, '01001.mp4'), Buffer.from('not decoded by the indexer'))

  library = new VideoLibraryService([root])
  await library.refresh()
  database = createPlayerMusicCatalogDatabase(temp.directory)
  catalog = new MusicCatalogService(database, library)
  options = new StandalonePlayerOptionsService({
    library,
    catalog,
    userDataDirectory: temp.directory,
    dialogs: { chooseVideoFolder: async () => null, chooseCatalogFile: async () => null }
  })
  t.after(() => options.dispose())

  const initial = options.getSnapshot()
  assert.deepEqual(initial.library, { folderName: 'videos', scanStatus: 'ready', indexedFiles: 1 })
  assert.deepEqual(initial.catalog, {
    fileName: null, recordCount: 0, importedAt: null, revision: null, importIssueCount: 0, importGeneration: 0
  })
  assert.equal(JSON.stringify(initial).includes(temp.directory), false)

  const updates: unknown[] = []
  const unsubscribe = options.subscribe(snapshot => updates.push(snapshot))
  await options.applyVideoFolder(emptyRoot)
  assert.deepEqual(readVideoLibraryConfiguration(temp.directory).roots, [emptyRoot])
  assert.deepEqual(options.getSnapshot().library, { folderName: 'empty', scanStatus: 'ready', indexedFiles: 0 })
  assert.ok(updates.some(value => (value as { library: { scanStatus: string } }).library.scanStatus === 'scanning'),
    'the service publishes its real in-progress library state before the scan completes.')

  await options.applyVideoFolder(unavailableRoot)
  assert.deepEqual(readVideoLibraryConfiguration(temp.directory).roots, [unavailableRoot],
    'the unavailable folder remains configured rather than restoring an older library.')
  assert.deepEqual(options.getSnapshot().library, {
    folderName: 'removed-drive', scanStatus: 'degraded', indexedFiles: null
  })
  await options.refreshVideoLibrary()
  assert.equal(options.getSnapshot().library.scanStatus, 'degraded', 'retry retains the degraded root state.')
  unsubscribe()
  assert.ok(updates.length >= 4)
})

test('availability changes publish to options subscribers and reconnection refreshes without losing the chosen root', async t => {
  const temp = temporaryDirectory()
  const root = path.join(temp.directory, 'usb-library')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, '00123.mp4'), '')
  const library = new VideoLibraryService([root])
  await library.refresh()
  const database = createPlayerMusicCatalogDatabase(temp.directory)
  const catalog = new MusicCatalogService(database, library)
  const options = new StandalonePlayerOptionsService({ library, catalog, userDataDirectory: temp.directory,
    dialogs: { chooseVideoFolder: async () => null, chooseCatalogFile: async () => null } })
  t.after(async () => {
    options.dispose()
    await catalog.close()
    database.close()
    library.close()
    temp.cleanup()
  })
  const updates: string[] = []
  const unsubscribe = options.subscribe(snapshot => updates.push(snapshot.library.scanStatus))
  fs.rmSync(root, { recursive: true, force: true })
  await library.probeAvailability()
  assert.equal(options.getSnapshot().library.scanStatus, 'degraded')
  assert.ok(updates.includes('degraded'), 'the UI-facing subscription observes the unavailable root')
  assert.deepEqual(library.roots, [root], 'temporary device loss does not discard the selected library configuration')

  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, '00123.mp4'), 'restored')
  await library.probeAvailability()
  await library.refresh()
  assert.equal(options.getSnapshot().library.scanStatus, 'ready')
  assert.ok(updates.includes('ready'), 'reconnection publishes the reconciled current snapshot')
  unsubscribe()
})

test('catalog import snapshots include only the selected filename and committed metadata', async t => {
  const temp = temporaryDirectory()
  let library: VideoLibraryService | undefined
  let database: ReturnType<typeof createPlayerMusicCatalogDatabase> | undefined
  let catalog: MusicCatalogService | undefined
  let options: StandalonePlayerOptionsService | undefined
  t.after(async () => {
    options?.dispose()
    await catalog?.close()
    library?.close()
    database?.close()
    temp.cleanup()
  })
  const root = path.join(temp.directory, 'videos')
  fs.mkdirSync(root)
  library = new VideoLibraryService([root])
  await library.refresh()
  database = createPlayerMusicCatalogDatabase(temp.directory)
  catalog = new MusicCatalogService(database, library)
  const csvPath = path.join(temp.directory, 'approved-catalog.csv')
  fs.writeFileSync(csvPath, 'artista;numero;nome_musica\nBon Jovi;1001;Always\n')
  options = new StandalonePlayerOptionsService({
    library,
    catalog,
    userDataDirectory: temp.directory,
    dialogs: { chooseVideoFolder: async () => null, chooseCatalogFile: async () => csvPath }
  })
  t.after(() => options.dispose())

  const prepared = await options.prepareCatalogImport(await options.chooseCatalogFile() as string)
  assert.equal(prepared.outcome, 'imported')
  const snapshot = options.getSnapshot()
  assert.equal(snapshot.catalog.fileName, 'approved-catalog.csv')
  assert.equal(snapshot.catalog.recordCount, 1)
  assert.ok(snapshot.catalog.importedAt)
  assert.equal(snapshot.catalog.importIssueCount, 0)
  assert.equal(snapshot.catalog.importGeneration, 1)
  assert.equal(JSON.stringify(snapshot).includes(temp.directory), false, 'catalog paths remain Main-side.')
  assert.equal(catalog.lookupMetadataByVideoCode('01001').title, 'Always')

  // Windows separators must not leak if a source name is read on a different OS.
  const foreignPathCatalog = parseMusicCatalogCsv('artista;numero;nome_musica\nBon Jovi;1001;Always\n')
  database.replaceMusicCatalog(foreignPathCatalog.records, {
    revision: foreignPathCatalog.revision,
    importedAt: new Date().toISOString(),
    sourceName: 'C:\\Private\\music.csv'
  })
  assert.equal(options.getSnapshot().catalog.fileName, 'music.csv')
  assert.equal(JSON.stringify(options.getSnapshot()).includes('Private'), false)
})

test('partial Standalone catalog imports require confirmation, preserve cancel, and persist bounded issue reports', async t => {
  const temp = temporaryDirectory()
  const libraryRoot = path.join(temp.directory, 'videos')
  fs.mkdirSync(libraryRoot)
  const library = new VideoLibraryService([libraryRoot])
  const database = createPlayerMusicCatalogDatabase(temp.directory)
  const catalog = new MusicCatalogService(database, library)
  const options = new StandalonePlayerOptionsService({
    library,
    catalog,
    userDataDirectory: temp.directory,
    dialogs: { chooseVideoFolder: async () => null, chooseCatalogFile: async () => null }
  })
  let manuallyClosed = false
  t.after(async () => {
    if (!manuallyClosed) {
      options.dispose()
      await catalog.close()
      library.close()
      database.close()
    }
    temp.cleanup()
  })

  const originalPath = path.join(temp.directory, 'original.csv')
  fs.writeFileSync(originalPath, 'artista;numero;nome_musica\nQueen;2000;Antigo\n')
  await catalog.importFile(originalPath)
  const originalMetadata = database.getMusicCatalogMetadata()
  const originalGeneration = options.getSnapshot().catalog.importGeneration

  const lines = ['artista;numero;nome_musica']
  for (let musicNumber = 1; musicNumber <= 133; musicNumber++) {
    lines.push(`Artista ${musicNumber};${musicNumber};Música ${musicNumber}`)
  }
  lines.push('Inválido;78952770;Não truncar')
  lines.push('ABBA;1001;Dancing Queen')
  const partialPath = path.join(temp.directory, 'partial.csv')
  fs.writeFileSync(partialPath, `${lines.join('\n')}\n`)

  const preview = await catalog.prepareStandaloneImport(partialPath)
  assert.equal(preview.outcome, 'confirmation-required')
  if (preview.outcome !== 'confirmation-required') return
  assert.equal(preview.recordCount, 134)
  assert.equal(preview.issueCount, 1)
  assert.equal(preview.currentRecordCount, 1)
  assert.deepEqual(database.getMusicCatalogMetadata(), originalMetadata,
    'preparing a partial import does not modify the committed catalog.')

  assert.equal(catalog.cancelStandaloneImport(preview.token), true)
  assert.deepEqual(database.getMusicCatalogMetadata(), originalMetadata,
    'canceling keeps catalog records and import metadata unchanged.')
  assert.deepEqual(options.getSnapshot().catalog, {
    fileName: 'original.csv', recordCount: 1, importedAt: originalMetadata.importedAt,
    revision: originalMetadata.revision, importIssueCount: 0, importGeneration: originalGeneration
  })

  const secondPreview = await catalog.prepareStandaloneImport(partialPath)
  assert.equal(secondPreview.outcome, 'confirmation-required')
  if (secondPreview.outcome !== 'confirmation-required') return
  const confirmed = await catalog.confirmStandaloneImport(secondPreview.token)
  assert.equal(confirmed.recordCount, 134)
  assert.equal(confirmed.issueCount, 1)
  assert.equal(catalog.lookupMetadataByVideoCode('01001').title, 'Dancing Queen')
  const optionsAfterCommit = options.getSnapshot().catalog
  assert.equal(optionsAfterCommit.fileName, 'partial.csv')
  assert.equal(optionsAfterCommit.recordCount, 134)
  assert.equal(optionsAfterCommit.importIssueCount, 1)
  assert.equal(optionsAfterCommit.importGeneration, originalGeneration + 1)
  const report = catalog.getStandaloneImportIssuePage(0, 50)
  assert.equal(report.catalogRevision, optionsAfterCommit.revision)
  assert.equal(report.generation, optionsAfterCommit.importGeneration)
  assert.equal(report.total, 1)
  assert.deepEqual(report.issues[0], {
    rowNumber: 135, field: 'numero', value: '78952770', code: 'INVALID_MUSIC_NUMBER',
    reason: 'O código deve conter de 1 a 5 dígitos, sem zero inicial.'
  })

  options.dispose()
  await catalog.close()
  database.close()
  manuallyClosed = true
  const reopenedDatabase = createPlayerMusicCatalogDatabase(temp.directory)
  const reopenedCatalog = new MusicCatalogService(reopenedDatabase, library)
  try {
    assert.equal(reopenedCatalog.getMetadata().recordCount, 134)
    assert.equal(reopenedCatalog.lookupMetadataByVideoCode('01001').title, 'Dancing Queen')
    assert.deepEqual(reopenedCatalog.getStandaloneImportIssuePage(0, 50), report,
      'the confirmed issue report remains tied to the persisted catalog after restart.')
  } finally {
    await reopenedCatalog.close()
    reopenedDatabase.close()
  }
})

test('stale partial confirmations cannot replace a later catalog generation', async t => {
  const temp = temporaryDirectory()
  const libraryRoot = path.join(temp.directory, 'videos')
  fs.mkdirSync(libraryRoot)
  const library = new VideoLibraryService([libraryRoot])
  const database = createPlayerMusicCatalogDatabase(temp.directory)
  const catalog = new MusicCatalogService(database, library)
  t.after(async () => {
    await catalog.close()
    library.close()
    database.close()
    temp.cleanup()
  })
  const oldPath = path.join(temp.directory, 'old.csv')
  const partialPath = path.join(temp.directory, 'partial.csv')
  fs.writeFileSync(oldPath, 'artista;numero;nome_musica\nQueen;2000;Antigo\n')
  fs.writeFileSync(partialPath, 'artista;numero;nome_musica\nInválido;78952770;Ignorado\nABBA;1001;Dancing Queen\n')
  await catalog.importFile(oldPath)
  const prepared = await catalog.prepareStandaloneImport(partialPath)
  assert.equal(prepared.outcome, 'confirmation-required')
  if (prepared.outcome !== 'confirmation-required') return

  const newer = parseMusicCatalogCsv('artista;numero;nome_musica\nMadonna;3000;Vogue\n')
  database.replaceMusicCatalog(newer.records, {
    revision: newer.revision,
    importedAt: new Date().toISOString(),
    sourceName: 'newer.csv'
  })
  await assert.rejects(catalog.confirmStandaloneImport(prepared.token), (error: unknown) => {
    assert.ok(error instanceof MusicCatalogError)
    assert.equal(error.code, 'CATALOG_CHANGED_DURING_CONFIRMATION')
    return true
  })
  assert.equal(catalog.lookupMetadataByVideoCode('03000').title, 'Vogue')
  assert.equal(catalog.getStandaloneImportIssuePage(0, 10).total, 0)
})
