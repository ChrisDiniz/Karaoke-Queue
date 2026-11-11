'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { CampaignError, assertInteractive, parseLastAccess, assertProtected, assertSameVolume, assertQuiescent,
  createJournal, UsbReconnectCampaign } = require('./usb-reconnect-core.cjs')
const { createDeviceProvider, cleanupProfile } = require('./usb-reconnect-native.cjs')
const { parseArgs, assertInterop, launcher } = require('./manual-usb-reconnect.cjs')
const protectedVolume = { present: true, key: 'a'.repeat(64), drive: 'R:', online: true, readOnly: true, fileSystem: 'NTFS', busType: 'USB' }
const safe = { measurementComplete: true, idle: true, scanActive: false, activeIO: 0, handles: 0, streams: 0, grants: 0, processes: 1 }
function fake(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-t3-controller-'))
  const journal = createJournal(directory)
  const state = { results: {} }
  let active = false, present = true, seenAbsent = false, scans = 0, starts = 0, questions = 0
  const adapter = {
    start: async () => { active = true; starts++; scans++ },
    ready: async () => ({ idle: true, indexedFiles: 1, gated: true, cacheRestored: true }),
    rememberInventory: async () => {}, assertPreserved: async () => {}, quiesce: async () => {},
    selectMusic: async () => {}, close: async () => { active = false },
    resources: async () => ({ ...safe, processes: active ? 1 : 0, scanStarts: scans, ...(options.resources || {}) }),
    resumeDiscovery: async () => { if (present && seenAbsent) { scans++; seenAbsent = false } },
    availability: async value => { if (!value) seenAbsent = true; return { available: value } }
  }
  const device = { policy: async () => options.policy ?? 2,
    observe: async () => ({ ...protectedVolume, present, ...(options.volume || {}),
      ...(options.wrongReturn && state.checkpoint?.endsWith('-reconnect') ? { key: 'b'.repeat(64) } : {}) }) }
  const ask = async () => {
    questions++
    if (options.answer !== undefined) return options.answer
    if (options.cancelAt === state.checkpoint) return 'CANCELAR'
    if (options.blockAt === state.checkpoint) return 'BLOQUEADO'
    if (!options.noAction) present = !state.checkpoint.endsWith('-remove')
    return 'CONFIRMO'
  }
  const campaign = new UsbReconnectCampaign({ adapter, device, ask, journal, state, save: async () => {}, modality: 'synthetic' })
  return { campaign, state, adapter, device, directory, journal, stats: () => ({ starts, questions }),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}
for (const value of [0, 1, 2, 3]) test(`timestamp policy ${value} parses without relying on localized explanations`, () => {
  assert.equal(parseLastAccess(`DisableLastAccess = ${value} (localized text)`), value)
})
test('unknown policy cannot authorize access', () => { assert.throws(() => parseLastAccess('Access denied'), /TIMESTAMP_POLICY_UNVERIFIED/) })
test('preflight permits only verified write-protected USB/NTFS; disabled timestamps alone are insufficient', () => {
  assert.doesNotThrow(() => assertProtected(2, protectedVolume))
  for (const policy of [0, 1, 2, 3]) assert.throws(() => assertProtected(policy, { ...protectedVolume, readOnly: false }), /WRITE_PROTECTION_REQUIRED/)
})
for (const variation of [{ present: false }, { key: '' }, { fileSystem: 'exFAT' }, { busType: 'SATA' }]) {
  test(`preflight rejects unavailable/unidentified or incorrect volume ${JSON.stringify(variation)}`, () => {
    assert.throws(() => assertProtected(2, { ...protectedVolume, ...variation }))
  })
}
test('identity is independent of drive letter but a changed letter blocks automatic remapping', () => {
  assert.throws(() => assertSameVolume(protectedVolume, { ...protectedVolume, key: 'b'.repeat(64) }), /DIFFERENT_VOLUME/)
  assert.throws(() => assertSameVolume(protectedVolume, { ...protectedVolume, drive: 'S:' }), /CHANGED_LETTER/)
})
test('Windows metadata provider hashes stable volume/disk/partition identity without opening a directory', async () => {
  const calls = []
  const rows = [{ drive: 'R:', volume: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\', disk: 'disk-unique', serial: 'serial-private', offset: '1048576', fileSystem: 'NTFS', busType: 'USB', online: true, readOnly: true }]
  const provider = createDeviceProvider({ libraryRoot: 'R:\\fixture', salt: 'session-salt', execute: command => {
    calls.push(command); return command.includes('fsutil') ? 'DisableLastAccess = 2' : Buffer.from(JSON.stringify(rows)).toString('base64')
  } })
  assert.equal(await provider.policy(), 2)
  const first = await provider.observe()
  assert.match(first.key, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(first).includes('serial-private'), false)
  rows[0].drive = 'S:'
  const moved = createDeviceProvider({ libraryRoot: 'R:\\fixture', salt: 'session-salt', expected: () => first,
    execute: () => Buffer.from(JSON.stringify(rows)).toString('base64') })
  assert.equal((await moved.observe()).key, first.key)
  assert.equal((await moved.observe()).drive, 'S:')
  assert.equal(calls.some(c => /Get-ChildItem|Get-Item|Test-Path/.test(c)), false)
})
for (const settings of [{ inputTTY: false }, { outputTTY: false }, { env: { CI: '1' } }, { env: { GITHUB_ACTIONS: 'true' } }, { authorized: false }]) {
  test(`interactive guard rejects unsafe invocation ${JSON.stringify(settings)}`, () => {
    assert.throws(() => assertInteractive({ platform: 'linux', inputTTY: true, outputTTY: true, env: {}, authorized: true, ...settings }))
  })
}
test('CLI refuses CI/noninteractive use before any native preflight', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'manual-usb-reconnect.cjs'), '--authorize-physical-test'],
    { env: { ...process.env, CI: '1' }, encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /CI_FORBIDDEN/)
  assert.equal(result.stdout.includes('Sessão'), false)
})
test('Windows interop unavailable is explicitly NOT RUN', () => {
  assert.throws(() => assertInterop({ status: null }), error => error.status === 'NOT RUN')
})
test('physical CLI accepts only explicit scenarios and bounded resume IDs', () => {
  assert.equal(parseArgs(['--scenario', 'B']).scenario, 'B')
  assert.throws(() => parseArgs(['--resume', '../../profile']))
  assert.throws(() => parseArgs(['--scenario', 'C']))
  assert.throws(() => parseArgs(['--silent']))
})
test('interactive launcher uses a separate Windows console and no ejection or power command', () => {
  const script = launcher('C:\\stage', crypto.randomUUID(), false)
  assert.match(script, /Start-Process powershell.exe/)
  assert.equal(/Dismount|Set-Disk|Set-Volume|Remove-Partition|shutdown|SetSuspendState|chkdsk/i.test(script), false)
})
test('both controller scenarios complete only after actual observations, synthetic results never claim physical PASS', async () => {
  const f = fake()
  try {
    const results = await f.campaign.run()
    assert.equal(results.B.status, 'PASS'); assert.equal(results.A.status, 'PASS')
    assert.equal(results.B.physical, false); assert.equal(results.A.physical, false)
    assert.equal(f.stats().questions, 4)
  } finally { f.cleanup() }
})
for (const checkpoint of ['B-remove', 'B-reconnect', 'A-remove', 'A-reconnect']) {
  test(`cancellation at ${checkpoint} preserves evidence and safely closes the test app`, async () => {
    const f = fake({ cancelAt: checkpoint })
    try {
      const scenario = checkpoint[0]
      const result = await f.campaign.run([scenario])
      assert.equal(result[scenario].status, 'PARTIAL')
      assert.equal((await f.adapter.resources()).processes, 0)
      const events = fs.readFileSync(f.journal.eventsFile, 'utf8')
      assert.match(events, /OPERATOR_CANCELLED/)
    } finally { f.cleanup() }
  })
}
for (const [options, expected] of [[{ answer: '' }, 'NOT RUN'], [{ noAction: true }, 'FAIL'],
  [{ wrongReturn: true }, 'FAIL'], [{ blockAt: 'B-remove' }, 'BLOCKED'],
  [{ volume: { readOnly: false } }, 'BLOCKED']]) {
  test(`controller refuses missing confirmation/action, wrong identity or unsafe metadata policy: ${JSON.stringify(options)}`, async () => {
    const f = fake(options)
    try {
      assert.equal((await f.campaign.run(['B'])).B.status, expected)
      if (options.volume) assert.equal(f.stats().starts, 0, 'preflight must block before library access')
    } finally { f.cleanup() }
  })
}
for (const resources of [{ measurementComplete: false }, { handles: 1 }, { activeIO: 1 }, { scanActive: true }, { streams: 1 }, { idle: false }, { processes: 1 }]) {
  test(`no human removal prompt with active or unverified resources ${JSON.stringify(resources)}`, async () => {
    const f = fake({ resources })
    try {
      const result = await f.campaign.run(['B'])
      assert.equal(result.B.status, 'BLOCKED')
      assert.equal(f.stats().questions, 0)
    } finally { f.cleanup() }
  })
}
test('metric failure retains earlier JSONL and produces FAIL, never PASS', async () => {
  const f = fake()
  try {
    f.adapter.ready = async () => { throw new Error('collection failed') }
    assert.equal((await f.campaign.run(['B'])).B.status, 'FAIL')
    const events = fs.readFileSync(f.journal.eventsFile, 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(events.some(r => r.type === 'safety-verified'))
    assert.ok(events.some(r => r.type === 'scenario-error'))
  } finally { f.cleanup() }
})
test('resuming creates new evidence segments and preserves previous summaries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-t3-journal-'))
  try {
    const first = createJournal(directory); first.event('before'); first.summary('B', { status: 'PARTIAL' })
    const second = createJournal(directory); second.event('after'); second.summary('B', { status: 'PASS' })
    assert.notEqual(first.eventsFile, second.eventsFile)
    assert.equal(fs.readdirSync(directory).length, 4)
    assert.match(fs.readFileSync(first.eventsFile, 'utf8'), /before/)
  } finally { fs.rmSync(directory, { recursive: true }) }
})
for (const variant of ['active', 'wrong-owner', 'symlink', 'safe']) {
  test(`owned-profile cleanup protects operational/unrelated data: ${variant}`, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-t3-cleanup-'))
    const id = crypto.randomUUID(), session = path.join(base, 'KQ-T3-' + id)
    const profile = path.join(session, 'profile'), outside = path.join(base, 'outside')
    fs.mkdirSync(session); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'untouched')
    fs.writeFileSync(path.join(session, 'owner.json'), JSON.stringify({ kind: 'KQ-T3-ISOLATED', id: variant === 'wrong-owner' ? 'wrong' : id }))
    if (variant === 'symlink' && process.platform === 'win32') {
      fs.symlinkSync(outside, profile, 'junction')
    } else if (variant === 'symlink') fs.symlinkSync(outside, profile, 'dir')
    else fs.mkdirSync(profile)
    try {
      if (variant === 'safe') await cleanupProfile(session, id, async () => 0, base)
      else await assert.rejects(cleanupProfile(session, id, async () => variant === 'active' ? 1 : 0, base))
      assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'untouched')
      assert.equal(fs.existsSync(profile), variant !== 'safe')
    } finally { fs.rmSync(base, { recursive: true }) }
  })
}
test('no default runner or CI suite can select the physical entry point', () => {
  const { selectWindowsTestSuites } = require('./run-windows-native-tests.cjs')
  for (const mode of [null, '--video-library', '--standalone-production']) {
    assert.equal(selectWindowsTestSuites(mode).some(s => /manual-usb|usb-reconnect-main-entry/.test(s.script)), false)
  }
  assert.equal(fs.readFileSync(path.join(__dirname, 'run-e2e-linux.cjs'), 'utf8').includes('manual-usb-reconnect'), false)
})

