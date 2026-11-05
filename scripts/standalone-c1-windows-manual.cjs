#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const runner = require('./run-windows-native-tests.cjs')

function fail(message) {
  throw new Error(message)
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.status !== 0) {
    fail(executable + ' ' + args.join(' ') + ' falhou: ' +
      String(result.stderr || (result.error && result.error.message) || ('exit ' + result.status)).trim())
  }
  return result
}

function validateTemporaryStagePath(stagePath) {
  if (typeof stagePath !== 'string' || !path.isAbsolute(stagePath)) fail('Caminho absoluto do snapshot WSL inválido.')
  const temporaryRoot = path.resolve(os.tmpdir())
  const resolved = path.resolve(stagePath)
  const relative = path.relative(temporaryRoot, resolved)
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) ||
      !path.basename(resolved).startsWith('karaoke-queue-windows-stage-')) {
    fail('O snapshot só pode ser removido dentro do diretório temporário exclusivo do runner.')
  }
  return resolved
}

async function exportSnapshot() {
  const unexpected = process.argv.slice(2).filter(argument => !['--export-snapshot', '--approve-untracked'].includes(argument))
  if (unexpected.length || !process.argv.includes('--export-snapshot')) {
    fail('Uso interno: --export-snapshot [--approve-untracked].')
  }

  const root = command('git', ['rev-parse', '--show-toplevel']).stdout.trim()
  const manifest = runner.readSourceSnapshot(root)
  process.stdout.write('C1 source: branch=' + manifest.branch + ' HEAD=' + manifest.head +
    ' fingerprint=' + manifest.fingerprint + ' files=' + manifest.files.length + '\n')
  process.stdout.write('Snapshot temporário em /tmp WSL; PowerShell copiará para um staging NTFS novo em %TEMP%. O checkout Windows não será acessado.\n')
  await runner.approveUntracked(manifest.files.filter(item => item.kind === 'untracked'))

  const stage = runner.stageSnapshot(root, manifest, null, os.tmpdir())
  try {
    runner.verifySnapshotDirectory(path.join(stage, 'tree'), manifest)
    const stageWindows = command('wslpath', ['-w', stage]).stdout.trim()
    const result = {
      stagePathWindows: stageWindows,
      stagePathLinux: stage,
      fingerprint: manifest.fingerprint,
      branch: manifest.branch,
      head: manifest.head,
      fileCount: manifest.files.length,
      untrackedCount: manifest.files.filter(item => item.kind === 'untracked').length
    }
    process.stdout.write('KQ_C1_EXPORT_JSON=' + JSON.stringify(result) + '\n')
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

function cleanupSnapshot(stagePath, fingerprint) {
  const safePath = validateTemporaryStagePath(stagePath)
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) fail('Fingerprint para cleanup inválido.')
  const rootInfo = fs.lstatSync(safePath)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('Snapshot não é um diretório regular; preservado.')
  const manifestPath = path.join(safePath, 'metadata', 'snapshot.json')
  const manifest = runner.validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
  if (manifest.fingerprint !== fingerprint) fail('Fingerprint do snapshot mudou; cleanup recusado.')
  runner.verifySnapshotDirectory(path.join(safePath, 'tree'), manifest)
  fs.rmSync(safePath, { recursive: true, force: false })
}

function manifestFromEnvironment() {
  const manifestPath = process.env.KQ_C1_MANIFEST
  const expectedFingerprint = process.env.KQ_C1_EXPECTED_FINGERPRINT
  if (typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath)) fail('Caminho do manifesto C1 ausente ou inválido.')
  if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) fail('Fingerprint esperado C1 ausente ou inválido.')
  const manifest = runner.validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
  if (manifest.fingerprint !== expectedFingerprint) fail('Fingerprint do manifesto diverge do snapshot exportado.')
  return manifest
}

function verifyWindowsSnapshot() {
  const manifest = manifestFromEnvironment()
  runner.verifySnapshotDirectory(process.cwd(), manifest)
  process.stdout.write('Verificação de hashes do snapshot Windows: PASS\n')
}

