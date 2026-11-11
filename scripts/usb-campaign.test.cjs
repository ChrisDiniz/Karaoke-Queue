'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { UnifiedUsbCampaign, SCENARIOS, assertTestPath, assertTestVolume } = require('./usb-campaign.cjs')
const { recoveryOracle } = require('./usb-campaign-electron.cjs')
const { createTestDeviceProvider, testVolumeCommand } = require('./usb-reconnect-native.cjs')
const { createJournal, CampaignError } = require('./usb-reconnect-core.cjs')
const { parseArgs } = require('./manual-usb-reconnect.cjs')
const safeVolume = { present: true, key: 'a'.repeat(64), drive: 'F:', label: 'testekaraoke', online: true,
  fileSystem: 'NTFS', busType: 'USB', readOnly: false, healthy: true }
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-campaign-unit-'))
  const state = options.state || { results: {} }, journal = createJournal(dir)
  const volume = { ...safeVolume, ...options.volume }
  const counts = { starts: 0, closes: 0, factories: 0, removes: 0, recoveries: 0, questions: 0, selectionCalls: 0 }
  let active = false, initial, scenario
  const resources = () => ({ measurementComplete: true, idle: true, scanActive: false, activeIO: 0, handles: 0, streams: 0,
    grants: 0, processes: active ? 1 : 0, scanStarts: 1, ...options.resources })
  const device = { policy: async () => 2, observe: async () => ({ ...volume }) }
  const factory = async id => {
    scenario = id; counts.factories++
    return {
      start: async () => { counts.starts++; active = true },
      ready: async () => ({ idle: true, indexedFiles: 3, gated: true, cacheRestored: true }),
      rememberInventory: async () => {}, assertPreserved: async () => {},
      quiesce: async () => { if (options.quiesceError) throw new CampaignError('HANDLES_ACTIVE') },
      resources: async () => resources(), selectMusic: async () => { counts.selectionCalls++ },
      resumeDiscovery: async () => {}, availability: async () => { if (volume.present) options.resources = { ...options.resources, scanStarts: 2 }; return {} },
      close: async () => { counts.closes++; if (options.closeError) throw new CampaignError('SHUTDOWN_FAILED'); active = false },
      preparePhase: async phase => {
        initial = { phaseObserved: !options.notReproduced, phase, current: { entryId: 'current' }, attemptId: 'old', target: 'target',
          pending: [{ entryId: 'target', priority: 'priority' }, { entryId: 'normal', priority: 'normal' }], naturalEnds: phase === 'celebration' ? 1 : 0,
          media: { currentTime: 1 } }
        if (['countdown', 'loading'].includes(phase)) { initial.current = null; initial.pending = [{ entryId: 'target', priority: 'normal' }] }
        return initial
      },
      inspect: async () => ({ phase: 'recovery' }),
      validateActive: async () => {
        const expected = ['transition', 'celebration'].includes(scenario) ? 'target' : initial.current?.entryId || initial.target
        const current = { ...initial, engine: 'idle', modal: !options.noModal, streams: 0, grants: 0, handles: 0,
          recovery: { target: expected, contained: true, wasPaused: scenario === 'paused', phase: scenario === 'countdown' ? 'countdown' : 'media' } }
        if (options.badQueue) current.pending = []
        if (options.buffer) { current.recovery = null; current.attemptId = 'old'; current.media = { currentTime: 2 } }
        return recoveryOracle(scenario, initial, { phase: 'recovery' }, current)
      },
      recoverActive: async () => { counts.recoveries++; if (options.lateAttempt) throw new CampaignError('STALE_OR_WRONG_RECOVERY', 'FAIL') }
    }
  }
  const answers = [...(options.postAnswers || [])]
  const ask = async message => {
    counts.questions++
    if (/PROXIMO \/ REPETIR|AVALIADO REPETIR/.test(message)) return answers.shift() || 'PROXIMO'
    const id = state.checkpoint
    if (id === options.cancelAt) return 'CANCELAR'
    if (id === options.skipAt) return 'PULAR'
    if (id === options.noConfirmAt) return ''
    if (id.startsWith('start-')) return 'INICIAR'
    if (id.startsWith('risk-')) return 'AUTORIZO REMOCAO ABRUPTA ' + id.slice(5)
    if (id.endsWith('-remove') || id.startsWith('remove-')) {
      counts.removes++; if (!options.noRemoval) volume.present = false
      return id.startsWith('remove-') ? 'REMOVIDO' : 'CONFIRMO'
    }
    if (id.includes('reconnect')) {
      volume.present = true
      if (options.wrongReturn) volume.key = 'b'.repeat(64)
    }
    return 'CONFIRMO'
  }
  const campaign = new UnifiedUsbCampaign({ factory, device, ask, journal, state,
    root: options.root || 'F:\\musicas', mode: options.mode || 'disposable',
    consent: options.consent || { disposableConsent: true, protectedConsent: true }, modality: 'synthetic', save: async () => {} })
  return { campaign, state, counts, dir, cleanup: () => fs.rmSync(dir, { recursive: true }), volume }
}
test('new CLI is explicit and old T3 remains compatible', () => {
  assert.equal(parseArgs(['--scenario', 'both']).campaign, false)
  assert.equal(parseArgs(['--campaign', '--media-mode', 'disposable']).scenario, 'all')
  assert.throws(() => parseArgs(['--media-mode', 'disposable']))
  assert.throws(() => parseArgs(['--campaign', '--scenario', 'garbage']))
})
for (const root of ['D:\\Musicas karaoke', 'D:\\musicas', 'F:\\other', '\\\\server\\musicas', 'G:\\musicas']) {
  test('scope rejects before native access: ' + root, () => assert.throws(() => assertTestPath(root)))
}
for (const [change, consent, mode] of [[{}, {}, 'disposable'], [{ label: 'original' }, { disposableConsent: true }, 'disposable'],
  [{ key: '' }, { disposableConsent: true }, 'disposable'], [{ busType: 'SATA' }, { disposableConsent: true }, 'disposable'],
  [{ healthy: false }, { disposableConsent: true }, 'disposable'], [{ present: false }, { disposableConsent: true }, 'disposable'],
  [{ drive: 'D:' }, { disposableConsent: true }, 'disposable'], [{}, { protectedConsent: true }, 'protected']]) {
  test('preflight fails closed ' + JSON.stringify([change, consent, mode]), () => {
    assert.throws(() => assertTestVolume(2, { ...safeVolume, ...change }, { mode, ...consent, root: 'F:\\musicas' }))
  })
}
test('explicit disposable consent permits writable test media without claiming write protection', () => {
  assert.doesNotThrow(() => assertTestVolume(2, safeVolume, { mode: 'disposable', disposableConsent: true, root: 'F:\\musicas' }))
})
test('new native provider targets only F metadata; never enumerates all volumes', async () => {
  const calls = []
  const rows = [{ drive: 'F:', label: 'testekaraoke', healthy: true, online: true, readOnly: false,
    fileSystem: 'NTFS', busType: 'USB', volume: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\', disk: 'test-id', serial: 'test-serial', offset: '1048576' }]
  const provider = createTestDeviceProvider({ libraryRoot: 'F:\\musicas', salt: 'salt', execute: cmd => {
    calls.push(cmd); return cmd.includes('fsutil') ? 'DisableLastAccess = 2' : Buffer.from(JSON.stringify(rows)).toString('base64')
  } })
  await provider.policy(); const observed = await provider.observe()
  assert.equal(observed.label, 'testekaraoke'); assert.equal(observed.healthy, true)
  assert.match(calls[1], /Get-Volume -DriveLetter 'F'/)
  assert.equal(calls[1].includes('Get-Volume |'), false)
  assert.throws(() => testVolumeCommand('D:'))
  assert.throws(() => createTestDeviceProvider({ libraryRoot: 'D:\\musicas' }))
})
test('eight-scenario simulated campaign uses independent profiles and cannot report physical PASS', async () => {
  const f = fixture()
  try {
    await f.campaign.run()
    assert.equal(f.state.history.length, 8)
    assert.equal(f.counts.factories, 8)
    assert.ok(f.state.history.every(r => r.status === 'PASS' && r.physical === false))
  } finally { f.cleanup() }
})
for (const scenario of SCENARIOS) {
  test('individual scenario ' + scenario, async () => {
    const f = fixture(); try { await f.campaign.run([scenario]); assert.equal(f.state.history.length, 1); assert.equal(f.state.history[0].status, 'PASS') } finally { f.cleanup() }
  })
}
for (const checkpoint of ['start-playing', 'risk-playing', 'remove-playing', 'reconnect-playing', 'manual-recovery-playing']) {
  for (const action of ['cancelAt', 'skipAt']) test(`${action} ${checkpoint}`, async () => {
    const f = fixture({ [action]: checkpoint })
    try { await f.campaign.run(['playing']); assert.equal(f.state.history[0].status, action === 'cancelAt' ? 'PARTIAL' : 'NOT RUN') } finally { f.cleanup() }
  })
}
for (const options of [{ noConfirmAt: 'remove-playing' }, { noRemoval: true }, { wrongReturn: true }, { consent: {} },
  { volume: { label: 'wrong' } }, { closeError: true }, { resources: { handles: 1 } }, { resources: { processes: 1 } },
  { badQueue: true }, { noModal: true }, { lateAttempt: true }]) {
  test('campaign cannot pass unsafe/false observations ' + JSON.stringify(options), async () => {
    const f = fixture(options)
    try {
      await f.campaign.run([options.resources ? 'B' : 'playing'])
      assert.notEqual(f.state.history[0].status, 'PASS')
    } finally { f.cleanup() }
  })
}
test('repeat creates fresh adapter and preserves independent summaries', async () => {
  const f = fixture({ postAnswers: ['REPETIR', 'PROXIMO'] })
  try { await f.campaign.run(['playing']); assert.equal(f.counts.factories, 2); assert.equal(f.state.history.length, 2); assert.equal(fs.readdirSync(f.dir).filter(n => n.endsWith('.json')).length, 2) } finally { f.cleanup() }
})
test('resume adopts history but not an active attempt or old profile', async () => {
  const state = { results: {}, completed: ['B'], history: [{ scenario: 'B', status: 'PASS' }] }
  const f = fixture({ state })
  try { await f.campaign.run(['B', 'paused']); assert.equal(f.counts.factories, 1); assert.equal(state.history.length, 2) } finally { f.cleanup() }
})
for (const options of [{ notReproduced: true }, { buffer: true }]) {
  test('missed phase/buffer only is PARTIAL, never manufactured physical recovery', async () => {
    const f = fixture(options)
    try { await f.campaign.run(['playing']); assert.equal(f.state.history[0].status, 'PARTIAL'); assert.equal(f.counts.recoveries, 0) } finally { f.cleanup() }
  })
}
test('functional failure never auto-advances to the next scenario', async () => {
  const f = fixture({ badQueue: true })
  try { await f.campaign.run(['playing', 'paused']); assert.equal(f.state.history.length, 1); assert.equal(f.state.history[0].status, 'FAIL') } finally { f.cleanup() }
})
test('cleanup failure stops campaign even if next is requested', async () => {
  const f = fixture({ closeError: true })
  try { await f.campaign.run(['playing', 'paused']); assert.equal(f.state.history.length, 1); assert.equal(f.state.history[0].code, 'CLEANUP_UNVERIFIED') } finally { f.cleanup() }
})
test('later infrastructure summary never overwrites earlier scenario evidence', () => {
  const f = fixture()
  try { const j = createJournal(f.dir); j.summary('playing-1', { status: 'FAIL' }); j.summary('playing-1', { status: 'PARTIAL' }); assert.equal(fs.readdirSync(f.dir).filter(n => n.endsWith('.json')).length, 2) } finally { f.cleanup() }
})

test('protected mode passes only with actual protection plus attestation', () => {
  assert.doesNotThrow(() => assertTestVolume(2, { ...safeVolume, readOnly: true }, { mode: 'protected', protectedConsent: true, root: 'F:\\musicas' }))
})
test('letter change needs matching native identity and explicit binding; D is never queried', async () => {
  let drive = 'F:', expected
  const rows = () => [{ drive, label: 'testekaraoke', healthy: true, online: true, readOnly: false,
    fileSystem: 'NTFS', busType: 'USB', volume: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\', disk: 'test-id', serial: 'test-serial', offset: '1048576' }]
  const calls = []
  const provider = createTestDeviceProvider({ libraryRoot: 'F:\\musicas', salt: 'salt', expected: () => expected, execute: cmd => {
    calls.push(cmd); return Buffer.from(JSON.stringify(rows())).toString('base64')
  } })
  expected = await provider.observe(); drive = 'G:'
  const found = await provider.identifyOtherLetter('G:')
  provider.bindVerifiedLetter(found)
  assert.equal((await provider.observe()).drive, 'G:')
  await assert.rejects(provider.identifyOtherLetter('D:'))
  assert.throws(() => provider.bindVerifiedLetter({ ...found, key: 'b'.repeat(64) }))
  assert.equal(calls.some(c => /Get-Volume -DriveLetter 'D'/.test(c)), false)
})
test('stale attempt, queue mutation, missing modal or no actual progress cannot be a physical recovery PASS', () => {
  const initial = { phase: 'playing', current: { entryId: 'current' }, attemptId: 'old', pending: [], naturalEnds: 0, media: { currentTime: 1 } }
  const frozen = { ...initial, media: { currentTime: 1 }, recovery: null }
  assert.equal(recoveryOracle('playing', initial, {}, frozen).status, 'PARTIAL')
})
test('CI and noninteractive physical campaign invocations are refused without native access', () => {
  const { spawnSync } = require('node:child_process')
  const result = spawnSync(process.execPath, [path.join(__dirname, 'manual-usb-reconnect.cjs'), '--campaign', '--authorize-physical-test', '--media-mode', 'disposable'],
    { env: { ...process.env, CI: '1' }, encoding: 'utf8' })
  assert.equal(result.status, 2); assert.match(result.stderr, /CI_FORBIDDEN/)
})

test('resumed profile list cannot point at any operational or external directory', () => {
  const { validateCampaignState } = require('./usb-campaign.cjs')
  for (const state of [{ results: [], completed: [] }, { results: {}, completed: ['unknown'] },
    { results: {}, history: [{}] }, { results: {}, scenarioProfiles: ['D:\\profile'] },
    { results: {}, scenarioProfiles: ['/operational/profile'] }]) assert.throws(() => validateCampaignState(state, os.tmpdir()))
  assert.doesNotThrow(() => validateCampaignState({ results: {}, completed: [], history: [] }, os.tmpdir()))
})
test('cleanup recognizes an already exited owned Electron process instead of waiting for a lost exit event', async () => {
  const { ElectronUsbAdapter } = require('./usb-reconnect-electron.cjs')
  const a = new ElectronUsbAdapter({ session: os.tmpdir(), checkout: __dirname, mediaRoot: os.tmpdir(), journal: { event() {} } })
  a.app = { process: () => ({ exitCode: 0, signalCode: null }), evaluate: async () => undefined }
  await a.close(); assert.equal(a.app, undefined)
})
test('target-only native query and launcher parse without executing any device command',
  { skip: process.platform !== 'win32' && 'Windows PowerShell parser only' }, () => {
    const { spawnSync } = require('node:child_process')
    const { launcher } = require('./manual-usb-reconnect.cjs')
    const code = [testVolumeCommand('F:'), testVolumeCommand('G:'), launcher('C:\\fixture', require('node:crypto').randomUUID(), false)].join('\n')
    const encoded = Buffer.from(code).toString('base64')
    const command = `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $t=$null; $e=$null; $null=[System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e); if($e.Count){exit 1}`
    assert.equal(spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).status, 0)
  })

test('buffer continuation label requires observations bracketed by native absence', () => {
  const initial = { current: { entryId: 'current' }, attemptId: 'old', pending: [], naturalEnds: 0, media: { currentTime: 1 } }
  const advanced = { ...initial, media: { currentTime: 2 }, recovery: null }
  assert.equal(recoveryOracle('playing', initial, {}, advanced).code, 'NOT_REPRODUCED')
  const observed = recoveryOracle('playing', initial, { progressWhileAbsent: true }, advanced)
  assert.equal(observed.code, 'BUFFER_CONTINUED'); assert.equal(observed.status, 'PARTIAL')
})

test('unified B measures startup independently and does not run the separate playback scenario', async () => {
  const f = fixture()
  try { await f.campaign.run(['B']); assert.equal(f.state.history[0].status, 'PASS'); assert.equal(f.counts.selectionCalls, 0) } finally { f.cleanup() }
})
