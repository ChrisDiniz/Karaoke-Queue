'use strict'

const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')

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

  const outputDirectory = path.join(root, pkg.build.directories.output)
  if (!fs.existsSync(outputDirectory)) fail(`output directory is missing: ${outputDirectory}`)
  const expectedInstaller = pkg.build.artifactName
    .replaceAll('${version}', pkg.version)
    .replaceAll('${arch}', 'x64')
    .replaceAll('${ext}', 'exe')
  const installers = fs.readdirSync(outputDirectory)
    .filter(name => name.toLowerCase() === expectedInstaller.toLowerCase())
  if (installers.length !== 1) fail(`expected exactly one x64 installer; found: ${installers.join(', ') || '(none)'}`)

  const appArchive = path.join(outputDirectory, 'win-unpacked', 'resources', 'app.asar')
  if (!fs.existsSync(appArchive)) fail('win-unpacked/resources/app.asar is missing')
  const entries = new Set(asar.listPackage(appArchive).map(entry => entry.replaceAll('\\', '/').replace(/^\/+/, '')))
  const required = [
    'package.json', 'build/main.js', 'build/preload.js', 'build/database.js',
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