test('preflight orders policy/identity/write protection before any root validation or app start', async () => {
  const f = fake({ volume: { readOnly: false } })
  let validations = 0
  f.device.validateRoot = async () => { validations++ }
  try {
    assert.equal((await f.campaign.run(['B'])).B.status, 'BLOCKED')
    assert.equal(validations, 0)
    assert.equal(f.stats().starts, 0)
  } finally { f.cleanup() }
})
test('generated interactive launcher parses in PowerShell without executing any statement',
  { skip: process.platform !== 'win32' && 'Windows parser required; no device command executed' }, () => {
    const script = launcher('C:\\test-stage', crypto.randomUUID(), false) + '\n' + require('./usb-reconnect-native.cjs').VOLUMES_COMMAND
    const encoded = Buffer.from(script).toString('base64')
    const command = `$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ` +
      '$tokens=$null; $parseErrors=$null; $null=[System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$parseErrors); ' +
      'if($parseErrors.Count){$parseErrors | ForEach-Object {$_.Message}; exit 1}'
    const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
  })

test('empty process query is unverified, never interpreted as zero processes', async () => {
  const { profileProcesses } = require('./usb-reconnect-native.cjs')
  await assert.rejects(profileProcesses('C:\\test-profile', 'C:\\test-checkout', () => ''), /PROCESS_STATE_UNVERIFIED/)
})
test('profile adoption refuses a hard-link alias before Electron can open SQLite or preferences', () => {
  const { assertPrivateTree } = require('./usb-reconnect-native.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-t3-profile-'))
  try {
    const outside = path.join(root, 'outside.sqlite'), profile = path.join(root, 'profile')
    fs.mkdirSync(profile); fs.writeFileSync(outside, 'protected unrelated fixture')
    fs.linkSync(outside, path.join(profile, 'player-music-catalog.sqlite'))
    assert.throws(() => assertPrivateTree(profile), /PROFILE_HARDLINK_FORBIDDEN/)
    assert.equal(fs.readFileSync(outside, 'utf8'), 'protected unrelated fixture')
  } finally { fs.rmSync(root, { recursive: true }) }
})

