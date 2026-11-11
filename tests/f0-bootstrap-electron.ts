// @ts-nocheck
export {}
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
for (const scenario of ['ready', 'cached-ready', 'host-failed', 'close-before-ready', 'persistence-failure']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'standalone-player-production-electron.js')], {
    env: { ...process.env, KQ_F0_STRUCTURAL_ONLY: '', KQ_F0_STARTUP_ONLY: '', KQ_F0_RECOVERY_ONLY: '',
      KQ_F0_BOOTSTRAP_CASE: scenario, KQ_F0_RECOVERY_STATUS: scenario === 'persistence-failure' ? 'paused' : '' },
    encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024
  })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  assert.equal(result.status, 0, `Production Main bootstrap scenario ${scenario}: ${result.error || ''}`)
}

// Re-run the real Main's startup/restart path for every inherited recovery state.
for (const status of ['paused', 'playing', 'pending', 'uncertain', 'invalid']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'standalone-player-production-electron.js')], {
    env: { ...process.env, KQ_F0_STRUCTURAL_ONLY: '', KQ_F0_BOOTSTRAP_CASE: '', KQ_F0_RECOVERY_ONLY: '',
      KQ_F0_STARTUP_ONLY: '1', KQ_F0_RECOVERY_STATUS: status },
    encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024
  })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  assert.equal(result.status, 0, `Production Main inherited recovery ${status}: ${result.error || ''}`)
  console.log(`PASS F0 Main inherited ${status}: safe idle, cache restart, zero pre-gate enumeration`)
}
