import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getOperatingModeCapabilities,
  isOperatingMode,
  OperatingModeConfigurationError,
  OPERATING_MODE_CONFIGURATION_FILENAME,
  readOperatingModeConfiguration,
  requiresFirstLaunchModeSelection,
  writeOperatingModeConfiguration
} from '../src/operating-mode'

function profile(): { directory: string; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-operating-mode-'))
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

test('missing operating mode configuration defaults to the legacy Controller mode', () => {
  const temp = profile()
  try {
    assert.deepEqual(readOperatingModeConfiguration(temp.directory), { version: 1, mode: 'controller' })
  } finally { temp.cleanup() }
})

test('first-launch mode selection is limited to profiles without mode or persisted application data', () => {
  const fresh = profile()
  try {
    assert.equal(requiresFirstLaunchModeSelection(fresh.directory), true)
    fs.writeFileSync(path.join(fresh.directory, 'karaoke.sqlite'), 'legacy marker')
    assert.equal(requiresFirstLaunchModeSelection(fresh.directory), false,
      'an existing operational profile must preserve the historical Controller fallback')
    fs.rmSync(path.join(fresh.directory, 'karaoke.sqlite'))
    writeOperatingModeConfiguration(fresh.directory, 'player')
    assert.equal(requiresFirstLaunchModeSelection(fresh.directory), false,
      'a selected mode must bypass first-launch selection on subsequent starts')
  } finally { fresh.cleanup() }
})

test('mode validation and capability composition cover Controller, Player and Combined', () => {
  assert.equal(isOperatingMode('controller'), true)
  assert.equal(isOperatingMode('player'), true)
  assert.equal(isOperatingMode('combined'), true)
  for (const value of ['', 'Controller', 'remote', null, 1, {}]) assert.equal(isOperatingMode(value), false)

  assert.deepEqual(getOperatingModeCapabilities('controller'), { controller: true, player: false })
  assert.deepEqual(getOperatingModeCapabilities('player'), { controller: false, player: true })
  assert.deepEqual(getOperatingModeCapabilities('combined'), { controller: true, player: true })
  assert.throws(() => getOperatingModeCapabilities('other' as never), OperatingModeConfigurationError)
})

test('each valid operating mode is persisted in the versioned configuration schema', () => {
  for (const mode of ['controller', 'player', 'combined'] as const) {
    const temp = profile()
    try {
      writeOperatingModeConfiguration(temp.directory, mode)
      const filePath = path.join(temp.directory, OPERATING_MODE_CONFIGURATION_FILENAME)
      assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { version: 1, mode })
      assert.deepEqual(readOperatingModeConfiguration(temp.directory), { version: 1, mode })
      if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
    } finally { temp.cleanup() }
  }
})

test('atomic replacement leaves one complete configuration and ignores abandoned temporary files', () => {
  const temp = profile()
  try {
    writeOperatingModeConfiguration(temp.directory, 'controller')
    const filePath = path.join(temp.directory, OPERATING_MODE_CONFIGURATION_FILENAME)
    const staleTemporaryPath = path.join(temp.directory, `.operating-mode.${process.pid}.abandoned.tmp`)
    fs.writeFileSync(staleTemporaryPath, '{ partial')

    writeOperatingModeConfiguration(temp.directory, 'combined')

    assert.deepEqual(readOperatingModeConfiguration(temp.directory), { version: 1, mode: 'combined' })
    assert.equal(fs.readFileSync(staleTemporaryPath, 'utf8'), '{ partial', 'recovery must not mistake an abandoned temp file for the committed configuration')
    assert.deepEqual(fs.readdirSync(temp.directory).filter(name => name.startsWith('.operating-mode.') && name.endsWith('.tmp')),
      [path.basename(staleTemporaryPath)], 'successful replacement must clean up its own temporary file')
  } finally { temp.cleanup() }
})

test('invalid configuration is rejected without rewriting or deleting the original file', () => {
  const invalidValues = [
    '{ invalid json',
    JSON.stringify({ version: 2, mode: 'player' }),
    JSON.stringify({ version: 1, mode: 'unknown' }),
    JSON.stringify({ version: 1, mode: 'player', extra: true }),
    JSON.stringify(['player']),
    ' '.repeat(4097)
  ]

  for (const contents of invalidValues) {
    const temp = profile()
    try {
      const filePath = path.join(temp.directory, OPERATING_MODE_CONFIGURATION_FILENAME)
      fs.writeFileSync(filePath, contents)
      const original = fs.readFileSync(filePath)
      assert.throws(() => readOperatingModeConfiguration(temp.directory), OperatingModeConfigurationError)
      assert.deepEqual(fs.readFileSync(filePath), original, 'invalid settings must remain available for explicit repair')
    } finally { temp.cleanup() }
  }
})

test('invalid mode writes fail safely and preserve the existing configuration', () => {
  const temp = profile()
  try {
    writeOperatingModeConfiguration(temp.directory, 'player')
    const filePath = path.join(temp.directory, OPERATING_MODE_CONFIGURATION_FILENAME)
    const original = fs.readFileSync(filePath)
    assert.throws(() => writeOperatingModeConfiguration(temp.directory, 'unknown' as never), OperatingModeConfigurationError)
    assert.deepEqual(fs.readFileSync(filePath), original)
  } finally { temp.cleanup() }
})

test('configuration read rejects a non-regular file rather than treating it as missing', () => {
  const temp = profile()
  try {
    fs.mkdirSync(path.join(temp.directory, OPERATING_MODE_CONFIGURATION_FILENAME))
    assert.throws(() => readOperatingModeConfiguration(temp.directory), /não é um arquivo regular/)
  } finally { temp.cleanup() }
})