test('human checkpoint timeout retains evidence and cannot advance to reconnection', async () => {
  const f = fake()
  f.campaign.ask = async () => { throw new CampaignError('HUMAN_CONFIRMATION_TIMEOUT', 'NOT RUN') }
  try {
    assert.equal((await f.campaign.run(['B'])).B.status, 'NOT RUN')
    assert.equal((await f.adapter.resources()).processes, 0)
    assert.match(fs.readFileSync(f.journal.eventsFile, 'utf8'), /HUMAN_CONFIRMATION_TIMEOUT/)
  } finally { f.cleanup() }
})
test('already cancelled prompt never waits for operator input', async () => {
  const { askFactory } = require('./manual-usb-reconnect.cjs')
  const controller = new AbortController(); controller.abort()
  let questions = 0
  await assert.rejects(askFactory({ question: async () => { questions++ } }, controller.signal)('confirm'), /OPERATOR_CANCELLED/)
  assert.equal(questions, 0)
})

test('Electron entry requires a session permission and confines CI to synthetic fixtures', () => {
  const { validateEntryPermit } = require('./usb-reconnect-core.cjs')
  const session = path.join(os.tmpdir(), 'fixture-session'), mediaRoot = path.join(session, 'fixture')
  const input = { session, mediaRoot, profile: path.join(session, 'profile'), nonce: 'a'.repeat(64), ci: true }
  const synthetic = { session, mediaRoot, nonce: input.nonce, modality: 'synthetic' }
  assert.doesNotThrow(() => validateEntryPermit(synthetic, input))
  assert.throws(() => validateEntryPermit(undefined, input))
  assert.throws(() => validateEntryPermit({ ...synthetic, nonce: 'b'.repeat(64) }, input))
  assert.throws(() => validateEntryPermit({ ...synthetic, modality: 'physical', preflightApproved: true }, input))
  assert.throws(() => validateEntryPermit(synthetic, { ...input, profile: path.join(os.tmpdir(), 'unrelated-profile') }))
})
