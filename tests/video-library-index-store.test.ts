import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  VideoLibraryIndexStore,
  VideoLibraryIndexStoreError,
  VIDEO_LIBRARY_INDEX_FILENAME,
  videoLibraryConfigurationFingerprint,
  type VideoLibraryIndexWriteInput
} from '../src/video-library-index-store'

interface Fixture {
  root: string
  userData: string
  store: VideoLibraryIndexStore
  cleanup(): void
}

function fixture(): Fixture {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-library-index-'))
  const root = path.join(temporaryRoot, 'media')
  const userData = path.join(temporaryRoot, 'profile')
  fs.mkdirSync(root)
  const store = new VideoLibraryIndexStore(userData)
  return { root, userData, store, cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }) }
}

function input(root: string, generation = 1): VideoLibraryIndexWriteInput {
  return {
    generation,
    configuredRoots: [root],
    roots: [{ configuredPath: root, canonicalRoot: root, entries: [
      { relativePath: '01001.mp4', musicCode: '01001', size: 123, mtimeMs: 456.5, device: '7', inode: '9' },
      { relativePath: path.join('sub', '01002 - live.mp4'), musicCode: '01002', size: 0, mtimeMs: 0, device: '7', inode: '10' }
    ] }],
    scanCompletedAt: '2026-11-10T12:00:00.000Z'
  }
}

test('an absent index is a cache miss and reading it does not create profile files', async () => {
  const value = fixture()
  try {
    assert.deepEqual(await value.store.read([value.root]), { status: 'missing' })
    assert.equal(fs.existsSync(value.userData), false)
  } finally { value.cleanup() }
})

test('a complete JSON generation round-trips without touching SQLite or library configuration', async () => {
  const value = fixture()
  try {
    const expected = await value.store.writeComplete(input(value.root, 4))
    const reopened = new VideoLibraryIndexStore(value.userData)
    const read = await reopened.read([value.root])
    assert.deepEqual(read, { status: 'valid', index: expected })
    assert.equal(expected.configurationFingerprint, videoLibraryConfigurationFingerprint([value.root]))
    assert.deepEqual(fs.readdirSync(value.userData), [VIDEO_LIBRARY_INDEX_FILENAME])
    assert.equal(fs.existsSync(path.join(value.userData, 'video-library.json')), false)
    assert.equal(fs.existsSync(path.join(value.userData, 'karaoke.sqlite')), false)
    assert.equal(fs.existsSync(path.join(value.root, '01001.mp4')), false,
      'the store records candidate metadata without opening or creating media files')
  } finally { value.cleanup() }
})

test('filesystem device and inode identities preserve unsigned 64-bit values exactly', async () => {
  const value = fixture()
  try {
    const largeIdentity = input(value.root)
    largeIdentity.roots[0].entries[0].device = '18446744073709551614'
    largeIdentity.roots[0].entries[0].inode = '9007199254740993'
    await value.store.writeComplete(largeIdentity)
    const result = await value.store.read([value.root])
    assert.equal(result.status, 'valid')
    if (result.status === 'valid') {
      assert.equal(result.index.roots[0].entries[0].device, '18446744073709551614')
      assert.equal(result.index.roots[0].entries[0].inode, '9007199254740993')
    }
    const invalid = input(value.root, 2)
    invalid.roots[0].entries[0].inode = '18446744073709551616'
    await assert.rejects(value.store.writeComplete(invalid), { code: 'INVALID_INDEX' })
  } finally { value.cleanup() }
})

test('configuration changes produce a stale cache result without rewriting the prior index', async () => {
  const value = fixture()
  try {
    await value.store.writeComplete(input(value.root))
    const before = fs.readFileSync(value.store.filePath)
    const differentRoot = path.join(path.dirname(value.root), 'other-media')
    fs.mkdirSync(differentRoot)
    assert.deepEqual(await value.store.read([differentRoot]), {
      status: 'stale', reason: 'configuration-mismatch'
    })
    assert.deepEqual(fs.readFileSync(value.store.filePath), before)
  } finally { value.cleanup() }
})

