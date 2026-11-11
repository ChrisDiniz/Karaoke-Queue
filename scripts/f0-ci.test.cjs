'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { suites, run, fixtureEnvironment } = require('./run-f0-ci.cjs')
test('hosted Windows F0 selects existing deterministic tests, never physical or external media', () => {
  const files = suites().map(s => s.script)
  assert.equal(new Set(files).size, files.length)
  for (const file of files) {
    assert.ok(fs.existsSync(file), file)
    assert.doesNotMatch(file, /manual-usb|standalone-player-production-electron/)
  }
  for (const name of ['f0-bootstrap', 'usb-reconnect-synthetic', 'storage-resilience-electron', 'usb-campaign-electron', 'video-library-index']) assert.ok(suites().some(s => s.name === name))
  for (const workflow of ['pr-validation', 'release-windows']) {
    const source = fs.readFileSync('.github/workflows/' + workflow + '.yml', 'utf8')
    assert.equal(source.split('run: npm run test:ci:f0:windows').length - 1, 1)
    assert.doesNotMatch(source, /test:manual:usb/)
  }
})
test('failure or signal stops remaining suites and fails the job', () => {
  let calls = 0
  assert.equal(run(() => { calls++; return { status: 17 } }, {}), 17)
  assert.equal(calls, 1)
  assert.equal(run(() => ({ status: null, signal: 'SIGTERM' }), {}), 1)
  assert.throws(() => run(() => ({ error: new Error('spawn failed') }), {}), /spawn failed/)
})
test('external media and campaign overrides block before spawning', () => {
  for (const key of ['KQ_F0_REAL_LIBRARY', 'KQ_PLAYER_TEST_MEDIA_DIR', 'KQ_USB_FOCUS_CONTROL']) assert.throws(() => run(() => assert.fail('must not spawn'), { [key]: '1' }), /isolated generated fixtures/)
})

test('Windows fixtures inherit canonical TEMP and TMP without changing the parent environment', () => {
  const env = { TEMP: 'C:\\Users\\RUNNER~1\\Temp', TMP: 'alias', OTHER: 'preserved' }
  const canonical = 'C:\\Users\\runneradmin\\Temp'
  const result = fixtureEnvironment(env, 'win32', () => canonical)
  assert.deepEqual(result, { ...env, TEMP: canonical, TMP: canonical })
  assert.equal(env.TMP, 'alias')
  assert.equal(fixtureEnvironment(env, 'linux', () => assert.fail('Windows only')), env)
  assert.throws(() => fixtureEnvironment(env, 'win32', () => { throw new Error('unavailable temp') }), /unavailable temp/)
})
test('Windows temp normalization uses native realpath to expand 8.3 aliases', () => {
  const original = fs.realpathSync.native
  let called = false
  try {
    fs.realpathSync.native = input => {
      assert.equal(input, require('node:os').tmpdir())
      called = true
      return 'canonical-temp'
    }
    assert.equal(fixtureEnvironment({}, 'win32').TEMP, 'canonical-temp')
    assert.equal(called, true)
  } finally {
    fs.realpathSync.native = original
  }
})