function verifyWindowsBuild() {
  const manifest = manifestFromEnvironment()
  runner.verifyBuildOutput(process.cwd(), manifest)
  const required = [
    'build/src/standalone-player.html',
    'build/src/standalone-player.css',
    'build/src/standalone-player-renderer.bundle.js',
    'build/standalone-player-ui-preload.js',
    'build/src/assets/standalone-empty-stage.png',
    'build/tests/standalone-player-ui-electron.js'
  ]
  for (const relativePath of required) {
    if (!fs.existsSync(path.join(process.cwd(), ...relativePath.split('/')))) fail('Artefato C1 ausente: ' + relativePath)
  }
  process.stdout.write('Inventário de build C1 Windows: PASS\n')
}

async function importWindowsCatalog() {
  const profileRoot = process.env.KQ_STANDALONE_C1_PROFILE
  const catalogCsv = process.env.KQ_PLAYER_TEST_CATALOG_CSV
  if (typeof profileRoot !== 'string' || !path.isAbsolute(profileRoot)) fail('Perfil temporário C1 ausente ou inválido.')
  if (typeof catalogCsv !== 'string' || !path.isAbsolute(catalogCsv)) fail('CSV de teste C1 ausente ou inválido.')
  const { createPlayerMusicCatalogDatabase } = require(path.join(process.cwd(), 'build/database.js'))
  const { MusicCatalogService } = require(path.join(process.cwd(), 'build/src/music-catalog-service.js'))
  const database = createPlayerMusicCatalogDatabase(profileRoot)
  try {
    const catalog = new MusicCatalogService(database)
    const result = await catalog.importFile(catalogCsv)
    const metadata = catalog.lookupMetadataByVideoCode('1001')
    if (!Number.isSafeInteger(result.recordCount) || result.recordCount < 1 || !metadata?.title || !metadata?.artist) {
      fail('CSV não produziu registros/metadados para o código de amostra 1001.')
    }
    process.stdout.write('CSV importado: ' + result.recordCount + ' registros; preview 1001: ' + JSON.stringify(metadata) + '\n')
  } finally {
    database.close()
  }
}

function printElectronPath() {
  const electronPath = require('electron')
  if (typeof electronPath !== 'string' || !path.isAbsolute(electronPath)) fail('O pacote Electron não retornou um caminho de executável absoluto.')
  process.stdout.write(electronPath + '\n')
}

function getNodeInfo() {
  return { platform: process.platform, version: process.version }
}

function printNodeInfo() {
  process.stdout.write(JSON.stringify(getNodeInfo()) + '\n')
}

async function runCommand(args) {
  switch (args[0]) {
    case '--export-snapshot':
      return exportSnapshot()
    case '--cleanup-snapshot':
      if (args.length !== 3) fail('Uso: --cleanup-snapshot <stagePathLinux> <fingerprint>.')
      return cleanupSnapshot(args[1], args[2])
    case '--node-info':
      if (args.length !== 1) fail('Uso: --node-info.')
      return printNodeInfo()
    case '--verify-snapshot':
      if (args.length !== 1) fail('Uso: --verify-snapshot.')
      return verifyWindowsSnapshot()
    case '--verify-build':
      if (args.length !== 1) fail('Uso: --verify-build.')
      return verifyWindowsBuild()
    case '--import-catalog':
      if (args.length !== 1) fail('Uso: --import-catalog.')
      return importWindowsCatalog()
    case '--electron-path':
      if (args.length !== 1) fail('Uso: --electron-path.')
      return printElectronPath()
    default:
      fail('Comando C1 desconhecido ou ausente.')
  }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  runCommand(args).catch(error => {
    process.stderr.write('C1 SNAPSHOT EXPORT FAIL: ' + (error.stack || error) + '\n')
    process.exitCode = 1
  })
}

module.exports = { getNodeInfo, validateTemporaryStagePath }
