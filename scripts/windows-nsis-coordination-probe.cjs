'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows')

async function prove(addonPath, scratchRoot) {
  assert.equal(process.platform, 'win32')
  const native = require(addonPath)
  const compiler = await getMakeNsisPath()
  const source = fs.readFileSync(path.join(__dirname, '../build-resources/installer.nsh'), 'utf8')
  const fixtureSource = fs.readFileSync(path.join(scratchRoot, 'native-fixture/kq-win32.c'), 'utf8')
  const runtimeName = fixtureSource.match(/#define RUNTIME_MUTEX_NAME L"(Global\\\\com\.karaoke\.queue\.test\.runtime\.[^"]+)"/)[1].replaceAll('\\\\', '\\')
  const jobName = fixtureSource.match(/#define OPERATION_JOB_NAME L"([^"]+)"/)[1].replaceAll('\\\\', '\\')
  const sidResult = spawnSync('powershell.exe', ['-NoProfile', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8' })
  assert.equal(sidResult.status, 0)
  const sid = sidResult.stdout.trim()
  assert.match(sid, /^S-1-5-[0-9-]+$/)
  const gateFile = path.join(scratchRoot, 'operation-gate.nsh')
  fs.writeFileSync(gateFile, fs.readFileSync(path.join(__dirname, '../build-resources/installation-operation.nsh'), 'utf8')
    .replaceAll('Global\\com.karaoke.queue.install-operation.v1', jobName)
    .replaceAll('O:BAD:P(A;;0x001f003f;;;SY)(A;;0x001f003f;;;BA)', `O:${sid}D:P(A;;0x001f003f;;;${sid})`)
    .replace('  kq_operation_error:', `  kq_operation_error:
    FileOpen $9 \"${path.join(scratchRoot, 'gate-error.trace')}\" w
    FileWrite $9 \"gate-error=$R9,$0,$1,$2,$3,$7\"
    FileClose $9`))
  let functions = [...source.matchAll(/Function un\.KQ_\w+[\s\S]*?FunctionEnd/g)]
    .filter(match => !/SkipInternal/.test(match[0])).map(match => match[0]).join('\n')
  // Same production mutex code; only fixture names/admin ACL and trace writes
  // differ. Product NSIS, Program Files, ProgramData and registry are untouched.
  functions = functions.replaceAll('Global\\com.karaoke.queue.runtime.v1', runtimeName)
    .replaceAll('Global\\com.karaoke.queue.install-admin.v1', `${runtimeName}.admin`)
    .replaceAll('D:P(A;;0x001f0001;;;SY)(A;;0x001f0001;;;BA)', 'D:P(A;;0x001f0001;;;OW)')
  const finish = source.match(/!macro customUnInstallSection[\s\S]*?!macroend/)[0]
  function run(image, args, expected = 0) {
    const result = spawnSync(image, args, { encoding: 'utf8', timeout: 60000,
      env: { ...process.env, ...(compiler.env || {}) }, windowsHide: true })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, expected, `${image} ${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${fs.readdirSync(scratchRoot).filter(name => name.endsWith('.trace')).map(name => name + ':' + fs.readFileSync(path.join(scratchRoot,name),'utf8')).join('\n')}`)
  }
  assert.equal(native.openTestRuntimeReference().status, 'opened')
  try {
    for (const mode of ['silent', 'gui', 'crash', 'failure', 'stale', 'stale-operation', 'stale-installation', 'stale-kind', 'fresh']) {
      const trace = path.join(scratchRoot, `${mode}.trace`)
      const producer = path.join(scratchRoot, `${mode}-producer.exe`)
      const uninstaller = path.join(scratchRoot, `${mode}-uninstall.exe`)
      const nsi = path.join(scratchRoot, `${mode}.nsi`)
      const manifest = path.join(scratchRoot, `${mode}.json`)
      const sentinel = path.join(scratchRoot, `${mode}.sentinel`)
      const state = { formatVersion: 1, installationId: 'b7d0aca6-2b3d-4e17-9bd4-85cb23ff81dc', generation: 7,
        role: null, status: 'pending', identityRevision: 0,
        pending: { operationId: '506ed810-202f-42ea-94e5-812c72b18963', kind: 'uninstall', baseGeneration: 7, role: null },
        lastCompletedOperation: null }
      if (mode === 'fresh') { state.generation = 0; state.status = 'unconfigured'; state.pending = null }
      fs.writeFileSync(manifest, JSON.stringify(state, null, 2) + '\n')
      fs.writeFileSync(sentinel, 'synthetic preserved data')
      const helper = path.join(scratchRoot, `${mode}-delegate.cjs`)
      fs.writeFileSync(helper, `const r=require(${JSON.stringify(addonPath)}).enterInstallationOperation(); if(r.status!=='delegated') process.exit(8); require('node:fs').appendFileSync(${JSON.stringify(trace)}, 'delegate=delegated\\r\\n')`)
      const mutator = path.join(scratchRoot, `${mode}-advance.cjs`)
      const advanced = mode === 'stale-operation' ? { ...state, pending: { ...state.pending, operationId: '901eb673-54a8-4cac-8d91-4c3e31daee36' } }
        : mode === 'stale-installation' ? { ...state, installationId: '9ee1683d-15a8-429b-a8fd-43f58f75264e' }
        : mode === 'stale-kind' ? { ...state, pending: { ...state.pending, kind: 'prepare-update' } }
        : { ...state, generation: 8 }
      fs.writeFileSync(mutator, `require('node:fs').writeFileSync(${JSON.stringify(manifest)}, ${JSON.stringify(JSON.stringify(advanced, null, 2) + '\n')})`)

      const traced = functions.replace('Function un.KQ_ReleaseUninstallMutexOwnership\n', `Function un.KQ_ReleaseUninstallMutexOwnership
  System::Call 'kernel32::GetCurrentThreadId() i.r8'
  FileOpen $9 "${trace}" a
  FileSeek $9 0 END
  FileWrite $9 "release=$8$\\r$\\n"
  FileClose $9
`)
      fs.writeFileSync(nsi, `Unicode true
RequestExecutionLevel user
Name "KQ isolated ownership proof"
OutFile "${producer}"
!include LogicLib.nsh
!include TextFunc.nsh
!include "${gateFile}"
!insertmacro KQ_OPERATION_TREE "un."
!include "${path.join(__dirname, '../build-resources/installation-fence.nsh')}"
!insertmacro KQ_OPERATION_FENCE "un."
Var KQUninstallAdminMutexHandle
Var KQUninstallRuntimeMutexHandle
Var KQUninstallAdminMutexOwned
Var KQUninstallRuntimeMutexOwned
AutoCloseWindow true
UninstPage instfiles
${traced}
${finish}
Function un.onInit
  SetAutoClose true
  Call un.KQ_EnterOperationTree
  FileOpen $9 "${trace}" w
  FileWrite $9 "gate=entered"
  FileClose $9
FunctionEnd
Function un.onGUIEnd
  System::Call 'kernel32::GetCurrentThreadId() i.r8'
  FileOpen $9 "${trace}" a
  FileSeek $9 0 END
  FileWrite $9 "gui=$8$\\r$\\n"
  FileClose $9
FunctionEnd
Section
  WriteUninstaller "${uninstaller}"
SectionEnd
Section "un.Proof"
  StrCpy $KQFenceManifest "${manifest}"
  Call un.KQ_ReadOperationFence
  Call un.KQ_CreateUninstallMutexHandles
  Call un.KQ_TakeUninstallMutexes
  System::Call 'kernel32::GetCurrentThreadId() i.r8'
  FileOpen $9 "${trace}" w
  FileWrite $9 "acquire=$8$\\r$\\noperation=$KQFenceOperationId$\\r$\\n"
  FileClose $9
  ${mode.startsWith('stale') ? `ExecWait '\"${process.execPath}\" \"${mutator}\"'` : ''}
  ${mode === 'fresh' ? '' : 'Call un.KQ_AssertRemovalFence'}
  ${mode === 'crash' ? "System::Call 'kernel32::ExitProcess(i 77)'" : mode === 'failure' ? 'SetErrorLevel 2\n  Abort' : ''}
  ${mode === 'fresh' ? '' : `Delete \"${sentinel}\"`}
SectionEnd
!insertmacro customUnInstallSection
Section "un.HelperProof"
  ExecWait '\"${process.execPath}\" \"${helper}\"' $R0
  ${'${If}'} $R0 != 0
    SetErrorLevel 8
    Quit
  ${'${EndIf}'}
SectionEnd
`)
      run(compiler.path, ['/V2', nsi])
      run(producer, ['/S']) // only writes the synthetic uninstaller to scratch
      run(uninstaller, mode === 'gui' ? [`_?=${scratchRoot}`] : ['/S', `_?=${scratchRoot}`], mode === 'crash' ? 77 : (mode === 'failure' || mode.startsWith('stale')) ? 2 : 0)
      const events = Object.fromEntries(fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => line.split('=')))
      if (mode === 'crash' || mode === 'failure' || mode.startsWith('stale')) {
        assert.equal(events.release, undefined)
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'synthetic preserved data')
        assert.equal(native.acquireRuntime().status, 'abandoned')
      } else {
        assert.equal(events.delegate, 'delegated', 'the actual NSIS child helper inherits the operation tree')
        assert.equal(fs.existsSync(sentinel), mode === 'fresh', 'only a current successful intent reaches fixture removal')
        assert.match(events.operation, /^[0-9a-f-]{36}$/i)
        assert.equal(events.acquire, events.release, `${mode}: release must run on the acquiring section thread`)
        if (mode === 'gui') assert.notEqual(events.gui, events.acquire, 'GUI callback is a distinct thread')
      }
      assert.equal(native.acquireRuntime().status, 'acquired', `${mode}: no lost/recursive/abandoned lock after recovery`)
      assert.equal(native.releaseRuntime().status, 'released')
    }
    console.log('WINDOWS NSIS PRODUCTION MUTEX SECTIONS PASS GUI/silent owner-thread / crash-abandonment / failure-recovery')
  } finally { assert.equal(native.closeTestRuntimeReference().status, 'closed') }
}
prove(process.argv[2], process.argv[3]).catch(error => { console.error(error); process.exitCode = 1 })
