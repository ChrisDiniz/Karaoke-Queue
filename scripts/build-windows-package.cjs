'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Arch, Platform, build } = require('electron-builder')
const { SEAL_NAME, buildInputFingerprint, writeBuildSeal } = require('./windows-build-provenance.cjs')

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

if (require.main === module) {
  buildWindowsPackage().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { buildWindowsPackage, electronChecksumOptions }
