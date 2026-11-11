// @ts-nocheck
export {}
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { ElectronUsbAdapter } = require('../../scripts/usb-reconnect-electron.cjs')
const { UsbReconnectCampaign, createJournal } = require('../../scripts/usb-reconnect-core.cjs')
const checkout = path.resolve(__dirname, '../..')
const session = process.env.KARAOKE_TEST_TEMP_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'kq-usb-synthetic-'))
if (process.env.KARAOKE_TEST_TEMP_ROOT) fs.mkdirSync(session)
const mediaRoot = path.join(session, 'fixture')
const offline = path.join(session, 'fixture-offline')
fs.mkdirSync(mediaRoot)
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-usb-synthetic-evidence-'))
const journal = createJournal(evidence)
journal.event('synthetic-only', { modality: 'synthetic', physicalT3: 'NOT RUN', deviceMetadata: 'mocked, no native policy/volume query' })
const adapter = new ElectronUsbAdapter({ checkout, session, mediaRoot, journal, synthetic: true })
const state = { results: {} }
async function run() {
  try {
    await adapter.start()
    await adapter.ready()
    await adapter.createSyntheticMedia()
    await adapter.ready()
    await adapter.close()
    const campaign = new UsbReconnectCampaign({ adapter, state, modality: 'synthetic', journal, save: async () => {},
      device: { policy: async () => 2, observe: async () => ({ present: fs.existsSync(mediaRoot), key: 'a'.repeat(64),
        drive: 'fixture', online: true, readOnly: true, fileSystem: 'NTFS', busType: 'USB' }) },
      ask: async () => {
        // Logical fixture rename only. No native device query, fsutil or USB action is invoked.
        if (state.checkpoint.endsWith('-remove')) fs.renameSync(mediaRoot, offline)
        else fs.renameSync(offline, mediaRoot)
        return 'CONFIRMO'
      }
    })
    const results = await campaign.run()
    assert.deepEqual(Object.values(results).map(r => r.status), ['PASS', 'PASS'])
    assert.ok(Object.values(results).every(r => r.physical === false))
    await adapter.start()
    await adapter.ready()
    for (let cycle = 0; cycle < 2; cycle++) {
      await adapter.rememberInventory()
      const before = (await adapter.resources()).scanStarts
      await adapter.quiesce()
      fs.renameSync(mediaRoot, offline)
      await adapter.resumeDiscovery()
      await adapter.availability(false)
      await adapter.assertPreserved()
      await adapter.quiesce()
      fs.renameSync(offline, mediaRoot)
      await adapter.resumeDiscovery()
      await adapter.availability(true)
      await adapter.app.evaluate(async () => {
        await Promise.all([global.__t3.runtime.probeLibraryAvailability(), global.__t3.runtime.probeLibraryAvailability()])
      })
      assert.equal((await adapter.resources()).scanStarts, before + 1, 'repeated probes must not duplicate reconnect scans')
    }
    // Hold a real ENOENT result until a newer reconciliation has already published ready.
    await adapter.app.evaluate(async () => {
      global.__t3.runtime.stopAvailabilityMonitor()
      await global.__t3.runtime.library.probePromise
    })
    fs.renameSync(mediaRoot, offline)
    await adapter.app.evaluate((_electron, root) => {
      const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')
      const fs = require('node:fs')
      const original = fs.promises.realpath
      const stale = global.__t3Stale = {}
      stale.entered = new Promise(resolve => { stale.onEntered = resolve })
      const barrier = new Promise(resolve => { stale.release = resolve })
      let intercepted = false
      fs.promises.realpath = async (...args) => {
        if (!intercepted && args[0] === root) {
          intercepted = true
          let result, error
          try { result = await original.apply(fs.promises, args) } catch (e) { error = e }
          stale.onEntered()
          await barrier
          if (error) throw error
          return result
        }
        return original.apply(fs.promises, args)
      }
      stale.restore = () => { fs.promises.realpath = original }
      stale.pending = global.__t3.runtime.probeLibraryAvailability()
    }, mediaRoot)
    await adapter.app.evaluate(() => global.__t3Stale.entered)
    fs.renameSync(offline, mediaRoot)
    await adapter.app.evaluate(() => global.__t3.runtime.library.refresh())
    await adapter.app.evaluate(async () => {
      global.__t3Stale.release()
      await global.__t3Stale.pending
      global.__t3Stale.restore()
    })
    const current = await adapter.resources()
    assert.equal(current.availability.availableRoots, 1)
    assert.equal(current.scan.scanStatus, 'ready')
    await adapter.selectMusic()
    await adapter.close()
    journal.event('synthetic-complete', { status: 'PASS', physicalT3: 'NOT RUN', repeatedReconnectCycles: 2,
      staleResultRejected: true, restoredRealPlayback: true, container: 'generated WebM/VP8, not physical MP4 evidence' })
    process.stdout.write('PASS synthetic USB availability/restart: Main/IPC/UI/cache, repeated reconnect, stale probe, real generated WebM playback; PHYSICAL T3 NOT RUN\n')
    process.stdout.write('SYNTHETIC_EVIDENCE ' + path.basename(evidence) + '\n')
  } finally {
    await adapter.close()
    fs.rmSync(session, { recursive: true, force: true })
  }
}
run().catch(error => {
  journal.event('synthetic-failure', { status: 'FAIL', code: error.code || error.name })
  process.stderr.write(`Synthetic reconnect FAIL: ${error.code || error.name}\n`)
  process.exitCode = 1
})
