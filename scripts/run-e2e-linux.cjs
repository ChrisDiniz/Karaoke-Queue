'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

if (process.platform !== 'linux') {
  console.error('The Linux Electron E2E runner requires Linux and Xvfb.')
  process.exit(1)
}

const root = path.resolve(__dirname, '..')
const suites = [
  'electron-smoke',
  'drag-electron',
  'round-robin-electron',
  'debut-cadence-electron',
  'persistence-electron',
  'previous-sessions-electron',
  'session-close-electron',
  'licensing-electron',
  'queue-menu-electron',
  'singer-autocomplete-electron',
  'sidebar-display-name-electron',
  'diagnostics-electron'
]
const env = { ...process.env }
delete env.WAYLAND_DISPLAY

for (const suite of suites) {
  console.log(`\n=== Electron E2E: ${suite} ===`)
  const result = spawnSync('xvfb-run', ['-a', process.execPath, `build/tests/${suite}.js`], {
    cwd: root,
    env,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status || 1
    console.error(`Electron E2E failed: ${suite}`)
    break
  }
}
