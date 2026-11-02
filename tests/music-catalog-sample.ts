import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createKaraokeDatabase } from '../database'
import { parseMusicCatalogCsv } from '../src/music-catalog'
import { MusicCatalogService } from '../src/music-catalog-service'
import { isSupportedVideoExtension } from '../src/video-library'
import { VideoLibraryService } from '../src/video-library-service'

function listRegularFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      const stats = fs.lstatSync(candidate)
      if (stats.isSymbolicLink()) continue
      if (stats.isDirectory()) visit(candidate)
      else if (stats.isFile()) files.push(candidate)
    }
  }
  visit(root)
  return files.sort()
}

function fileMetadata(paths: string[]): Array<[string, number, number, number]> {
  return paths.map(filePath => {
    const stats = fs.statSync(filePath)
    return [filePath, stats.size, stats.mtimeMs, stats.ctimeMs]
  })
}

async function run(): Promise<void> {
  const csvPath = process.env.KARAOKE_MUSIC_CATALOG_SAMPLE
  if (!csvPath) {
    throw new Error('Defina KARAOKE_MUSIC_CATALOG_SAMPLE com o caminho do CSV de amostra somente leitura.')
  }
  const absoluteCsvPath = path.resolve(csvPath)
  const sampleRoot = path.resolve(process.env.KARAOKE_MUSIC_CATALOG_SAMPLE_ROOT || path.dirname(absoluteCsvPath))
  const csvStats = fs.lstatSync(absoluteCsvPath)
  assert.equal(csvStats.isFile(), true, 'o CSV de amostra precisa ser um arquivo regular')
  assert.equal(csvStats.isSymbolicLink(), false, 'o CSV de amostra não deve ser um link simbólico')

  const originalFiles = listRegularFiles(sampleRoot)
  const beforeMetadata = fileMetadata(originalFiles)
  const parsed = parseMusicCatalogCsv(fs.readFileSync(absoluteCsvPath))
  assert.equal(parsed.recordCount, 13988)
  assert.equal(parsed.missingArtistCount, 2)
  assert.equal(parsed.missingTitleCount, 7)

  const videoLibrary = new VideoLibraryService([sampleRoot])
  const temporaryUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-real-catalog-sample-'))
  const database = createKaraokeDatabase(temporaryUserData)
  const catalog = new MusicCatalogService(database, videoLibrary)
  try {
    const inventory = await videoLibrary.refresh()
    const candidates = listRegularFiles(sampleRoot).filter(filePath => isSupportedVideoExtension(path.basename(filePath)))
    assert.equal(candidates.length, 21)
    assert.equal(inventory.scanStatus, 'ready')
    assert.equal(inventory.counts.availableCodes, 21)
    assert.equal(inventory.counts.ambiguousCodes, 0)

    const recordByVideoCode = new Map(parsed.records.map(record => [record.videoCode, record]))
    for (const video of inventory.items.filter(item => item.availability === 'available')) {
      const matchingRecord = recordByVideoCode.get(video.musicCode)
      assert.ok(matchingRecord, `sample video code ${video.musicCode} must match the catalog`)
    }

    const imported = await catalog.importFile(absoluteCsvPath)
    assert.equal(imported.revision, parsed.revision)
    assert.equal(imported.recordCount, 13988)
    assert.equal(imported.missingArtistCount, 2)
    assert.equal(imported.missingTitleCount, 7)
    assert.equal(imported.warningCount, 9)
    assert.equal(imported.warnings.length, 9)
    assert.ok(imported.warnings.every(warning =>
      warning.rowNumber >= 2 && warning.rowNumber <= 13989 &&
      (warning.field === 'artista' || warning.field === 'nome_musica')))
    assert.equal(database.getMusicCatalogMetadata().recordCount, 13988)

    let associatedVideos = 0
    for (const video of inventory.items.filter(item => item.availability === 'available')) {
      const associated = await catalog.lookupByVideoCode(video.musicCode)
      assert.equal(associated.videoAvailability, 'available')
      assert.equal(associated.musicNumber, recordByVideoCode.get(video.musicCode)?.musicNumber)
      associatedVideos++
    }
    assert.equal(associatedVideos, 21)

    const afterFiles = listRegularFiles(sampleRoot)
    assert.deepEqual(afterFiles, originalFiles, 'the import and scan must not create, remove or rename sample files')
    assert.deepEqual(fileMetadata(afterFiles), beforeMetadata,
      'the read-only sample CSV and media files must retain their size and timestamps')
    process.stdout.write('REAL_CATALOG PASS records=13988 missingArtist=2 missingTitle=7 videos=21 associated=21\n')
  } finally {
    await catalog.close()
    database.close()
    videoLibrary.close()
    fs.rmSync(temporaryUserData, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
