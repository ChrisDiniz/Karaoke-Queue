import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PlayerMediaProtocol } from '../src/player-media-protocol'
import { VideoLibraryService } from '../src/video-library-service'

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kq-player-media-protocol-'))
}

test('Main media protocol serves real file bytes, HEAD and byte ranges without loading whole files eagerly', async () => {
  const temporaryRoot = temporaryDirectory()
  const mediaRoot = path.join(temporaryRoot, 'media')
  fs.mkdirSync(mediaRoot)
  const mediaPath = path.join(mediaRoot, '00001.mp4')
  const bytes = Buffer.from(Array.from({ length: 512 * 1024 }, (_value, index) => index % 251))
  fs.writeFileSync(mediaPath, bytes)
  const library = new VideoLibraryService([mediaRoot])
  await library.refresh()
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  const protocol = {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) => handlers.set(scheme, handler),
    unhandle: (scheme: string) => handlers.delete(scheme)
  } as never
  const media = new PlayerMediaProtocol(library)
  media.install(protocol)
  const grant = media.grant('00001', library.getSnapshot().revision)
  const handleRequest = handlers.get('kq-media')!
  try {
    const head = await handleRequest(new Request(grant.url, { method: 'HEAD' }))
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('Content-Length'), String(bytes.length))
    assert.equal(await head.arrayBuffer().then(value => value.byteLength), 0)

    const full = await handleRequest(new Request(grant.url))
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('Accept-Ranges'), 'bytes')
    assert.equal(full.headers.get('Cache-Control'), 'no-store')
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes)

    const partial = await handleRequest(new Request(grant.url, { headers: { Range: 'bytes=100-199' } }))
    assert.equal(partial.status, 206)
    assert.equal(partial.headers.get('Content-Range'), `bytes 100-199/${bytes.length}`)
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(100, 200))

    const suffix = await handleRequest(new Request(grant.url, { headers: { Range: 'bytes=-37' } }))
    assert.equal(suffix.status, 206)
    assert.equal(suffix.headers.get('Content-Range'), `bytes ${bytes.length - 37}-${bytes.length - 1}/${bytes.length}`)
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-37))

    const invalidRange = await handleRequest(new Request(grant.url, { headers: { Range: `bytes=${bytes.length}-` } }))
    assert.equal(invalidRange.status, 416)
    assert.equal(invalidRange.headers.get('Content-Range'), `bytes */${bytes.length}`)

    const cancelled = await handleRequest(new Request(grant.url, { headers: { Range: 'bytes=0-262143' } }))
    await cancelled.body?.cancel()
    await fs.promises.rename(mediaPath, path.join(mediaRoot, '00001-renamed.mp4'))
    assert.equal(fs.existsSync(mediaPath), false, 'the response stream releases its owned file handle after cancellation')
  } finally {
    grant.revoke()
    media.dispose(protocol)
    library.close()
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('media protocol rejects an old capability after the library revision changes', async () => {
  const temporaryRoot = temporaryDirectory()
  const mediaRoot = path.join(temporaryRoot, 'media')
  fs.mkdirSync(mediaRoot)
  fs.writeFileSync(path.join(mediaRoot, '00002.mp4'), 'original')
  const library = new VideoLibraryService([mediaRoot])
  await library.refresh()
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  const protocol = { handle: (scheme: string, handler: (request: Request) => Promise<Response>) => handlers.set(scheme, handler),
    unhandle: (scheme: string) => handlers.delete(scheme) } as never
  const media = new PlayerMediaProtocol(library)
  media.install(protocol)
  const grant = media.grant('00002', library.getSnapshot().revision)
  try {
    fs.writeFileSync(path.join(mediaRoot, '00003.mp4'), 'new file')
    await library.refresh()
    const response = await handlers.get('kq-media')!(new Request(grant.url))
    assert.equal(response.status, 409)
  } finally {
    grant.revoke()
    media.dispose(protocol)
    library.close()
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('opt-in media protocol diagnostics confirm stream and handle closure without exposing media identity', async () => {
  const previous = process.env.KQ_F0_DIAGNOSTICS
  const temporaryRoot = temporaryDirectory()
  const mediaRoot = path.join(temporaryRoot, 'media')
  fs.mkdirSync(mediaRoot)
  const mediaPath = path.join(mediaRoot, '00003.mp4')
  fs.writeFileSync(mediaPath, Buffer.alloc(4096, 7))
  const library = new VideoLibraryService([mediaRoot])
  process.env.KQ_F0_DIAGNOSTICS = '1'
  try {
    await library.refresh()
    const handlers = new Map<string, (request: Request) => Promise<Response>>()
    const protocol = {
      handle: (scheme: string, handler: (request: Request) => Promise<Response>) => handlers.set(scheme, handler),
      unhandle: (scheme: string) => handlers.delete(scheme)
    } as never
    const media = new PlayerMediaProtocol(library)
    media.install(protocol)
    const grant = media.grant('00003', library.getSnapshot().revision)
    try {
      const response = await handlers.get('kq-media')!(new Request(grant.url, { headers: { Range: 'bytes=0-1023' } }))
      assert.equal(response.status, 206)
      assert.equal((await response.arrayBuffer()).byteLength, 1024)
      await new Promise<void>(resolve => setImmediate(resolve))
      const metrics = media.getDiagnosticMetrics()
      assert.ok(metrics)
      assert.equal(metrics.requests, 1)
      assert.equal(metrics.rangeRequests, 1)
      assert.equal(metrics.fileHandlesOpened, 1)
      assert.equal(metrics.fileHandlesClosed, 1)
      assert.equal(metrics.fileHandleCloseFailures, 0)
      assert.equal(metrics.streamsOpened, 1)
      assert.equal(metrics.streamsClosed, 1)
      assert.equal(metrics.activeStreams, 0)
      assert.equal(metrics.bytesRead, 1024)
      assert.equal(JSON.stringify(metrics).includes(mediaRoot), false)
      assert.equal(JSON.stringify(metrics).includes('00003'), false)
    } finally {
      grant.revoke()
      media.dispose(protocol)
    }
  } finally {
    if (previous === undefined) delete process.env.KQ_F0_DIAGNOSTICS
    else process.env.KQ_F0_DIAGNOSTICS = previous
    library.close()
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

for (const action of ['revoke', 'abort', 'dispose', 'revoke-and-fail'] as const) {
  test(`pending physical open cannot authorize media after ${action}`, async () => {
    const root = temporaryDirectory()
    fs.writeFileSync(path.join(root, '00001.mp4'), Buffer.alloc(4096))
    const library = new VideoLibraryService([root])
    await library.refresh()
    const original = library.openForPlayback.bind(library)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    let lateHandle: fs.promises.FileHandle | undefined
    library.openForPlayback = async (...args) => {
      const opened = await original(...args)
      if (opened.status === 'available') lateHandle = opened.handle
      enter()
      await barrier
      if (action === 'revoke-and-fail') {
        await lateHandle?.close()
        throw new Error('isolated I/O failure')
      }
      return opened
    }
    let handler!: (request: Request) => Promise<Response>
    const protocol = { handle: (_scheme: string, value: typeof handler) => { handler = value }, unhandle: () => {} } as never
    const media = new PlayerMediaProtocol(library)
    media.install(protocol)
    const grant = media.grant('00001', library.getSnapshot().revision)
    const controller = new AbortController()
    try {
      const pending = handler(new Request(grant.url, { signal: controller.signal, headers: { Range: 'bytes=0-99' } }))
      await entered
      if (action === 'abort') controller.abort()
      else if (action === 'dispose') media.dispose(protocol)
      else grant.revoke()
      release()
      const result = await pending
      assert.ok(result.status >= 400, 'a revoked/cancelled open must not return an authorized response')
      assert.equal(result.body, null)
      assert.ok(lateHandle)
      await assert.rejects(lateHandle.stat(), /closed|EBADF/)
      if (action !== 'abort') assert.ok((await handler(new Request(grant.url))).status >= 400)
    } finally {
      release()
      grant.revoke()
      media.dispose(protocol)
      library.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

for (const action of ['revoke', 'abort', 'dispose'] as const) {
  test(`active response releases its real file stream on ${action} without shutdown`, async () => {
    const root = temporaryDirectory()
    fs.writeFileSync(path.join(root, '00001.mp4'), Buffer.alloc(1024 * 1024))
    const library = new VideoLibraryService([root])
    await library.refresh()
    const original = library.openForPlayback.bind(library)
    let closed!: Promise<void>
    library.openForPlayback = async (...args) => {
      const opened = await original(...args)
      if (opened.status === 'available') {
        const createStream = opened.handle.createReadStream.bind(opened.handle)
        opened.handle.createReadStream = options => {
          const stream = createStream(options)
          closed = new Promise<void>(resolve => stream.once('close', resolve))
          return stream
        }
      }
      return opened
    }
    let handler!: (request: Request) => Promise<Response>
    const protocol = { handle: (_scheme: string, value: typeof handler) => { handler = value }, unhandle: () => {} } as never
    const media = new PlayerMediaProtocol(library)
    media.install(protocol)
    const grant = media.grant('00001', library.getSnapshot().revision)
    const controller = new AbortController()
    try {
      assert.equal((await handler(new Request(grant.url, { headers: { Origin: 'https://untrusted.invalid' } }))).status, 403)
      const result = await handler(new Request(grant.url, { signal: controller.signal }))
      assert.equal(result.status, 200)
      if (action === 'revoke') grant.revoke()
      if (action === 'abort') controller.abort()
      if (action === 'dispose') media.dispose(protocol)
      await closed
      await result.body?.cancel().catch(() => undefined)
    } finally {
      grant.revoke()
      media.dispose(protocol)
      library.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

test('F0-08 EIO after first real stream chunk closes its handle and never revives a revoked grant', async () => {
  const root = temporaryDirectory()
  fs.writeFileSync(path.join(root, '00001.mp4'), Buffer.alloc(4 * 1024 * 1024, 7))
  const library = new VideoLibraryService([root])
  await library.refresh()
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  const port = { handle: (name: string, fn: (request: Request) => Promise<Response>) => handlers.set(name, fn), unhandle: () => {} } as never
  const protocol = new PlayerMediaProtocol(library)
  protocol.install(port)
  const original = library.openForPlayback.bind(library)
  let stream: import('node:fs').ReadStream | undefined
  let handle: import('node:fs/promises').FileHandle | undefined
  let closed!: Promise<void>
  library.openForPlayback = async (...args) => {
    const result = await original(...args)
    if (result.status === 'available') {
      handle = result.handle
      const create = handle.createReadStream.bind(handle)
      handle.createReadStream = options => {
        stream = create(options)
        closed = new Promise(resolve => stream!.once('close', resolve))
        return stream
      }
    }
    return result
  }
  const grant = protocol.grant('00001', library.getSnapshot().revision)
  try {
    const response = await handlers.get('kq-media')!(new Request(grant.url, { headers: { Range: 'bytes=0-4194303' } }))
    assert.equal(response.status, 206)
    const reader = response.body!.getReader()
    assert.ok((await reader.read()).value!.byteLength > 0)
    stream!.destroy(Object.assign(new Error('Injected storage read failure'), { code: 'EIO' }))
    await assert.rejects(async () => { for (;;) { const chunk = await reader.read(); if (chunk.done) return } }, /Injected storage read failure|EIO/)
    await closed
    await assert.rejects(handle!.stat(), /closed|EBADF/i)
    grant.revoke()
    assert.equal((await handlers.get('kq-media')!(new Request(grant.url))).status, 404)
  } finally {
    grant.revoke(); protocol.dispose(port); library.close(); fs.rmSync(root, { recursive: true, force: true })
  }
})
