import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createKaraokeDatabase, createPlayerMusicCatalogDatabase } from '../database'
import { MusicCatalogError, normalizeCatalogCodeForVideoMatch, parseMusicCatalogCsv } from '../src/music-catalog'
import { MusicCatalogService } from '../src/music-catalog-service'
import { VideoLibraryService } from '../src/video-library-service'

function temporaryDirectory(): { directory: string; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-music-catalog-'))
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

function writeCsv(directory: string, name: string, content: string | Buffer): string {
  const filePath = path.join(directory, name)
  fs.writeFileSync(filePath, content)
  return filePath
}

function csvRow(number: string, artist: string, title: string): string {
  const quote = (value: string) => /[",;\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  return [quote(artist), quote(number), quote(title)].join(';')
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

function catalogCsv(rows: Array<[string, string, string]>, delimiter = ';'): string {
  const quote = (value: string) => /[",;\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  return ['artista', 'numero', 'nome_musica'].join(delimiter) + '\n' + rows
    .map(row => row.map(quote).join(delimiter)).join('\n') + '\n'
}

function assertCatalogError(action: () => unknown, expectedCode?: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof MusicCatalogError)
    assert.equal(typeof error.code, 'string')
    if (expectedCode) assert.equal(error.code, expectedCode)
    return true
  })
}

async function makeCatalog(directory: string, library?: VideoLibraryService): Promise<{
  database: ReturnType<typeof createKaraokeDatabase>
  service: MusicCatalogService
}> {
  const database = createKaraokeDatabase(directory)
  const service = new MusicCatalogService(database, library)
  return { database, service }
}

test('parses UTF-8 BOM, semicolons, commas, escaped quotes, multiline fields and optional metadata', () => {
  const input = Buffer.from(
    '\uFEFFartista;numero;nome_musica\r\n' +
    '"João, Trio";123;"Clássica; Ao Vivo"\r\n' +
    'Queen;1001;"Bohemian ""Live"" Rhapsody"\r\n' +
    'Artista;23242;"Canção\r\nacústica"\r\n' +
    ';1;\r\n' +
    'Artista;2;Título\r\n',
    'utf8'
  )
  const parsed = parseMusicCatalogCsv(input)

  assert.equal(parsed.delimiter, ';')
  assert.equal(parsed.recordCount, 5)
  assert.equal(parsed.revision.length, 64)
  assert.deepEqual(parsed.records.map(record => [record.musicNumber, record.videoCode, record.artist, record.title]), [
    ['123', '00123', 'João, Trio', 'Clássica; Ao Vivo'],
    ['1001', '01001', 'Queen', 'Bohemian "Live" Rhapsody'],
    ['23242', '23242', 'Artista', 'Canção acústica'],
    ['1', '00001', null, null],
    ['2', '00002', 'Artista', 'Título']
  ])
  assert.equal(parsed.records[0].normalizedArtist, 'joao, trio')
  assert.equal(parsed.records[0].normalizedTitle, 'classica; ao vivo')
  assert.equal(parsed.records[3].normalizedArtist, '')
  assert.equal(parsed.warnings.length, 2)
  assert.equal(parsed.warningCount, 2)
  assert.deepEqual(parsed.warnings, [
    { code: 'MISSING_ARTIST', rowNumber: 6, field: 'artista' },
    { code: 'MISSING_TITLE', rowNumber: 6, field: 'nome_musica' }
  ])
})

test('detects comma delimiter from the required header without confusing embedded commas', () => {
  const parsed = parseMusicCatalogCsv(Buffer.from(
    'artista,numero,nome_musica\n"Bon Jovi, Band",1001,"Always, (live)"\n', 'utf8'))
  assert.equal(parsed.delimiter, ',')
  assert.deepEqual(parsed.records.map(record => [record.musicNumber, record.videoCode, record.artist, record.title]), [
    ['1001', '01001', 'Bon Jovi, Band', 'Always, (live)']
  ])
})

test('normalizes supported CSV music codes without numeric conversion or changing their original form', () => {
  for (const [source, expected] of [
    ['1', '00001'], ['123', '00123'], ['1001', '01001'], ['9999', '09999'], ['23242', '23242']
  ]) {
    assert.equal(normalizeCatalogCodeForVideoMatch(source), expected)
  }
  for (const invalid of ['', '0', '00', '01', '00001', '100000', '１２３', ' 123', '123 ']) {
    assertCatalogError(() => normalizeCatalogCodeForVideoMatch(invalid))
  }
  assert.equal(parseMusicCatalogCsv('artista;numero;nome_musica\nA;1001;Always\n').records[0].musicNumber, '1001')
})

test('rejects invalid headers, duplicate codes, empty catalogs, malformed quotes and wrong column counts', () => {
  const invalidCatalogs = [
    '',
    'artista;numero;nome_musica\n',
    'artist;number;title\nA;1;Song\n',
    'artista;numero;numero\nA;1;Song\n',
    'artista;numero;nome_musica\nA;1;Song\nB;1;Dupe\n',
    'artista;numero;nome_musica\nA;1\n',
    'artista;numero;nome_musica\nA;1;Song;unexpected\n',
    'artista;numero,nome_musica\nA;1;Song\n',
    'artista;numero;nome_musica\nA;1;"unterminated\n',
    'artista;numero;nome_musica\nA;1;"closed"oops\n',
    'artista;numero;nome_musica\nA;01;Song\n',
    'artista;numero;nome_musica\nA;00001;Song\n',
    'artista;numero;nome_musica\nA;100000;Song\n',
    'artista;numero;nome_musica\nA;١٢٣;Song\n'
  ]
  for (const source of invalidCatalogs) {
    assertCatalogError(() => parseMusicCatalogCsv(source))
  }

  const invalidUtf8 = Buffer.from([0x61, 0x72, 0x74, 0x69, 0x73, 0x74, 0x61, 0x3b, 0x6e, 0x75, 0x6d, 0x65, 0x72, 0x6f, 0x3b, 0x6e, 0x6f, 0x6d, 0x65, 0x5f, 0x6d, 0x75, 0x73, 0x69, 0x63, 0x61, 0x0a, 0xff, 0x3b, 0x31, 0x3b, 0x78])
  assertCatalogError(() => parseMusicCatalogCsv(invalidUtf8))
})

test('rejects excessive file, field and record sizes before persistence', () => {
  const overlongField = `artista;numero;nome_musica\nA;1;${'x'.repeat(4097)}\n`
  assertCatalogError(() => parseMusicCatalogCsv(overlongField), 'FIELD_TOO_LARGE')

  const tooManyRecords = 'artista;numero;nome_musica\n' + 'A;1;Song\n'.repeat(100_001)
  assertCatalogError(() => parseMusicCatalogCsv(tooManyRecords), 'TOO_MANY_RECORDS')

  assertCatalogError(() => parseMusicCatalogCsv(Buffer.alloc(32 * 1024 * 1024 + 1)), 'FILE_TOO_LARGE')
})

test('preserves formula-like and markup-like fields as ordinary text', () => {
  const parsed = parseMusicCatalogCsv(catalogCsv([
    ['=HYPERLINK("x")', '1', '<script>alert(1)</script>']
  ]))
  assert.equal(parsed.records[0].artist, '=HYPERLINK("x")')
  assert.equal(parsed.records[0].title, '<script>alert(1)</script>')
})

test('returns row-level warnings for optional metadata during import', async () => {
  const temp = temporaryDirectory()
  const file = writeCsv(temp.directory, 'catalog.csv', catalogCsv([
    ['', '1', ''], ['Queen', '2', ''], ['', '3', 'Dancing Queen']
  ]))
  const { database, service } = await makeCatalog(temp.directory)
  try {
    const imported = await service.importFile(file)
    assert.equal(imported.recordCount, 3)
    assert.equal(imported.missingArtistCount, 2)
    assert.equal(imported.missingTitleCount, 2)
    assert.equal(imported.warningCount, 4)
    assert.deepEqual(imported.warnings, [
      { code: 'MISSING_ARTIST', rowNumber: 2, field: 'artista' },
      { code: 'MISSING_TITLE', rowNumber: 2, field: 'nome_musica' },
      { code: 'MISSING_TITLE', rowNumber: 3, field: 'nome_musica' },
      { code: 'MISSING_ARTIST', rowNumber: 4, field: 'artista' }
    ])
  } finally {
    await service.close()
    database.close()
    temp.cleanup()
  }
})

test('first import persists records and revision through the real SQLite repository', async () => {
  const temp = temporaryDirectory()
  const file = writeCsv(temp.directory, 'catalog.csv', catalogCsv([
    ['Queen', '123', 'Bohemian Rhapsody'], ['Bon Jovi', '1001', 'Always']
  ]))
  const { database, service } = await makeCatalog(temp.directory)
  try {
    const imported = await service.importFile(file)
    assert.equal(imported.recordCount, 2)
    assert.equal(imported.missingArtistCount, 0)
    assert.equal(imported.missingTitleCount, 0)
    assert.equal(imported.warningCount, 0)
    assert.deepEqual(imported.warnings, [])
    assert.equal(imported.revision.length, 64)
    assert.ok(Number.isFinite(Date.parse(imported.importedAt)))

    const result = await service.search('bohemian', { limit: 10, offset: 0 })
    assert.equal(result.catalogRevision, imported.revision)
    assert.equal(result.total, 1)
    assert.equal(result.items[0].musicNumber, '123')
    assert.equal(result.items[0].videoCode, '00123')
    assert.equal(result.items[0].artist, 'Queen')
    assert.equal(result.items[0].title, 'Bohemian Rhapsody')
    assert.equal(result.items[0].metadataAvailable, true)
    assert.equal(result.items[0].videoAvailability, 'unknown')
    assert.equal(database.getMusicCatalogMetadata().revision, imported.revision)

    await service.close()
    database.close()
    const reopened = await makeCatalog(temp.directory)
    try {
      const persisted = await reopened.service.search('01001', { limit: 10, offset: 0 })
      assert.equal(persisted.catalogRevision, imported.revision)
      assert.equal(persisted.items[0].musicNumber, '1001')
      assert.equal(persisted.items[0].videoCode, '01001')
    } finally {
      await reopened.service.close()
      reopened.database.close()
    }
  } finally {
    await service.close().catch(() => undefined)
    try { database.close() } catch {}
    temp.cleanup()
  }
})

test('reimport replaces all metadata atomically and preserves operational queue, sessions and history', async () => {
  const temp = temporaryDirectory()
  const firstFile = writeCsv(temp.directory, 'first.csv', catalogCsv([
    ['Artista Antigo', '1', 'Título antigo'], ['Outro', '2', 'Outro antigo']
  ]))
  const secondFile = writeCsv(temp.directory, 'second.csv', catalogCsv([
    ['Bon Jovi', '1001', 'Always'], ['', '23242', 'Dancing Song']
  ]))
  const database = createKaraokeDatabase(temp.directory)
  const service = new MusicCatalogService(database)
  const operationalState: AppState = {
    queue: [{ id: 'pending-1', name: 'Cantora', songNumber: '1', songNumber2: '2', table: '4', insertedAt: 1, status: 'pending', sessionId: 'session-1' }],
    history: [{ id: 'done-1', name: 'Cantora antiga', songNumber: '3', songNumber2: '', table: '4', insertedAt: 2, status: 'done', sessionId: 'session-1', doneAt: 3 }],
    sessions: [{ id: 'session-1', startedAt: 1, endedAt: null }], currentSessionId: 'session-1',
    priorityIds: ['pending-1'], fixedTurnPositions: { 'pending-1': 0 }, frozenTurnIds: ['pending-1'],
    queueOrderPolicyVersion: 1, regularsSinceDebut: 1, currentTurnAutomatic: false,
    nextTurnId: 'pending-1', currentTurnId: 'pending-1', lastReset: null,
    trialStartedAt: 1, licenseActivated: false
  }
  try {
    database.saveState(operationalState)
    const stateBefore = database.loadState()
    const firstImport = await service.importFile(firstFile)
    const secondImport = await service.importFile(secondFile)
    assert.notEqual(secondImport.revision, firstImport.revision)
    assert.equal(secondImport.recordCount, 2)

    const removed = await service.search('antigo', { limit: 10, offset: 0 })
    assert.equal(removed.total, 0)
    const replaced = await service.search('1001', { limit: 10, offset: 0 })
    assert.equal(replaced.total, 1)
    assert.equal(replaced.items[0].artist, 'Bon Jovi')
    assert.equal(replaced.items[0].videoAvailability, 'unknown')
    assert.deepEqual(database.loadState(), stateBefore,
      'catalog replacement must not alter sessions, queue, history, pins, frozen turns or cadence')
  } finally {
    await service.close()
    database.close()
    temp.cleanup()
  }
})

test('invalid replacement keeps the prior catalog revision and records unchanged', async () => {
  const temp = temporaryDirectory()
  const validFile = writeCsv(temp.directory, 'valid.csv', catalogCsv([['Queen', '123', 'Song']]))
  const invalidFile = writeCsv(temp.directory, 'invalid.csv', catalogCsv([['Invalid', '01', 'Code']]))
  const { database, service } = await makeCatalog(temp.directory)
  try {
    const valid = await service.importFile(validFile)
    const before = await service.search('Queen', { limit: 20, offset: 0 })
    await assert.rejects(service.importFile(invalidFile), MusicCatalogError)
    const after = await service.search('queen', { limit: 20, offset: 0 })
    assert.equal(after.catalogRevision, valid.revision)
    assert.deepEqual(after.items, before.items)
    assert.deepEqual(database.getMusicCatalogMetadata(), {
      revision: valid.revision,
      importedAt: valid.importedAt,
      recordCount: 1,
      sourceName: 'valid.csv'
    })
  } finally {
    await service.close()
    database.close()
    temp.cleanup()
  }
})

test('rejects non-regular and oversized selected files without replacing catalog metadata', async () => {
  const temp = temporaryDirectory()
  const validFile = writeCsv(temp.directory, 'valid.csv', catalogCsv([['Queen', '123', 'Song']]))
  const oversizedFile = path.join(temp.directory, 'oversized.csv')
  const descriptor = fs.openSync(oversizedFile, 'w')
  fs.ftruncateSync(descriptor, 32 * 1024 * 1024 + 1)
  fs.closeSync(descriptor)
  const { database, service } = await makeCatalog(temp.directory)
  try {
    const imported = await service.importFile(validFile)
    await assert.rejects(service.importFile(temp.directory), (error: unknown) =>
      error instanceof MusicCatalogError && error.code === 'UNSAFE_FILE')
    await assert.rejects(service.importFile(oversizedFile), (error: unknown) =>
      error instanceof MusicCatalogError && error.code === 'FILE_TOO_LARGE')
    assert.equal(database.getMusicCatalogMetadata().revision, imported.revision)
    const after = await service.search('queen', { limit: 10, offset: 0 })
    assert.equal(after.total, 1)
    assert.equal(after.items[0].musicNumber, '123')
  } finally {
    await service.close()
    database.close()
    temp.cleanup()
  }
})

test('rejects a CSV that changes while being read and preserves the active catalog', async () => {
  const temp = temporaryDirectory()
  const activeFile = writeCsv(temp.directory, 'active.csv', catalogCsv([['Queen', '123', 'Song']]))
  const changingFile = writeCsv(temp.directory, 'changing.csv', catalogCsv([['Artist One', '456', 'First title']]))
  const { database, service } = await makeCatalog(temp.directory)
  const originalOpen = fs.promises.open
  let changedDuringRead = false
  try {
    const active = await service.importFile(activeFile)
    fs.promises.open = async function (filePath: Parameters<typeof originalOpen>[0], ...args: any[]) {
      const handle = await originalOpen.call(fs.promises, filePath as any, ...args as any[])
      if (path.resolve(String(filePath)) !== path.resolve(changingFile)) return handle
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read') {
            return async (...readArgs: any[]) => {
              const result = await target.read(...readArgs as any[])
              if (!changedDuringRead) {
                changedDuringRead = true
                fs.writeFileSync(changingFile, catalogCsv([['Artist Two', '456', 'Second title']]))
              }
              return result
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }) as fs.promises.FileHandle
    } as typeof originalOpen

    await assert.rejects(service.importFile(changingFile), (error: unknown) =>
      error instanceof MusicCatalogError && error.code === 'FILE_CHANGED')
    assert.equal(changedDuringRead, true)
    assert.equal(database.getMusicCatalogMetadata().revision, active.revision)
    const preserved = await service.search('queen', { limit: 10, offset: 0 })
    assert.equal(preserved.total, 1)
    assert.equal(preserved.items[0].musicNumber, '123')
  } finally {
    fs.promises.open = originalOpen
    await service.close()
    database.close()
    temp.cleanup()
  }
})

