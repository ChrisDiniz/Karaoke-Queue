'use strict'

const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')
const { verifyBuildSeal } = require('./windows-build-provenance.cjs')

function fail(message) {
  throw new Error(`Windows package validation failed: ${message}`)
}

function verifyWindowsBuild(root = path.resolve(__dirname, '..')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    fail(`package.json version is not SemVer: ${pkg.version}`)
  }
  if (pkg.build.productName !== 'Karaoke Queue') fail('productName is not Karaoke Queue')
  if (pkg.build.appId !== 'com.karaoke.queue') fail('appId changed unexpectedly')
  if (pkg.build.win?.forceCodeSigning !== false) fail('unsigned experimental builds must remain permitted')
  if (pkg.build.nsis?.perMachine !== true || pkg.build.nsis?.allowToChangeInstallationDirectory !== true) {
    fail('NSIS must require one machine-wide installation with protected directory selection')
  }
  if (pkg.build.nsis?.include !== 'installer.nsh' || !fs.existsSync(path.join(pkg.build.directories.buildResources, 'installer.nsh'))) {
    fail('The protected machine-wide bootstrap NSIS include is missing')
  }

  const outputDirectory = path.join(root, pkg.build.directories.output)
  if (!fs.existsSync(outputDirectory)) fail(`output directory is missing: ${outputDirectory}`)
  const expectedInstaller = pkg.build.artifactName
    .replaceAll('${version}', pkg.version)
    .replaceAll('${arch}', 'x64')
    .replaceAll('${ext}', 'exe')
  const installers = fs.readdirSync(outputDirectory)
    .filter(name => name.toLowerCase() === expectedInstaller.toLowerCase())
  if (installers.length !== 1) fail(`expected exactly one x64 installer; found: ${installers.join(', ') || '(none)'}`)
  if (fs.readdirSync(outputDirectory).some(name => name.endsWith('.__uninstaller.exe'))) {
    fail('NSIS intermediate uninstaller is present; refusing a partial build.')
  }

  let buildSeal
  try {
    buildSeal = verifyBuildSeal(root, [
      expectedInstaller,
      'win-unpacked/Karaoke Queue.exe',
      'win-unpacked/resources/app.asar',
      'win-unpacked/resources/native/win32-x64/kq_win32.node'
    ])
  } catch (error) { fail(error.message) }

  const appArchive = path.join(outputDirectory, 'win-unpacked', 'resources', 'app.asar')
  if (!fs.existsSync(appArchive)) fail('win-unpacked/resources/app.asar is missing')
  const entries = new Set(asar.listPackage(appArchive).map(entry => entry.replaceAll('\\', '/').replace(/^\/+/, '')))
  const required = [
    'package.json', 'build/main.js', 'build/preload.js', 'build/database.js',
    'build/main-runtime.js', 'build/src/installation-control.js', 'build/src/installation-admin.js',
    'build/src/installation-admin-args.js', 'build/src/installation-role-broker.js',
    'build/src/installed-role-context.js', 'build/src/welcome-setup.js',
    'build/src/installation-runtime-gate.js',
    'build/src/windows-function-identity.js',
    'build/src/installation-shortcuts.js',
    'build/welcome-preload.js', 'build/src/welcome-renderer.bundle.js',
    'build/src/welcome.html', 'build/src/welcome.css', 'build/src/catalog-import-dialog.css',
    'build/src/index.html', 'build/src/style.css', 'build/src/app.js',
    'build/src/license-service.js', 'build/src/licensing.js', 'build/src/assets/karaoke-logo.png'
  ]
  for (const entry of required) if (!entries.has(entry)) fail(`required packaged file is missing: ${entry}`)
  for (const entry of entries) {
    if (/^(tests|docs|build-resources)\//i.test(entry) || /(^|\/)(?:[^/]+\.test\.js|[^/]+\.spec\.js)$/i.test(entry)) {
      fail(`development or test file leaked into the application archive: ${entry}`)
    }
    if (/\.node$/i.test(entry)) fail(`unexpected native SQLite addon in package: ${entry}`)
  }

  const resourcesDirectory = path.join(outputDirectory, 'win-unpacked', 'resources')
  const identityAssets = ['karaoke-player', 'karaoke-combined']
  const roleIconBytes = new Map()
  for (const role of identityAssets) {
    const pngPath = path.join(resourcesDirectory, 'identity', `${role}.png`)
    const icoPath = path.join(resourcesDirectory, 'identity', `${role}.ico`)
    if (!fs.existsSync(pngPath) || !fs.existsSync(icoPath)) fail(`function identity assets are missing for ${role}`)
    const png = fs.readFileSync(pngPath)
    if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256) {
      fail(`function window icon is not a 256x256 PNG for ${role}`)
    }
    const ico = fs.readFileSync(icoPath)
    if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== 8) {
      fail(`function taskbar/shortcut icon is not the eight-size ICO for ${role}`)
    }
    roleIconBytes.set(role, ico)
  }
  if (roleIconBytes.get('karaoke-player').equals(roleIconBytes.get('karaoke-combined'))) {
    fail('Reprodutor and Tudo em um Windows icons must be distinct')
  }

  const nativeAddon = path.join(resourcesDirectory, 'native', 'win32-x64', 'kq_win32.node')
  if (!fs.existsSync(nativeAddon)) fail('Windows installation-control N-API binding is missing from resources/native/win32-x64')
  const nativeFiles = []
  function collectNativeFiles(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) collectNativeFiles(entryPath)
      else if (entry.name.toLowerCase().endsWith('.node')) nativeFiles.push(path.relative(resourcesDirectory, entryPath).replaceAll('\\', '/'))
    }
  }
  collectNativeFiles(resourcesDirectory)
  if (nativeFiles.length !== 1 || nativeFiles[0] !== 'native/win32-x64/kq_win32.node') {
    fail(`unexpected native modules outside ASAR: ${nativeFiles.join(', ') || '(none)'}`)
  }
  const nativeBytes = fs.readFileSync(nativeAddon)
  if (nativeBytes.length < 64 || nativeBytes.toString('ascii', 0, 2) !== 'MZ') fail('installation binding is not a PE image')
  const peOffset = nativeBytes.readUInt32LE(0x3c)
  if (peOffset + 6 > nativeBytes.length || nativeBytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' ||
      nativeBytes.readUInt16LE(peOffset + 4) !== 0x8664) fail('installation binding is not an x64 PE image')

  const databaseSource = asar.extractFile(appArchive, 'build/database.js').toString('utf8')
  if (!databaseSource.includes("require('node:sqlite')") && !databaseSource.includes('require("node:sqlite")')) {
    fail('database.js does not use Electron Node built-in node:sqlite')
  }
  const iconPath = path.join(root, pkg.build.win.icon)
  const icon = fs.readFileSync(iconPath)
  if (icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1 || icon.readUInt16LE(4) < 1) {
    fail('configured Windows icon is not a valid ICO resource')
  }

  const result = {
    installer: installers[0],
    version: pkg.version,
    productName: pkg.build.productName,
    appArchive: path.relative(root, appArchive),
    packagedFileCount: entries.size,
    installationBinding: path.relative(outputDirectory, nativeAddon).replaceAll('\\', '/'),
    sourceCommit: buildSeal.commit,
    sourceFingerprint: buildSeal.inputFingerprint,
    roleIdentityAssets: identityAssets.map(role => `identity/${role}.{png,ico}`),
    sqlite: 'node:sqlite (Electron embedded Node; no native addon)',
    windowsIcon: path.relative(root, iconPath),
    signed: false
  }
  console.log(JSON.stringify(result, null, 2))
  return result
}

if (require.main === module) {
  try { verifyWindowsBuild() } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { verifyWindowsBuild }
