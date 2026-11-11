'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { VideoLibraryService } = require('../build/src/video-library-service.js')
const { VideoLibraryIndexStore } = require('../build/src/video-library-index-store.js')
let baselineStage = 'startup'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const FINGERPRINT_FILES = [
  'main-runtime.ts', 'package.json', 'scripts/f0-library-baseline.cjs',
  'src/f0-diagnostics.ts', 'src/main-media-runtime.ts', 'src/video-library-service.ts',
  'src/video-library-index-store.ts', 'tests/f0-diagnostics.test.ts', 'tests/main-media-runtime.test.ts',
  'tests/video-library.test.ts', 'tests/video-library-index-store.test.ts'
]

function fingerprint() {
  const hash = crypto.createHash('sha256')
  for (const relative of FINGERPRINT_FILES) {
    hash.update(relative)
    hash.update('\0')
    hash.update(require('node:fs').readFileSync(path.join(PROJECT_ROOT, relative)))
  }
  return {
    head: readGitHead(),
    sourceSha256: hash.digest('hex'),
    files: FINGERPRINT_FILES
  }
}

function readGitHead() {
  const markerPath = path.join(PROJECT_ROOT, '.git')
  const gitDirectory = fsSync.statSync(markerPath).isDirectory() ? markerPath : (() => {
    const marker = fsSync.readFileSync(markerPath, 'utf8').trim()
    if (!marker.startsWith('gitdir: ')) throw Object.assign(new Error('Git directory pointer is invalid.'), { code: 'GITDIR_INVALID' })
    return path.resolve(PROJECT_ROOT, marker.slice('gitdir: '.length))
  })()
  const head = fsSync.readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim()
  if (!head.startsWith('ref: ')) return head
  const ref = head.slice('ref: '.length)
  const refPath = path.join(gitDirectory, ref)
  if (fsSync.existsSync(refPath)) return fsSync.readFileSync(refPath, 'utf8').trim()
  const packedRefs = fsSync.readFileSync(path.join(gitDirectory, 'packed-refs'), 'utf8')
  const match = packedRefs.split(/\r?\n/).find(line => line.endsWith(` ${ref}`))
  if (!match) throw Object.assign(new Error('Git HEAD reference unavailable.'), { code: 'HEAD_UNAVAILABLE' })
  return match.split(' ')[0]
}

async function createFixture(root, count) {
  const mediaRoot = path.join(root, 'media')
  await fs.mkdir(mediaRoot)
  for (let index = 0; index < count; index++) {
    const directory = path.join(mediaRoot, `set-${String(Math.floor(index / 1000)).padStart(2, '0')}`)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, `${String(index % 100000).padStart(5, '0')}.mp4`), Buffer.alloc(0), { flag: 'wx' })
  }
  return mediaRoot
}

async function main() {
  const runId = crypto.randomUUID()
  baselineStage = 'fingerprint'
  const report = {
    version: 1,
    runId,
    fingerprint: fingerprint(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      osRelease: os.release(),
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      condition: 'synthetic empty MP4 candidates; fixture created before measurements; one full scan, one same-process reconciliation and one restart cache load plus reconciliation; no cache flush; filesystem type and physical I/O counters not measured'
    },
    runs: []
  }
  for (const count of [1000, 5000, 9000]) {
    baselineStage = `fixture-${count}`
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kq-f0-baseline-'))
    const mediaRoot = await createFixture(temporaryRoot, count)
    const profile = path.join(temporaryRoot, 'profile')
    const store = new VideoLibraryIndexStore(profile)
    let library = new VideoLibraryService([mediaRoot], { collectScanMetrics: true, indexStore: store })
    try {
      for (const phase of ['initial-full-scan', 'same-process-incremental']) {
        baselineStage = `${phase}-${count}`
        const cpuBefore = process.cpuUsage()
        const rssBeforeBytes = process.memoryUsage().rss
        const startedAt = performance.now()
        const snapshot = await library.refresh()
        const elapsedMs = performance.now() - startedAt
        const cpu = process.cpuUsage(cpuBefore)
        const scan = library.getScanMetrics()
        const expectedCacheHits = phase === 'initial-full-scan' ? 0 : count
        const expectedOpens = phase === 'initial-full-scan' ? count : 0
        if (snapshot.scanStatus !== 'ready' || snapshot.counts.indexedFiles !== count ||
            scan.candidateFiles !== count || scan.cacheHits !== expectedCacheHits ||
            scan.fileOpens !== expectedOpens || scan.fileCloses !== expectedOpens || scan.bytesRead !== 0) {
          throw Object.assign(new Error(`Reconciliation fixture oracle failed: ${phase}.`), { code: 'BASELINE_ORACLE_FAILED' })
        }
        report.runs.push({ phase, fixtureFiles: count, runId, indexedFiles: snapshot.counts.indexedFiles,
          scanStatus: snapshot.scanStatus, elapsedMs,
          cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
          rssBeforeBytes, rssAfterBytes: process.memoryUsage().rss,
          scan })
      }
      library.close()
      library = new VideoLibraryService([mediaRoot], { collectScanMetrics: true, indexStore: new VideoLibraryIndexStore(profile) })
      const rssBeforeBytes = process.memoryUsage().rss
      const indexReadStartedAt = performance.now()
      const restoreStatus = await library.restorePersistentIndex()
      const indexReadMs = performance.now() - indexReadStartedAt
      if (restoreStatus !== 'restored' || library.getSnapshot().counts.indexedFiles !== count) {
        throw Object.assign(new Error('Restart cache fixture oracle failed.'), { code: 'BASELINE_ORACLE_FAILED' })
      }
      const cpuBefore = process.cpuUsage()
      const scanStartedAt = performance.now()
      const snapshot = await library.refresh()
      const incrementalMs = performance.now() - scanStartedAt
      const cpu = process.cpuUsage(cpuBefore)
      const scan = library.getScanMetrics()
      if (snapshot.scanStatus !== 'ready' || snapshot.counts.indexedFiles !== count ||
          scan.candidateFiles !== count || scan.cacheHits !== count || scan.fileOpens !== 0 || scan.fileCloses !== 0) {
        throw Object.assign(new Error('Restart incremental fixture oracle failed.'), { code: 'BASELINE_ORACLE_FAILED' })
      }
      report.runs.push({ phase: 'restart-cache-read-and-incremental-reconcile', fixtureFiles: count, runId,
        indexedFiles: snapshot.counts.indexedFiles, scanStatus: snapshot.scanStatus, indexReadMs, incrementalMs,
        cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
        rssBeforeBytes, rssAfterBytes: process.memoryUsage().rss, scan })
    } finally {
      baselineStage = `cleanup-${count}`
      library.close()
      await fs.rm(temporaryRoot, { recursive: true, force: true })
    }
  }
  baselineStage = 'write-report'
  const reportPath = path.join(os.tmpdir(), `kq-f0-library-baseline-${runId}.json`)
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`F0_BASELINE_REPORT ${reportPath}\n${JSON.stringify(report, null, 2)}\n`)
}

main().catch(error => {
  process.stderr.write(`F0_BASELINE_FAILED:${error && error.code ? error.code : 'UNKNOWN'}:${baselineStage}\n`)
  process.exitCode = 1
})