test('a SQLite failure during replacement rolls back rows and revision without changing operational state', async () => {
  const temp = temporaryDirectory()
  const firstFile = writeCsv(temp.directory, 'before.csv', catalogCsv([
    ['Before', '111', 'First'], ['Before', '222', 'Second']
  ]))
  const replacementFile = writeCsv(temp.directory, 'after.csv', catalogCsv([
    ['After', '333', 'Inserted before failure'], ['After', '444', 'Constraint failure']
  ]))
  const { database, service } = await makeCatalog(temp.directory)
  try {
    database.saveState({
      queue: [], history: [], sessions: [{ id: 's1', startedAt: 1, endedAt: null }], currentSessionId: 's1',
      priorityIds: [], fixedTurnPositions: {}, frozenTurnIds: [], queueOrderPolicyVersion: 1,
      regularsSinceDebut: 2, currentTurnAutomatic: true, nextTurnId: null, currentTurnId: null,
      lastReset: null, trialStartedAt: 1, licenseActivated: false
    } as AppState)
    const operationalBefore = database.loadState()
    const firstImport = await service.importFile(firstFile)
    const before = await service.search('Before', { limit: 20, offset: 0 })
    const inspector = new DatabaseSync(database.databasePath)
    try {
      inspector.exec(`CREATE TRIGGER fail_music_catalog_insert BEFORE INSERT ON music_catalog
        WHEN NEW.music_number = '444' BEGIN SELECT RAISE(ABORT, 'injected catalog constraint failure'); END`)
      await assert.rejects(service.importFile(replacementFile))
      inspector.exec('DROP TRIGGER fail_music_catalog_insert')
    } finally { inspector.close() }

    const after = await service.search('before', { limit: 20, offset: 0 })
    assert.equal(after.catalogRevision, firstImport.revision)
    assert.deepEqual(after.items, before.items)
    assert.deepEqual(database.loadState(), operationalBefore)
    await service.close()
    database.close()

    const reopened = await makeCatalog(temp.directory)
    try {
      const reopenedSearch = await reopened.service.search('Before', { limit: 20, offset: 0 })
      assert.equal(reopenedSearch.catalogRevision, firstImport.revision)
      assert.deepEqual(reopenedSearch.items, before.items)
      assert.deepEqual(reopened.database.loadState(), operationalBefore)
    } finally {
      await reopened.service.close()
      reopened.database.close()
    }
  } finally {
    await service.close().catch(() => undefined)
    try { database.close() } catch {}
    temp.cleanup()
  }
})

