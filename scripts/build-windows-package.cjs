'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { SEAL_NAME, buildInputFingerprint, writeBuildSeal } = require('./windows-build-provenance.cjs')
const { verifyWindowsBuild } = require('./verify-windows-build.cjs')

function electronChecksumOptions(version, checksums) {
  const artifact = `electron-v${version}-win32-x64.zip`
  const checksum = checksums?.[artifact]
  if (typeof checksum !== 'string' || !/^[0-9a-f]{64}$/i.test(checksum)) {
    throw new Error(`Locked Electron package has no trusted checksum for ${artifact}`)
  }
  // Same map used by Electron's own npm postinstall. Keep validation enabled
  // without fetching SHASUMS again when the official archive is already cached.
  return { checksums: { [artifact]: checksum } }
}

async function buildWindowsPackage(root = path.resolve(__dirname, '..')) {
  const { Arch, Platform, build } = require('electron-builder')
  const outputDirectory = path.join(root, 'dist')
  fs.mkdirSync(outputDirectory, { recursive: true })
  const sealPath = path.join(outputDirectory, SEAL_NAME)
  fs.rmSync(sealPath, { force: true })
  const inputsBefore = buildInputFingerprint(root).fingerprint
  const electronPackage = require('electron/package.json')
  const electronChecksums = require('electron/checksums.json')
  await build({ targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never',
    config: { electronDownload: electronChecksumOptions(electronPackage.version, electronChecksums) } })

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const installer = pkg.build.artifactName.replaceAll('${version}', pkg.version)
    .replaceAll('${arch}', 'x64').replaceAll('${ext}', 'exe')
  const outputs = [
    installer,
    'win-unpacked/Karaoke Queue.exe',
    'win-unpacked/resources/app.asar',
    'win-unpacked/resources/native/win32-x64/kq_win32.node'
  ]
  for (const relativePath of outputs) {
    const outputPath = path.join(outputDirectory, relativePath)
    if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) {
      throw new Error(`electron-builder returned without a complete output: ${relativePath}`)
    }
  }
  if (fs.readdirSync(outputDirectory).some(name => name.endsWith('.__uninstaller.exe'))) {
    throw new Error('NSIS left an intermediate uninstaller; refusing to seal a partial build.')
  }
  const inputsAfter = buildInputFingerprint(root).fingerprint
  if (inputsAfter !== inputsBefore) throw new Error('Windows build inputs changed while electron-builder was running.')
  const seal = writeBuildSeal(root, outputs)
  process.stdout.write(`Windows build sealed commit=${seal.commit} inputFingerprint=${seal.inputFingerprint}\n`)
  return seal
}

// Do not trust the builder process's exit code alone. A dependency can reset it
// during cleanup (electron-builder's own CLI installs a sticky exit handler).
// A fresh seal AND the full package verifier are the completion handshake.
function runSupervisedBuild(root = path.resolve(__dirname, '..'), workerFile = __filename) {
  fs.rmSync(path.join(root, 'dist', SEAL_NAME), { force: true })
  const result = spawnSync(process.execPath, [workerFile, '--build-worker'], {
    cwd: root, stdio: 'inherit', shell: false
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Windows build worker failed: exit=${result.status} signal=${result.signal}`)
  const report = verifyWindowsBuild(root)
  process.stdout.write(`Windows supervised build verified inputFingerprint=${report.sourceFingerprint}\n`)
  return report
}

function reportFailure(error) {
  console.error(error)
  process.exitCode = 1
  process.on('exit', () => { process.exitCode = 1 })
}

if (require.main === module) {
  if (process.argv[2] === '--build-worker') buildWindowsPackage().catch(reportFailure)
  else {
    try { runSupervisedBuild() } catch (error) { reportFailure(error) }
  }
}

module.exports = { buildWindowsPackage, electronChecksumOptions, runSupervisedBuild }
