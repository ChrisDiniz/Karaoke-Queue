'use strict'
// Hosted Windows adapter over the existing native runner's deterministic selector.
// Dependencies and compile are supplied by the existing windows-build job.
const { spawnSync } = require('node:child_process')
const { selectWindowsTestSuites } = require('./run-windows-native-tests.cjs')
function suites() {
  return selectWindowsTestSuites('--video-library')
}
function fixtureEnvironment(env, platform = process.platform, canonicalTemp = () => require('node:fs').realpathSync.native(require('node:os').tmpdir())) {
  if (platform !== 'win32') return env
  // Hosted Windows TEMP may use an 8.3 alias. Fixtures must use the real path
  // so production anti-link checks see the same identity as realpath().
  const temp = canonicalTemp()
  return { ...env, TEMP: temp, TMP: temp }
}
function run(spawn = spawnSync, env = process.env) {
  if (Object.keys(env).some(k => /^(KQ_F0_|KQ_PLAYER_TEST_MEDIA|KQ_STANDALONE_PRODUCTION_PROFILE|KARAOKE_TEST_TEMP_ROOT|KQ_USB_FOCUS_CONTROL)/.test(k) && env[k])) {
    throw new Error('F0 CI requires isolated generated fixtures; external campaign overrides are forbidden.')
  }
  env = fixtureEnvironment(env)
  for (const suite of suites()) {
    console.log('F0 CI: ' + suite.name)
    const result = spawn(process.execPath, [suite.script], { cwd: require('node:path').resolve(__dirname, '..'), env, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) return result.status || 1
  }
  return 0
}
if (require.main === module) {
  if (process.platform !== 'win32') throw new Error('Use the Linux E2E runner on Linux.')
  process.exitCode = run()
}
module.exports = { suites, run, fixtureEnvironment }