test('imports serialize by invocation order and searches observe one committed catalog revision', async () => {
  const temp = temporaryDirectory()
  const baselineFile = writeCsv(temp.directory, 'baseline.csv', catalogCsv([['Baseline', '1', 'Old catalog']]))
  const firstFile = writeCsv(temp.directory, 'first.csv', catalogCsv([['First', '2', 'Older request']]))
  const secondFile = writeCsv(temp.directory, 'second.csv', catalogCsv([['Second', '3', 'Newer request']]))
  const { database, service } = await makeCatalog(temp.directory)
  const originalOpen = fs.promises.open
  const firstReadStarted = deferred<void>()
  const releaseFirstRead = deferred<void>()
  const secondReadStarted = deferred<void>()
  try {
    const baseline = await service.importFile(baselineFile)
    fs.promises.open = async function (filePath: Parameters<typeof originalOpen>[0], ...args: any[]) {
      const resolvedPath = path.resolve(String(filePath))
      if (resolvedPath === path.resolve(firstFile)) {
        firstReadStarted.resolve()
        await releaseFirstRead.promise
      }
      if (resolvedPath === path.resolve(secondFile)) secondReadStarted.resolve()
      return originalOpen.call(fs.promises, filePath as any, ...args as any)
    } as typeof originalOpen

    const firstImport = service.importFile(firstFile)
    await firstReadStarted.promise
    const secondImport = service.importFile(secondFile)

    const secondStartedBeforeRelease = await Promise.race([
      secondReadStarted.promise.then(() => true),
      new Promise<boolean>(resolve => setImmediate(() => resolve(false)))
    ])
    assert.equal(secondStartedBeforeRelease, false,
      'a later request must not start its file read before the earlier admitted import')

    const whileFirstReading = await service.search('baseline', { limit: 10, offset: 0 })
    assert.equal(whileFirstReading.catalogRevision, baseline.revision)
    assert.deepEqual(whileFirstReading.items.map(item => item.musicNumber), ['1'])

    releaseFirstRead.resolve()
    const [firstResult, secondResult] = await Promise.all([firstImport, secondImport])
    assert.notEqual(firstResult.revision, baseline.revision)
    assert.notEqual(secondResult.revision, firstResult.revision)
    const finalSearch = await service.search('newer request', { limit: 10, offset: 0 })
    assert.equal(finalSearch.catalogRevision, secondResult.revision)
    assert.deepEqual(finalSearch.items.map(item => item.musicNumber), ['3'])
    assert.equal(database.getMusicCatalogMetadata().revision, secondResult.revision)
  } finally {
    releaseFirstRead.resolve()
    fs.promises.open = originalOpen
    await service.close().catch(() => undefined)
    database.close()
    temp.cleanup()
  }
})

