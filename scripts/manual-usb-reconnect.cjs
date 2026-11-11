'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { createInterface } = require('node:readline/promises')
const { CampaignError, assertInteractive, createJournal, UsbReconnectCampaign } = require('./usb-reconnect-core.cjs')
const native = require('./usb-reconnect-native.cjs')
const official = require('./run-windows-native-tests.cjs')

function parseArgs(args) {
  const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const resume = value('--resume')
  if (resume && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(resume)) throw new CampaignError('INVALID_SESSION_ID')
  const campaign = args.includes('--campaign')
  const mediaMode = value('--media-mode') || 'protected'
  if (!['protected', 'disposable'].includes(mediaMode) || !campaign && mediaMode !== 'protected') throw new CampaignError('MEDIA_MODE_REQUIRED')
  const scenario = value('--scenario') || (campaign ? 'all' : 'both')
  const scenarios = campaign ? [...require('./usb-campaign.cjs').SCENARIOS, 'all'] : ['A', 'B', 'both']
  if (!scenarios.includes(scenario)) throw new CampaignError('INVALID_SCENARIO')
  for (let i = 0; i < args.length; i++) {
    if (['--resume', '--scenario', '--worker', '--media-mode'].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new CampaignError('MISSING_ARGUMENT')
      i++; continue
    }
    if (!['--authorize-physical-test', '--approve-untracked', '--help', '--campaign', '--repeat-completed'].includes(args[i])) throw new CampaignError('UNKNOWN_ARGUMENT')
  }
  return { resume, scenario, campaign, mediaMode, repeatCompleted: args.includes('--repeat-completed'), authorized: args.includes('--authorize-physical-test'), worker: value('--worker'), help: args.includes('--help') }
}
function askFactory(rl, signal) {
  return async text => {
    if (signal?.aborted) throw new CampaignError('OPERATOR_CANCELLED', 'PARTIAL')
    const timeout = new AbortController()
    const cancel = () => timeout.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => timeout.abort(), 10 * 60 * 1000)
    try { return (await rl.question(text, { signal: timeout.signal })).trim() }
    catch { throw new CampaignError(signal?.aborted ? 'OPERATOR_CANCELLED' : 'HUMAN_CONFIRMATION_TIMEOUT', 'PARTIAL') }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
  }
}
function psQuote(value) { return "'" + value.replaceAll("'", "''") + "'" }
function launcher(stage, id, resume) {
  // Only internal session paths and the local snapshot are touched by this preparer.
  return `$ErrorActionPreference='Stop';
$base=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()); if([IO.Path]::GetPathRoot($base).TrimEnd('\\') -ine $env:SystemDrive){throw 'TEMP precisa estar no disco interno de sistema'};
$cursor=[IO.Path]::GetPathRoot($base); foreach($piece in $base.Substring($cursor.Length).Split([char]92)) {
  if(-not $piece){continue}; $cursor=Join-Path $cursor $piece; $directory=Get-Item -LiteralPath $cursor -Force;
  if(-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'TEMP deve ter ancestrais internos sem reparse point'}
};
$session=Join-Path $base ${psQuote('KQ-T3-' + id)};
if(Test-Path -LiteralPath $session){
  $item=Get-Item -LiteralPath $session; if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Session reparse point'};
  $ownerFile=Get-Item -LiteralPath (Join-Path $session 'owner.json') -Force; if($ownerFile.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Owner reparse point'};
  $owner=Get-Content -LiteralPath $ownerFile.FullName -Raw | ConvertFrom-Json;
  if($owner.id -ne ${psQuote(id)} -or $owner.kind -ne 'KQ-T3-ISOLATED'){throw 'Session owner mismatch'}
} else {
  ${resume ? "throw 'Sessão para retomar não existe'" : `New-Item -ItemType Directory -Path $session | Out-Null; [IO.File]::WriteAllText((Join-Path $session 'owner.json'), ${psQuote(JSON.stringify({ kind: 'KQ-T3-ISOLATED', id }))})`}
};
$local=Join-Path $session ('stage-'+[guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $local | Out-Null;
Copy-Item -Path (${psQuote(stage)}+'\\*') -Destination $local -Recurse;
$node=(Get-Command node.exe -ErrorAction Stop).Source;
$worker=Join-Path $local 'tree\\scripts\\manual-usb-reconnect.cjs';
$start=Join-Path $local 'interactive.ps1';
$line='& '+[char]39+$node.Replace([string][char]39,([string][char]39+[char]39))+[char]39+' '+[char]39+$worker.Replace([string][char]39,([string][char]39+[char]39))+[char]39+' --authorize-physical-test --worker '+[char]39+$local+[char]39;
[IO.File]::WriteAllText($start, $line+[Environment]::NewLine+'$result=$LASTEXITCODE; if($result -ne 0){Read-Host "Teste interrompido. Nao execute nova remocao. Confira os relatorios da sessao; Enter para fechar"}; exit $result', [Text.UTF8Encoding]::new($true));
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([IO.File]::ReadAllText($start)));
$p=Start-Process powershell.exe -ArgumentList ('-NoProfile -EncodedCommand '+$encoded) -PassThru -Wait; exit $p.ExitCode;
`
}
function assertInterop(result) { if (result.status !== 0) throw new CampaignError('WINDOWS_INTEROP_UNAVAILABLE', 'NOT RUN') }
async function orchestrate(options, ask) {
  if (process.platform !== 'linux' || !process.env.WSL_DISTRO_NAME) throw new CampaignError('START_FROM_WSL_SOURCE_REQUIRED')
  const root = path.resolve(__dirname, '..')
  const parentReports = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-t3-orchestration-'))
  const journal = createJournal(parentReports)
  journal.event('orchestration-start', { modality: 'physical', noDeviceAccessYet: true })
  try {
  if (await ask('Teste físico manual. Nenhum dispositivo será ejetado pelo programa. Para autorizar esta execução, digite AUTORIZO T3 FISICO: ') !== 'AUTORIZO T3 FISICO') {
    throw new CampaignError('EXPLICIT_PHYSICAL_AUTHORIZATION_REQUIRED')
  }
  const interop = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' })
  assertInterop(interop)
  const manifest = official.readSourceSnapshot(root)
  await official.approveUntracked(manifest.files.filter(f => f.kind === 'untracked'))
  const stage = official.stageSnapshot(root, manifest, null, os.tmpdir(), { bootstrapBundle: true })
  const id = options.resume || crypto.randomUUID()
  const nonce = crypto.randomBytes(32).toString('hex')
  const auth = { id, nonce, fingerprint: manifest.fingerprint, scenario: options.scenario, campaign: options.campaign, mediaMode: options.mediaMode, repeatCompleted: options.repeatCompleted, resume: Boolean(options.resume), authorizedAt: Date.now() }
  fs.writeFileSync(path.join(stage, 'metadata/t3-authorization.json'), JSON.stringify(auth), { mode: 0o600, flag: 'wx' })
  const converted = spawnSync('wslpath', ['-w', stage], { encoding: 'utf8' })
  if (converted.status !== 0) throw new CampaignError('WSL_PATH_CONVERSION_FAILED')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand',
    Buffer.from(launcher(converted.stdout.trim(), id, options.resume), 'utf16le').toString('base64')],
  { stdio: 'inherit', env: { ...process.env, KQ_T3_AUTH_NONCE: nonce, WSLENV: [...(process.env.WSLENV || '').split(':').filter(v => v && v.split('/')[0] !== 'KQ_T3_AUTH_NONCE'), 'KQ_T3_AUTH_NONCE/w'].join(':') } })
  if (official.readSourceSnapshot(root).fingerprint !== manifest.fingerprint) throw new CampaignError('SOURCE_CHANGED_DURING_PHYSICAL_CAMPAIGN', 'FAIL')
  if (result.status !== 0) throw new CampaignError('NATIVE_INTERACTIVE_CAMPAIGN_INCOMPLETE', 'PARTIAL')
  journal.event('orchestration-complete', { status: 'PASS', session: id, fingerprint: manifest.fingerprint })
  } catch (error) {
    journal.event('orchestration-error', { status: error.status || 'BLOCKED', code: error.code || 'PREPARATION_FAILED' })
    console.error('Evidência de preparação preservada em ' + parentReports)
    throw error
  }
}
function atomicState(file, value) {
  const temporary = file + '.tmp-' + crypto.randomUUID()
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, file)
}
async function worker(stage, ask, signal) {
  if (process.platform !== 'win32') throw new CampaignError('NATIVE_WINDOWS_REQUIRED', 'NOT RUN')
  const parent = path.dirname(path.resolve(stage))
  if (path.dirname(parent).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() ||
      !/^KQ-T3-[a-f0-9-]{36}$/.test(path.basename(parent)) || !/^stage-[a-f0-9]{32}$/.test(path.basename(stage))) {
    throw new CampaignError('NATIVE_STAGE_SCOPE_INVALID')
  }
  native.assertInternalSession(parent, path.basename(parent).slice(6))
  native.assertNoReparse(stage)
  const authFile = path.join(stage, 'metadata/t3-authorization.json')
  const authStat = fs.lstatSync(authFile)
  if (!authStat.isFile() || authStat.isSymbolicLink() || authStat.nlink !== 1) throw new CampaignError('INTERACTIVE_AUTHORIZATION_INVALID')
  const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'))
  if (!/^[a-f0-9]{64}$/.test(auth.nonce) || auth.nonce !== process.env.KQ_T3_AUTH_NONCE ||
      Date.now() - auth.authorizedAt > 60 * 60 * 1000) throw new CampaignError('INTERACTIVE_AUTHORIZATION_INVALID')
  const session = path.join(os.tmpdir(), 'KQ-T3-' + auth.id)
  if (path.parse(session).root.toLowerCase() !== process.env.SystemDrive.toLowerCase() + '\\') throw new CampaignError('INTERNAL_SESSION_DRIVE_REQUIRED')
  native.assertInternalSession(session, auth.id)
  const journal = createJournal(path.join(session, 'reports'))
  let state
  journal.event('infrastructure-start', { modality: 'physical', session: auth.id })
  try {
  const manifest = official.validateManifest(JSON.parse(fs.readFileSync(path.join(stage, 'metadata/snapshot.json'), 'utf8')))
  if (manifest.fingerprint !== auth.fingerprint) throw new CampaignError('AUTHORIZATION_SNAPSHOT_MISMATCH')
  const stateFile = path.join(session, 'private-state.json')
  if (auth.resume) {
    const st = fs.lstatSync(stateFile)
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new CampaignError('PRIVATE_STATE_LINK_FORBIDDEN')
  }
  state = auth.resume ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) :
    { version: 1, fingerprint: manifest.fingerprint, salt: crypto.randomBytes(32).toString('hex'), results: {} }
  if (!state || state.version !== 1 || !/^[a-f0-9]{64}$/.test(state.salt || '') || !state.results || typeof state.results !== 'object') throw new CampaignError('PRIVATE_STATE_INVALID')
  const codeFingerprint = crypto.createHash('sha256').update(JSON.stringify({ head: manifest.head, branch: manifest.branch,
    files: manifest.files.filter(f => !f.path.startsWith('docs/')).map(f => [f.path, f.sha256]) })).digest('hex')
  if ((auth.resume && !/^[a-f0-9]{64}$/.test(state.codeFingerprint || '')) || (state.codeFingerprint && state.codeFingerprint !== codeFingerprint)) throw new CampaignError('RESUME_REQUIRES_SAME_CODE_SNAPSHOT')
  state.codeFingerprint = codeFingerprint
  state.fingerprint = manifest.fingerprint
  atomicState(stateFile, state)
  if (state.checkout && await native.profileProcesses(path.join(session, 'profile'), state.checkout)) throw new CampaignError('PREVIOUS_TEST_PROCESS_STILL_ACTIVE')
  let consent = {}, libraryRoot, device
  if (auth.campaign) {
    const { RISK_TEXT, assertTestVolume, validateCampaignState } = require('./usb-campaign.cjs')
    validateCampaignState(state, session)
    if (state.campaignMode && state.campaignMode !== auth.mediaMode) throw new CampaignError('RESUME_MEDIA_MODE_MISMATCH')
    state.campaignMode = auth.mediaMode
    libraryRoot = 'F:\\musicas'
    console.log(RISK_TEXT)
    console.log('Sessão para retomada: ' + auth.id + '; apenas o pendrive testekaraoke autorizado, nunca D:.')
    if (auth.mediaMode === 'disposable') {
      if (await ask('Confirme que o pendrive contém somente cópias descartáveis: SEM DADOS IMPORTANTES testekaraoke / CANCELAR: ') !== 'SEM DADOS IMPORTANTES testekaraoke') throw new CampaignError('DISPOSABLE_CONSENT_REQUIRED')
      if (await ask('Aceita os riscos nesta sessão? ACEITO RISCO DESCARTAVEL testekaraoke / CANCELAR: ') !== 'ACEITO RISCO DESCARTAVEL testekaraoke') throw new CampaignError('DISPOSABLE_CONSENT_REQUIRED')
      consent.disposableConsent = true // never restored from private-state
    } else {
      if (await ask('Proteção efetiva validada externamente? PROTECAO VERIFICADA / CANCELAR: ') !== 'PROTECAO VERIFICADA') throw new CampaignError('WRITE_PROTECTION_ATTESTATION_MISSING')
      consent.protectedConsent = true
    }
    device = native.createTestDeviceProvider({ libraryRoot, salt: state.salt, expected: () => state.volume })
    if (state.authorizedRoot && state.authorizedRoot !== libraryRoot) {
      require('./usb-campaign.cjs').assertTestPath(state.authorizedRoot, false)
      const drive = state.authorizedRoot.slice(0, 2)
      const verified = await device.identifyOtherLetter(drive)
      if (await ask('Para retomar com a letra já identificada, confirme explicitamente: CONFIRMO LETRA ' + drive + ' / CANCELAR: ') !== 'CONFIRMO LETRA ' + drive) throw new CampaignError('RESUME_CANCELLED', 'PARTIAL')
      device.bindVerifiedLetter(verified); libraryRoot = state.authorizedRoot
    }
    const policy = await device.policy()
    let volume = await device.observe()
    if (!volume.present && auth.resume) {
      if (await ask('Com os apps de teste fechados, reconecte somente testekaraoke protegido/descartável autorizado. CONFIRMO / CANCELAR: ') !== 'CONFIRMO') throw new CampaignError('RESUME_CANCELLED', 'PARTIAL')
      volume = await device.observe()
    }
    assertTestVolume(policy, volume, { mode: auth.mediaMode, ...consent, root: libraryRoot, expectedKey: state.volume?.key })
    if (state.volume && state.volume.key !== volume.key) throw new CampaignError('DIFFERENT_VOLUME_RECONNECTED')
    state.volume ||= volume
    // Do not adopt an operational profile from an interrupted scenario.
    for (const profile of state.scenarioProfiles || []) if (await native.profileProcesses(profile, state.checkout)) throw new CampaignError('PREVIOUS_TEST_PROCESS_STILL_ACTIVE')
    await device.validateRoot()
    journal.event('campaign-session-consent', { mode: auth.mediaMode, riskAcceptedThisRun: Boolean(consent.disposableConsent),
      writeProtectionClaimed: auth.mediaMode === 'protected', policy, volumeKey: volume.key, fingerprint: manifest.fingerprint })
  } else {
  console.log('T3 físico: use somente um volume protegido contra escrita e remoção segura do Windows. CANCELAR interrompe e preserva o perfil/relatórios.')
  console.log('Sessão para retomada: ' + auth.id)
  if (await ask('A proteção contra escrita foi validada externamente? Digite PROTECAO VERIFICADA ou CANCELAR: ') !== 'PROTECAO VERIFICADA') throw new CampaignError('WRITE_PROTECTION_ATTESTATION_MISSING')
  const supplied = await ask('Informe a pasta autorizada da biblioteca (caminho local absoluto; não será publicado no relatório): ')
  if (supplied === 'CANCELAR') throw new CampaignError('OPERATOR_CANCELLED', 'PARTIAL')
  if (!path.isAbsolute(supplied) || supplied.startsWith('\\\\')) throw new CampaignError('ABSOLUTE_LOCAL_VOLUME_PATH_REQUIRED')
  libraryRoot = path.resolve(supplied)
  if (state.libraryRoot && state.libraryRoot.toLowerCase() !== libraryRoot.toLowerCase()) throw new CampaignError('RESUME_LIBRARY_MISMATCH')
  state.libraryRoot = libraryRoot
  device = native.createDeviceProvider({ libraryRoot, salt: state.salt, expected: () => state.volume })
  // Mandatory preflight BEFORE lstat/realpath/enumeration of the library, including on resume.
  const { assertProtected, assertSameVolume } = require('./usb-reconnect-core.cjs')
  const policy = await device.policy()
  let volume = await device.observe()
  if (!volume.present && auth.resume) {
    if (await ask('Para retomar, reconecte o HD protegido com o aplicativo fechado. Confirme com CONFIRMO ou CANCELAR: ') !== 'CONFIRMO') throw new CampaignError('RESUME_CANCELLED', 'PARTIAL')
    await device.policy(); volume = await device.observe()
  }
  assertProtected(policy, volume)
  if (state.volume) assertSameVolume(state.volume, volume)
  state.volume ||= volume
  native.assertNoReparse(libraryRoot)
  journal.event('preflight', { policy, volumeKey: volume.key, readOnly: volume.readOnly, attestation: true,
    fingerprint: manifest.fingerprint, branch: manifest.branch, head: manifest.head, platform: process.platform,
    node: process.versions.node, profile: 'profile (isolated internal session)', modality: 'physical' })

  }
  const checkout = path.join(session, 'checkout-' + crypto.randomUUID())
  const bundle = path.join(stage, 'metadata/source-head.bundle')
  const clone = spawnSync('git.exe', ['clone', '--branch', manifest.branch, bundle, checkout], { encoding: 'utf8' })
  if (clone.status !== 0) throw new CampaignError('ISOLATED_CHECKOUT_CLONE_FAILED')
  state.checkout = checkout
  atomicState(stateFile, state)
  const release = official.acquireLock(checkout, auth.id)
  try {
    const backup = path.join(session, 'sync-backup-' + crypto.randomUUID())
    fs.mkdirSync(backup)
    const records = []
    official.syncSnapshot(checkout, stage, manifest, { files: [] }, auth.id, false, backup, records)
    official.verifySnapshotDirectory(checkout, manifest)
    official.cleanupSyncBackup(backup, records)
    for (const command of ['npm.cmd ci', 'npm.cmd run compile']) {
      const run = spawnSync('cmd.exe', ['/d', '/s', '/c', command], { cwd: checkout, encoding: 'utf8',
        env: { ...process.env, npm_config_cache: path.join(session, 'npm-cache'), ELECTRON_CACHE: path.join(session, 'electron-cache') },
        maxBuffer: 16 * 1024 * 1024 })
      fs.appendFileSync(path.join(session, 'reports/preparation.log'), (run.stdout || '') + (run.stderr || ''))
      if (run.status !== 0) throw new CampaignError('NATIVE_PREPARATION_FAILED')
    }
    official.verifySnapshotDirectory(checkout, manifest)
    official.verifyBuildOutput(checkout, manifest)
    if (auth.campaign) {
      const { UnifiedUsbCampaign, SCENARIOS } = require('./usb-campaign.cjs')
      const { CampaignElectronAdapter } = require(path.join(checkout, 'scripts/usb-campaign-electron.cjs'))
      const selected = auth.scenario === 'all' ? SCENARIOS : [auth.scenario]
      state.completed ||= []
      if (auth.repeatCompleted) state.completed = state.completed.filter(s => !selected.includes(s))
      const factory = async (scenario, attempt, scenarioRoot) => {
        const child = path.join(session, 'scenario-' + scenario + '-' + attempt + '-' + crypto.randomUUID())
        fs.mkdirSync(child)
        atomicState(path.join(child, 'entry-permit.json'), { nonce: auth.nonce, session: child, mediaRoot: scenarioRoot,
          modality: 'physical', preflightApproved: true })
        state.scenarioProfiles ||= []; state.scenarioProfiles.push(path.join(child, 'profile'))
        atomicState(stateFile, state)
        journal.event('campaign-profile-created', { scenario, attempt, profileId: path.basename(child) })
        return new CampaignElectronAdapter({ checkout, session: child, mediaRoot: scenarioRoot, journal, signal,
          entryNonce: auth.nonce, processes: profile => native.profileProcesses(profile, checkout) })
      }
      const controller = new UnifiedUsbCampaign({ factory, device, ask, journal, state, signal, root: libraryRoot,
        mode: auth.mediaMode, consent, save: value => atomicState(stateFile, value) })
      await controller.run(selected)
      official.verifySnapshotDirectory(checkout, manifest)
      const done = selected.every(id => state.results[id]?.status === 'PASS' && state.completed.includes(id))
      journal.event('unified-campaign-complete', { status: done ? 'PASS' : 'PARTIAL', scenarios: selected,
        fingerprint: manifest.fingerprint, physical: true })
      console.log('Evidências progressivas preservadas na sessão ' + auth.id + ', pasta reports; perfis por cenário mantidos.')
      if (!done) throw new CampaignError('PHYSICAL_CAMPAIGN_INCOMPLETE', 'PARTIAL')
    } else {
    atomicState(path.join(session, 'entry-permit.json'), { nonce: auth.nonce, session, mediaRoot: libraryRoot,
      modality: 'physical', preflightApproved: true })
    const { ElectronUsbAdapter } = require(path.join(checkout, 'scripts/usb-reconnect-electron.cjs'))
    const adapter = new ElectronUsbAdapter({ checkout, session, mediaRoot: libraryRoot, journal, signal,
      entryNonce: auth.nonce, processes: profile => native.profileProcesses(profile, checkout) })
    const campaign = new UsbReconnectCampaign({ adapter, device, ask, journal, state, signal,
      save: value => atomicState(stateFile, value) })
    const scenarios = auth.scenario === 'both' ? ['B', 'A'] : [auth.scenario]
    const results = await campaign.run(scenarios)
    console.log('Relatórios preservados na sessão ' + auth.id + ', pasta reports. Perfil mantido para retomada.')
    if (!scenarios.every(name => results[name]?.status === 'PASS')) throw new CampaignError('PHYSICAL_SCENARIO_INCOMPLETE', 'PARTIAL')
    if (await ask('Encerramento confirmado. Digite APAGAR PERFIL para remover só o perfil de teste, ou MANTER para preservá-lo: ') === 'APAGAR PERFIL') {
      await native.cleanupProfile(session, auth.id, () => native.profileProcesses(path.join(session, 'profile'), checkout))
      journal.event('owned-test-profile-removed')
    }


    }
    official.verifySnapshotDirectory(checkout, manifest)
  } finally { release() }
  } catch (error) {
    journal.event('infrastructure-error', { status: error.status || 'BLOCKED', code: error.code || 'T3_INFRASTRUCTURE_FAILURE' })
    for (const name of auth.campaign ? (auth.scenario === 'all' ? require('./usb-campaign.cjs').SCENARIOS : [auth.scenario]) : auth.scenario === 'both' ? ['B', 'A'] : [auth.scenario]) {
      if (auth.campaign && state?.results?.[name] || state?.results?.[name]?.status === 'PASS') continue
      const result = state?.results?.[name] || { status: error.status || 'BLOCKED', code: error.code || 'T3_INFRASTRUCTURE_FAILURE', physical: true }
      journal.summary(auth.campaign ? name + '-1' : name, result)
    }
    throw error
  }
}
async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Uso no WSL: npm run test:manual:usb-reconnect -- --authorize-physical-test [--scenario B|A|both] [--resume UUID] [--approve-untracked]')
    console.log('Campanha: npm run test:manual:usb-campaign -- --authorize-physical-test --media-mode disposable [--scenario all|B|A|playing|paused|countdown|loading|transition|celebration] [--resume UUID] [--repeat-completed]')
    console.log('Exige terminal interativo, autorização humana, Windows nativo e USB/NTFS protegido contra escrita. Nunca ejeta dispositivos. Não executar nesta tarefa de criação.')
    return
  }
  assertInteractive({ platform: process.platform, inputTTY: process.stdin.isTTY, outputTTY: process.stdout.isTTY,
    env: process.env, authorized: options.authorized })
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  rl.on('SIGINT', cancel)
  const ask = askFactory(rl, controller.signal)
  try {
    if (options.worker) await worker(options.worker, ask, controller.signal)
    else await orchestrate(options, ask)
  } finally { rl.close(); process.removeListener('SIGINT', cancel) }
}
if (require.main === module) main().catch(error => {
  console.error((error.status || 'BLOCKED') + ': ' + (error.code || 'T3_INFRASTRUCTURE_FAILURE'))
  if (error.code === 'WRITE_PROTECTION_REQUIRED') console.error('LastAccessTime e outros metadados não são garantidos por open read-only. Prepare proteção de escrita validada fora deste runner; nenhuma política será alterada.')
  process.exitCode = 2
})
module.exports = { parseArgs, askFactory, launcher, assertInterop }
