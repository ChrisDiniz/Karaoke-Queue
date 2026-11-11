const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { VideoLibraryIndexStore } = require('../build/src/video-library-index-store.js')

const projectRoot = path.resolve(__dirname, '..')
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-f0-index-baseline-'))
const reportPath = path.join(os.tmpdir(), `kq-f0-index-baseline-${process.pid}.json`)
const sourcePath = path.join(projectRoot, 'src/video-library-index-store.ts')
const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex')

function repositoryHead() {
  const gitDirectory = path.join(projectRoot, '.git')
  const head = fs.readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim()
  const reference = /^ref: (.+)$/.exec(head)?.[1]
  if (!reference) return head
  const referencePath = path.join(gitDirectory, reference)
  if (fs.existsSync(referencePath)) return fs.readFileSync(referencePath, 'utf8').trim()
  for (const line of fs.readFileSync(path.join(gitDirectory, 'packed-refs'), 'utf8').split(/\r?\n/)) {
    if (line.endsWith(` ${reference}`)) return line.split(' ')[0]
  }
  return head
}

async function measure(count) {
  const root = path.join(temporaryRoot, `media-${count}`)
  const userData = path.join(temporaryRoot, `profile-${count}`)
  fs.mkdirSync(root)
  const entries = Array.from({ length: count }, (_unused, index) => {
    const musicCode = String(10000 + index).padStart(5, '0')
    return {
      relativePath: path.join(`dir-${Math.floor(index / 500)}`, `${musicCode}.mp4`),
      musicCode,
      size: 31_700_000 + index,
      mtimeMs: 1_700_000_000_000 + index,
      device: '1',
      inode: String(index + 1)
    }
  })
  const store = new VideoLibraryIndexStore(userData)
  const beforeWrite = process.memoryUsage()
  const writeStarted = performance.now()
  await store.writeComplete({
    generation: 1,
    configuredRoots: [root],
    roots: [{ configuredPath: root, canonicalRoot: root, entries }],
    scanCompletedAt: '2026-11-10T12:00:00.000Z'
  })
  const writeMs = performance.now() - writeStarted
  const indexBytes = fs.statSync(store.filePath).size
  const beforeRead = process.memoryUsage()
  const readStarted = performance.now()
  const result = await store.read([root])
  const readMs = performance.now() - readStarted
  if (result.status !== 'valid' || result.index.roots[0].entries.length !== count) {
    throw new Error(`Index round-trip failed for ${count} entries; status=${result.status}`)
  }
  const afterRead = process.memoryUsage()
  return {
    entries: count,
    indexBytes,
    writeMs: Number(writeMs.toFixed(2)),
    readAndParseMs: Number(readMs.toFixed(2)),
    heapDeltaWriteBytes: process.memoryUsage().heapUsed - beforeWrite.heapUsed,
    heapDeltaReadBytes: afterRead.heapUsed - beforeRead.heapUsed,
    rssDeltaBytes: afterRead.rss - beforeRead.rss
  }
}

async function main() {
  try {
    const results = []
    for (const count of [1000, 5000, 9000]) results.push(await measure(count))
    const report = {
      benchmark: 'F0 persistent library index serialization and parse baseline',
      environment: { platform: process.platform, arch: process.arch, node: process.version,
        cpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
      repositoryHead: repositoryHead(),
      sourceSha256,
      note: 'Synthetic metadata only; no MP4 content, real library, SQLite or production profile was read or modified.',
      results
    }
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`${reportPath}\n${JSON.stringify(results)}\n`)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
