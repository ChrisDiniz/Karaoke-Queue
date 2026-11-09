'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')

function isWindowsX64(context) {
  if (context.electronPlatformName !== 'win32') return false
  if (context.arch === 1) return true // app-builder-lib Arch.x64
  const arch = context.arch?.toString?.() ?? String(context.arch)
  if (arch !== 'x64') throw new Error(`Installation binding supports only Windows x64; received ${arch}`)
  return true
}

function verifyX64Pe(filePath) {
  const bytes = fs.readFileSync(filePath)
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Native binding is not a PE executable.')
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset + 6 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('Native binding has an invalid PE header.')
  }
  if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error('Native binding is not an x64 PE image.')
}

function buildArgs(electronVersion, sourceDirectory) {
  return [
    'rebuild', '--directory', sourceDirectory, '--arch=x64',
    `--target=${electronVersion}`, '--runtime=electron', '--dist-url=https://electronjs.org/headers'
  ]
}

async function beforePack(context) {
  if (!isWindowsX64(context)) return
  const electronVersion = require('electron/package.json').version
  const sourceDirectory = path.join(root, 'build-resources', 'native')
  const outputDirectory = path.join(sourceDirectory, 'win32-x64')
  const builtAddon = path.join(sourceDirectory, 'build', 'Release', 'kq_win32.node')
  const addonPath = path.join(outputDirectory, 'kq_win32.node')
  const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js', { paths: [root] })

  fs.rmSync(outputDirectory, { recursive: true, force: true })
  const result = spawnSync(process.execPath, [nodeGyp, ...buildArgs(electronVersion, sourceDirectory)], {
    cwd: sourceDirectory,
    stdio: 'inherit',
    env: { ...process.env, npm_config_arch: 'x64' }
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`node-gyp failed with exit code ${result.status ?? 'unknown'}`)
  if (!fs.existsSync(builtAddon)) throw new Error('node-gyp did not produce kq_win32.node.')
  verifyX64Pe(builtAddon)
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.copyFileSync(builtAddon, addonPath, fs.constants.COPYFILE_EXCL)
  verifyX64Pe(addonPath)
  console.log(`Built Windows x64 installation binding for Electron ${electronVersion}.`)
}

module.exports = { default: beforePack, beforePack, isWindowsX64, verifyX64Pe, buildArgs }
