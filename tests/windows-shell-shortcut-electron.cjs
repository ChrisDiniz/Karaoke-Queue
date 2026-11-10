'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  if (process.platform !== 'win32') throw new Error('Windows Electron shell shortcut test is Windows-only.')
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'Karaoke Queue Música shortcut smoke-'))
  const electron = require('electron')
  let failure
  try {
    const result = spawnSync(electron, [__filename, '--electron', tempRoot], {
      cwd: root, env: process.env,
      encoding: 'utf8', shell: false, timeout: 60000
    })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error || result.status !== 0) failure = new Error(`Electron shortcut smoke failed: ${result.error?.message || result.status}`)
  } catch (error) { failure = error }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) }
  catch (error) {
    const cleanupError = new Error(`Electron shortcut profile cleanup failed after process exit: ${error.message}`)
    if (failure) failure.cleanupError = cleanupError
    else failure = cleanupError
  }
  if (failure) throw failure
  process.exit(0)
}

const { app, shell } = require('electron')
const tempRoot = path.resolve(process.argv[3] || '')
if (!process.argv[3] || !fs.statSync(tempRoot).isDirectory()) throw new Error('Isolated shortcut test root was not supplied by the parent process.')
app.setPath('userData', path.join(tempRoot, 'profile'))

app.whenReady().then(() => {
  const target = process.execPath
  const results = []
  for (const [role, displayName, appUserModelId] of [
    ['player', 'Karaoke Queue — Reprodutor', 'com.karaoke.queue.player'],
    ['combined', 'Karaoke Queue — Tudo em um', 'com.karaoke.queue.combined']
  ]) {
    const shortcutPath = path.join(tempRoot, `${role}.lnk`)
    const icon = path.join(root, 'build-resources', 'identity', `karaoke-${role}.ico`)
    const expected = {
      target, cwd: path.dirname(target), args: '', description: displayName,
      icon, iconIndex: 0, appUserModelId
    }
    assert.equal(shell.writeShortcutLink(shortcutPath, 'create', expected), true)
    const actual = shell.readShortcutLink(shortcutPath)
    assert.equal(path.resolve(actual.target).toLowerCase(), path.resolve(target).toLowerCase())
    assert.equal(actual.args ?? '', '')
    assert.equal(path.resolve(actual.icon).toLowerCase(), path.resolve(icon).toLowerCase())
    assert.equal(actual.iconIndex, 0)
    assert.equal(actual.appUserModelId, appUserModelId)
    assert.equal(actual.description, displayName)
    results.push({ role, appUserModelId, path: path.basename(shortcutPath), readback: true })
  }
  process.stdout.write(`WINDOWS ELECTRON SHELL SHORTCUT PASS ${JSON.stringify(results)}\n`)
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
