// @ts-nocheck
// Integration of the new controller + adapter, real package Main, internal fixtures only.
export {}
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const assert = require('node:assert/strict')
const { CampaignElectronAdapter } = require('../../scripts/usb-campaign-electron.cjs')
const { UnifiedUsbCampaign } = require('../../scripts/usb-campaign.cjs')
const { createJournal } = require('../../scripts/usb-reconnect-core.cjs')
const root = process.env.KARAOKE_TEST_TEMP_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'kq-campaign-e2e-'))
if (process.env.KARAOKE_TEST_TEMP_ROOT) fs.mkdirSync(root)
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-campaign-evidence-'))
const journal = createJournal(evidence), state = { results: {} }
let adapter, mediaRoot, offline, seed
const device = { policy: async () => 2, observe: async () => ({ present: !mediaRoot || fs.existsSync(mediaRoot),
  key: 'a'.repeat(64), drive: 'F:', label: 'testekaraoke', healthy: true, online: true, busType: 'USB', fileSystem: 'NTFS', readOnly: false }) }
async function run() {
  try {
    const controller = new UnifiedUsbCampaign({ state, device, root: 'F:\\musicas', mode: 'disposable',
      consent: { disposableConsent: true }, modality: 'synthetic', journal, save: async () => {},
      factory: async scenario => {
        const session = path.join(root, scenario); fs.mkdirSync(session)
        mediaRoot = path.join(session, 'fixture'); offline = path.join(session, 'offline'); fs.mkdirSync(mediaRoot)
        adapter = new CampaignElectronAdapter({ checkout: path.resolve(__dirname, '../..'), session, mediaRoot, journal, synthetic: true })
        await adapter.start(); await adapter.ready()
        if (!seed) {
          await adapter.createSyntheticMedia(16000)
          seed = fs.readFileSync(path.join(mediaRoot, '00001.webm'))
        }
        for (const code of ['00001', '00002', '00003']) fs.writeFileSync(path.join(mediaRoot, code + '.webm'), seed)
        await adapter.page.evaluate(() => window.standalonePlayer.refreshVideoLibrary())
        await adapter.ready(); await adapter.close()
        return adapter
      },
      ask: async message => {
        if (/PROXIMO \/ REPETIR/.test(message)) return 'PROXIMO'
        const id = state.checkpoint
        if (id.startsWith('start-')) return 'INICIAR'
        if (id.startsWith('risk-')) return 'AUTORIZO REMOCAO ABRUPTA ' + id.slice(5)
        if (id.startsWith('remove-')) {
          fs.renameSync(mediaRoot, offline)
          if (id.endsWith('playing')) {
            const before = await adapter.inspect()
            await adapter.page.waitForFunction(time => document.querySelector('video')?.currentTime > time + 0.25, before.media.currentTime)
            await adapter.page.locator('video').evaluate(v => { v.src += '?synthetic-resource-error'; v.load(); void v.play().catch(() => {}) })
          }
          // Controlled synthetic probe only. Physical runner NEVER forces this call.
          await adapter.app.evaluate(() => global.__t3.runtime.probeLibraryAvailability())
          await adapter.waitObservation(s => s.recovery?.contained && !s.streams && !s.grants && !s.handles, 'SYNTHETIC_CONTAINMENT')
          return 'REMOVIDO'
        }
        if (id.startsWith('reconnect-')) fs.renameSync(offline, mediaRoot)
        return 'CONFIRMO'
      }
    })
    await controller.run(['playing', 'paused'])
    assert.equal(state.history.length, 2)
    assert.ok(state.history.every(r => r.status === 'PASS' && r.physical === false), JSON.stringify(state.history))
    journal.event('campaign-synthetic-complete', { status: 'PASS', scenarios: ['playing', 'paused'], physical: 'NOT RUN', volumeMetadata: 'mocked' })
    console.log('USB_CAMPAIGN_SYNTHETIC PASS controller/checkpoints + real Main/IPC/UI/media, recovery/queue/Stop; physical NOT RUN')
    console.log('USB_CAMPAIGN_EVIDENCE ' + path.basename(evidence))
  } catch (error) { journal.event('campaign-synthetic-error', { code: error.code || error.name }); console.error(error); throw error }
  finally { await adapter?.close(); fs.rmSync(root, { recursive: true, force: true }) }
}
run().catch(() => { process.exitCode = 1 })