test('invalid JSON remains byte-for-byte intact when treated as a cache miss', async () => {
  const value = fixture()
  try {
    fs.mkdirSync(value.userData)
    const invalid = Buffer.from('{"version":1,"roots":[', 'utf8')
    fs.writeFileSync(value.store.filePath, invalid)
    assert.deepEqual(await value.store.read([value.root]), { status: 'invalid', reason: 'invalid-json' })
    assert.deepEqual(fs.readFileSync(value.store.filePath), invalid)
  } finally { value.cleanup() }
})

test('unsupported version, malformed schema, and traversal are rejected without changing cache bytes', async () => {
  const value = fixture()
  try {
    fs.mkdirSync(value.userData)
    fs.writeFileSync(value.store.filePath, JSON.stringify({ version: 99 }))
    assert.deepEqual(await value.store.read([value.root]), { status: 'invalid', reason: 'unsupported-version' })
    const unsupported = fs.readFileSync(value.store.filePath)
    assert.deepEqual(fs.readFileSync(value.store.filePath), unsupported)

    await value.store.writeComplete(input(value.root))
    const valid = JSON.parse(fs.readFileSync(value.store.filePath, 'utf8')) as Record<string, unknown>
    const root = (valid.roots as Array<Record<string, unknown>>)[0]
    root.entries = [{ relativePath: '../01003.mp4', musicCode: '01003', size: 1, mtimeMs: 1, device: '1', inode: '1' }]
    fs.writeFileSync(value.store.filePath, JSON.stringify(valid))
    const traversal = fs.readFileSync(value.store.filePath)
    assert.deepEqual(await value.store.read([value.root]), { status: 'invalid', reason: 'invalid-record' })
    assert.deepEqual(fs.readFileSync(value.store.filePath), traversal)
  } finally { value.cleanup() }
})

test('a lower or conflicting same generation cannot overwrite a newer complete index', async () => {
  const value = fixture()
  try {
    const first = input(value.root, 5)
    await value.store.writeComplete(first)
    await assert.rejects(value.store.writeComplete(input(value.root, 4)), (error: unknown) =>
      error instanceof VideoLibraryIndexStoreError && error.code === 'STALE_GENERATION')
    const changedSameGeneration = input(value.root, 5)
    changedSameGeneration.roots[0].entries[0].size++
    await assert.rejects(value.store.writeComplete(changedSameGeneration), (error: unknown) =>
      error instanceof VideoLibraryIndexStoreError && error.code === 'STALE_GENERATION')
    const read = await value.store.read([value.root])
    assert.equal(read.status, 'valid')
    if (read.status === 'valid') {
      assert.equal(read.index.generation, 5)
      assert.equal(read.index.roots[0].entries[0].size, 123)
    }
  } finally { value.cleanup() }
})

test('concurrent writes are serialized and generation retries are idempotent', async () => {
  const value = fixture()
  try {
    const generation2 = input(value.root, 2)
    const generation3 = input(value.root, 3)
    const [second, third] = await Promise.all([
      value.store.writeComplete(generation2),
      value.store.writeComplete(generation3)
    ])
    assert.equal(second.generation, 2)
    assert.equal(third.generation, 3)
    assert.deepEqual(await value.store.writeComplete(generation3), third)
    const read = await value.store.read([value.root])
    assert.equal(read.status, 'valid')
    if (read.status === 'valid') assert.equal(read.index.generation, 3)
    assert.deepEqual(fs.readdirSync(value.userData), [VIDEO_LIBRARY_INDEX_FILENAME],
      'atomic replacement leaves no temporary index files behind')
  } finally { value.cleanup() }
})

test('a partial root set or invalid metadata cannot be persisted over a good generation', async () => {
  const value = fixture()
  try {
    await value.store.writeComplete(input(value.root, 1))
    const before = fs.readFileSync(value.store.filePath)
    const partial = input(value.root, 2)
    partial.roots = []
    await assert.rejects(value.store.writeComplete(partial), { code: 'INVALID_INDEX' })
    const invalidPath = input(value.root, 2)
    invalidPath.roots[0].entries[0].relativePath = '/outside/01001.mp4'
    await assert.rejects(value.store.writeComplete(invalidPath), { code: 'INVALID_INDEX' })
    assert.deepEqual(fs.readFileSync(value.store.filePath), before)
  } finally { value.cleanup() }
})