test('shutdown waits for an admitted import and rejects new requests before database close', async () => {
  const temp = temporaryDirectory()
  const file = writeCsv(temp.directory, 'catalog.csv', catalogCsv([['Queen', '123', 'Song']]))
  const { database, service } = await makeCatalog(temp.directory)
  const originalOpen = fs.promises.open
  const readStarted = deferred<void>()
  const releaseRead = deferred<void>()
  try {
    fs.promises.open = async function (filePath: Parameters<typeof originalOpen>[0], ...args: any[]) {
      if (path.resolve(String(filePath)) === path.resolve(file)) {
        readStarted.resolve()
        await releaseRead.promise
      }
      return originalOpen.call(fs.promises, filePath as any, ...args as any)
    } as typeof originalOpen

    const admittedImport = service.importFile(file)
    await readStarted.promise
    const closing = service.close()
    await assert.rejects(service.importFile(file), (error: unknown) =>
      error instanceof MusicCatalogError && error.code === 'CATALOG_CLOSED')
    let closeFinished = false
    void closing.then(() => { closeFinished = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(closeFinished, false, 'close must wait for already admitted import work')

    releaseRead.resolve()
    const imported = await admittedImport
    await closing
    assert.equal(database.getMusicCatalogMetadata().revision, imported.revision)
    assert.throws(() => service.search('Song', { limit: 10, offset: 0 }), MusicCatalogError)
  } finally {
    releaseRead.resolve()
    fs.promises.open = originalOpen
    await service.close().catch(() => undefined)
    database.close()
    temp.cleanup()
  }
})

test('search is accent-insensitive, partial, literal and page-bounded with stable ordering', async () => {
  const temp = temporaryDirectory()
  const file = writeCsv(temp.directory, 'catalog.csv', catalogCsv([
    ['João  Silva', '10', 'Música Azul'], ['JOSE Da Silva', '2', 'Outra música'],
    ['José da Silva', '123', 'Canção em Português'], ['Artista', '1001', '100% _literal']
  ]))
  const { database, service } = await makeCatalog(temp.directory)
  try {
    const imported = await service.importFile(file)
    const artistMatches = await service.search('silva', { limit: 10, offset: 0 })
    assert.equal(artistMatches.total, 3)
    assert.deepEqual(artistMatches.items.map(item => item.musicNumber), ['2', '10', '123'])
    const titleMatches = await service.search('portugue', { limit: 10, offset: 0 })
    assert.deepEqual(titleMatches.items.map(item => item.musicNumber), ['123'])

    const firstPage = await service.search('a', { limit: 2, offset: 0 })
    const secondPage = await service.search('a', { limit: 2, offset: 2 })
    assert.equal(firstPage.catalogRevision, imported.revision)
    assert.equal(firstPage.limit, 2)
    assert.equal(firstPage.offset, 0)
    assert.equal(firstPage.hasMore, true)
    assert.equal(secondPage.offset, 2)
    assert.equal(secondPage.hasMore, false)
    assert.deepEqual([...firstPage.items, ...secondPage.items].map(item => item.musicNumber), ['2', '10', '123', '1001'])

    const percentSearch = await service.search('%', { limit: 10, offset: 0 })
    assert.deepEqual(percentSearch.items.map(item => item.musicNumber), ['1001'],
      'percent must match the literal percent in metadata rather than act as a wildcard')
    const underscoreSearch = await service.search('_', { limit: 10, offset: 0 })
    assert.deepEqual(underscoreSearch.items.map(item => item.musicNumber), ['1001'],
      'underscore must match the literal underscore in metadata rather than act as a wildcard')
    assert.equal((await service.search('', { limit: 10, offset: 0 })).total, 0,
      'an empty query must not return the entire catalog')
    const exactCatalogCode = await service.search('1001', { limit: 10, offset: 0 })
    assert.deepEqual(exactCatalogCode.items.map(item => item.musicNumber), ['1001'])
    const paddedCode = await service.search('01001', { limit: 10, offset: 0 })
    assert.deepEqual(paddedCode.items.map(item => item.musicNumber), ['1001'])
    assert.throws(() => service.search('x', { limit: 1000000, offset: 0 }), MusicCatalogError)
    assert.equal(database.getMusicCatalogMetadata().revision, imported.revision)
  } finally {
    await service.close()
    database.close()
    temp.cleanup()
  }
})

test('Combined joins canonical codes to the independent video snapshot without storing media availability', async () => {
  const temp = temporaryDirectory()
  const mediaRoot = path.join(temp.directory, 'media')
  fs.mkdirSync(mediaRoot)
  fs.writeFileSync(path.join(mediaRoot, '01001.mp4'), '')
  fs.writeFileSync(path.join(mediaRoot, '00077 - no metadata.MKV'), '')
  fs.writeFileSync(path.join(mediaRoot, '00123.mp4'), '')
  fs.writeFileSync(path.join(mediaRoot, '00123 - duplicate.avi'), '')
  fs.writeFileSync(path.join(mediaRoot, '00042.txt'), '')
  const library = new VideoLibraryService([mediaRoot])
  const file = writeCsv(temp.directory, 'catalog.csv', catalogCsv([
    ['Bon Jovi', '1001', 'Always'], ['', '42', 'Song without video']
  ]))
  const { database, service } = await makeCatalog(temp.directory, library)
  try {
    const inventory = await library.refresh()
    const imported = await service.importFile(file)

    const available = await service.lookupByVideoCode('1001')
    assert.equal(available.musicNumber, '1001')
    assert.equal(available.videoCode, '01001')
    assert.equal(available.artist, 'Bon Jovi')
    assert.equal(available.videoAvailability, 'available')
    assert.equal(available.catalogRevision, imported.revision)
    assert.equal(available.inventoryRevision, inventory.revision)

    const videoOnly = await service.lookupByVideoCode('00077')
    assert.equal(videoOnly.musicNumber, null)
    assert.equal(videoOnly.artist, null)
    assert.equal(videoOnly.title, null)
    assert.equal(videoOnly.metadataAvailable, false)
    assert.equal(videoOnly.videoAvailability, 'available')

    const catalogOnly = await service.lookupByVideoCode('42')
    assert.equal(catalogOnly.musicNumber, '42')
    assert.equal(catalogOnly.videoCode, '00042')
    assert.equal(catalogOnly.metadataAvailable, true)
    assert.equal(catalogOnly.videoAvailability, 'missing')

    const ambiguous = await service.lookupByVideoCode('123')
    assert.equal(ambiguous.videoAvailability, 'ambiguous')
    assert.equal((await service.search('Always', { limit: 10, offset: 0 })).items[0].videoAvailability, 'available')
    assert.equal(JSON.stringify(available).includes(mediaRoot), false,
      'combined results must not expose absolute media paths')
    assert.equal(database.getMusicCatalogMetadata().revision, imported.revision,
      'inventory association must not persist video state into the catalog')
  } finally {
    await service.close()
    database.close()
    library.close()
    temp.cleanup()
  }
})

test('Controller-only availability is unknown and inventory changes do not alter the catalog revision', async () => {
  const temp = temporaryDirectory()
  const file = writeCsv(temp.directory, 'catalog.csv', catalogCsv([['Queen', '123', 'Song']]))
  const { database, service } = await makeCatalog(temp.directory)
  try {
    const imported = await service.importFile(file)
    assert.equal((await service.lookupByVideoCode('00123')).videoAvailability, 'unknown')
    const before = await service.search('Queen', { limit: 10, offset: 0 })
    assert.equal(before.inventoryStatus, 'unavailable')
    assert.equal(before.inventoryRevision, null)
    assert.equal(before.catalogRevision, imported.revision)
  } finally {
    await service.close()
    database.close()
    temp.cleanup()
  }
})

test('lookup returns unknown when the Player inventory revision changes during file revalidation', async () => {
  const temp = temporaryDirectory()
  const mediaRoot = path.join(temp.directory, 'media')
  fs.mkdirSync(mediaRoot)
  const mediaFile = path.join(mediaRoot, '00123.mp4')
  fs.writeFileSync(mediaFile, '')
  const library = new VideoLibraryService([mediaRoot])
  const catalogFile = writeCsv(temp.directory, 'catalog.csv', catalogCsv([['Queen', '123', 'Song']]))
  const database = createKaraokeDatabase(temp.directory)
  let currentSnapshot = await library.refresh()
  const initialInventoryRevision = currentSnapshot.revision
  const lookupStarted = deferred<void>()
  const releaseLookup = deferred<void>()
  const provider = {
    getSnapshot: () => currentSnapshot,
    async lookup(code: string) {
      const result = await library.lookup(code)
      lookupStarted.resolve()
      await releaseLookup.promise
      return result
    }
  }
  const service = new MusicCatalogService(database, provider)
  try {
    await service.importFile(catalogFile)
    const pendingLookup = service.lookupByVideoCode('123')
    await lookupStarted.promise
    fs.unlinkSync(mediaFile)
    currentSnapshot = await library.refresh()
    releaseLookup.resolve()

    const result = await pendingLookup
    assert.equal(result.videoAvailability, 'unknown',
      'a lookup result from an older inventory revision must not be reported as current')
    assert.notEqual(currentSnapshot.revision, initialInventoryRevision)
  } finally {
    releaseLookup.resolve()
    await service.close()
    database.close()
    library.close()
    temp.cleanup()
  }
})

test('degraded inventory keeps unavailable media unknown rather than confirmed missing', async () => {
  const temp = temporaryDirectory()
  const mediaRoot = path.join(temp.directory, 'media')
  fs.mkdirSync(mediaRoot)
  fs.writeFileSync(path.join(mediaRoot, '00123.mp4'), '')
  const library = new VideoLibraryService([mediaRoot])
  const file = writeCsv(temp.directory, 'catalog.csv', catalogCsv([['Queen', '123', 'Song'], ['Other', '42', 'Missing']]))
  const { database, service } = await makeCatalog(temp.directory, library)
  try {
    await library.refresh()
    await service.importFile(file)
    assert.equal((await service.lookupByVideoCode('123')).videoAvailability, 'available')
    fs.rmSync(mediaRoot, { recursive: true, force: true })
    const degraded = await library.refresh()
    assert.equal(degraded.scanStatus, 'degraded')
    assert.equal((await service.lookupByVideoCode('123')).videoAvailability, 'unknown')
    assert.equal((await service.lookupByVideoCode('42')).videoAvailability, 'unknown')
  } finally {
    await service.close()
    database.close()
    library.close()
    temp.cleanup()
  }
})

test('Player-only catalog persists metadata in an isolated SQLite file without Controller tables', async () => {
  const temp = temporaryDirectory()
  const source = writeCsv(temp.directory, 'player-catalog.csv', catalogCsv([['Queen', '1001', 'Always']]))
  const playerDatabase = createPlayerMusicCatalogDatabase(temp.directory)
  const service = new MusicCatalogService(playerDatabase)
  try {
    assert.equal(path.basename(playerDatabase.databasePath), 'player-music-catalog.sqlite')
    assert.equal(fs.existsSync(path.join(temp.directory, 'karaoke.sqlite')), false)
    const tables = new DatabaseSync(playerDatabase.databasePath, { readOnly: true })
    try {
      const names = (tables.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
        .map(row => row.name)
      assert.deepEqual(names, ['music_catalog', 'music_catalog_metadata'])
      assert.equal(names.some(name => ['app_state', 'entries', 'sessions'].includes(name)), false)
    } finally { tables.close() }
    const imported = await service.importFile(source)
    assert.equal(imported.recordCount, 1)
    await service.close()
    playerDatabase.close()

    const reopened = createPlayerMusicCatalogDatabase(temp.directory)
    const reopenedService = new MusicCatalogService(reopened)
    try {
      const found = await reopenedService.lookupByVideoCode('1001')
      assert.equal(found.videoCode, '01001')
      assert.equal(found.metadataAvailable, true)
      assert.equal(found.artist, 'Queen')
      assert.equal(found.title, 'Always')
      assert.equal((await reopenedService.getMetadata()).recordCount, 1)
    } finally {
      await reopenedService.close()
      reopened.close()
    }
  } finally {
    await service.close().catch(() => undefined)
    try { playerDatabase.close() } catch {}
    temp.cleanup()
  }
})

test('Standalone metadata preview is exact, inventory-independent, and invalidated only after catalog commit', async () => {
  const temp = temporaryDirectory()
  const source = writeCsv(temp.directory, 'preview-catalog.csv', catalogCsv([['Bon Jovi', '1001', 'Always']]))
  const database = createPlayerMusicCatalogDatabase(temp.directory)
  const inventory = {
    getSnapshot: () => { throw new Error('metadata preview must not inspect video inventory') },
    lookup: async () => { throw new Error('metadata preview must not validate MP4 availability') }
  }
  const service = new MusicCatalogService(database, inventory)
  const revisions: Array<string | null> = []
  const unsubscribe = service.subscribeToMetadataRevision(revision => revisions.push(revision))
  try {
    assert.deepEqual(service.lookupMetadataByVideoCode('1001'), {
      catalogRevision: null, title: null, artist: null
    })
    const imported = await service.importFile(source)
    assert.deepEqual(revisions, [imported.revision], 'a revision is published only after the SQLite replacement commits')
    assert.deepEqual(service.lookupMetadataByVideoCode('1001'), {
      catalogRevision: imported.revision, title: 'Always', artist: 'Bon Jovi'
    })
    assert.deepEqual(service.lookupMetadataByVideoCode('100'), {
      catalogRevision: imported.revision, title: null, artist: null
    }, 'numeric preview uses canonical exact equality, not a catalog prefix search')
    assert.deepEqual(service.lookupMetadataByVideoCode('01001'), {
      catalogRevision: imported.revision, title: 'Always', artist: 'Bon Jovi'
    }, 'an already canonical five-digit code is matched exactly')
    assert.throws(() => service.lookupMetadataByVideoCode('0100'), MusicCatalogError)
    assert.equal(JSON.stringify(service.lookupMetadataByVideoCode('1001')).includes(temp.directory), false,
      'the preview DTO does not expose filesystem paths')
  } finally {
    unsubscribe()
    await service.close()
    database.close()
    temp.cleanup()
  }
})

test('Player-only catalog rejects a hard-link alias to the operational Controller database', () => {
  const temp = temporaryDirectory()
  const controller = createKaraokeDatabase(temp.directory)
  controller.close()
  const controllerPath = path.join(temp.directory, 'karaoke.sqlite')
  const playerCatalogPath = path.join(temp.directory, 'player-music-catalog.sqlite')
  try {
    fs.linkSync(controllerPath, playerCatalogPath)
    assert.throws(() => createPlayerMusicCatalogDatabase(temp.directory), /must not alias the Controller operational database/)
    const check = new DatabaseSync(controllerPath, { readOnly: true })
    try {
      assert.equal((check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
      assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 6)
    } finally { check.close() }
  } finally { temp.cleanup() }
})
