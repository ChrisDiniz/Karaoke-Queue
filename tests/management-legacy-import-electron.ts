// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')
const { LEGACY_STATE_STORAGE_KEYS } = require('../src/persistence-contracts')

const projectRoot = path.resolve(__dirname, '../..')
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-management-legacy-import-'))
const userDataDirectory = path.join(profileRoot, 'profile')

async function run() {
  fs.mkdirSync(userDataDirectory, { recursive: true })
  fs.writeFileSync(path.join(userDataDirectory, 'operating-mode.json'), '{"version":1,"mode":"controller"}\n')
  const seeded = spawnSync(require('electron'), [
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    path.join(__dirname, 'seed-legacy-local-storage-electron.js')
  ], { encoding: 'utf8', timeout: 30000, env: {
    ...process.env,
    KQ_TEST_LEGACY_SEED_USER_DATA: userDataDirectory,
    KQ_TEST_LEGACY_SEED_DOCUMENT: path.join(projectRoot, 'src', 'index.html'),
    XDG_CONFIG_HOME: path.join(profileRoot, 'seed-config'),
    XDG_CACHE_HOME: path.join(profileRoot, 'seed-cache'),
    XDG_DATA_HOME: path.join(profileRoot, 'seed-data')
  }, windowsHide: true })
  if (seeded.error || seeded.status !== 0) {
    throw new Error(`Falha ao preparar localStorage legado: ${seeded.stdout || ''}\n${seeded.stderr || ''}\n${seeded.error || ''}`)
  }

  let app
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), projectRoot, `--user-data-dir=${userDataDirectory}`],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(profileRoot, 'config'),
        XDG_CACHE_HOME: path.join(profileRoot, 'cache'),
        XDG_DATA_HOME: path.join(profileRoot, 'data')
      },
      timeout: 30000
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!window.__kqueue && !!window.karaokeManagement, { timeout: 20000 })
    const snapshot = await page.evaluate(() => window.karaokeManagement.getSnapshot())
    assert.equal(snapshot.didImportLegacyStorage, true)
    assert.equal(snapshot.state.queue.length, 1)
    assert.equal(snapshot.state.queue[0].id, 'legacy-local-storage-entry')
    assert.ok(snapshot.state.currentSessionId)
    const remaining = await page.evaluate(keys => keys.map(key => localStorage.getItem(key)), Object.values(LEGACY_STATE_STORAGE_KEYS))
    assert.deepEqual(remaining, Array(Object.values(LEGACY_STATE_STORAGE_KEYS).length).fill(null),
      'Renderer removes legacy data only after the Main reports the committed import')

    await app.evaluate(({ app: electronApp }) => electronApp.exit(0))
    await app.close()
    app = undefined
    const database = new DatabaseSync(path.join(userDataDirectory, 'karaoke.sqlite'), { readOnly: true })
    try {
      const row = database.prepare('SELECT id, status FROM entries WHERE id = ?').get('legacy-local-storage-entry')
      assert.deepEqual({ ...row }, { id: 'legacy-local-storage-entry', status: 'pending' })
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1)
    } finally { database.close() }
    console.log('PASS production Electron: deferred Main initialization, legacy localStorage IPC import, confirmed SQLite commit and post-commit key cleanup')
  } finally {
    if (app) {
      await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
      await app.close().catch(() => {})
    }
    fs.rmSync(profileRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
