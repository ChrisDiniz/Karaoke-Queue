// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-cadence-electron-'))
const userDataDir = path.join(profileRoot, 'profile')

async function run() {
  let app
  const launch = () => electron.launch({
    executablePath: require('electron'),
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(profileRoot, 'config'),
      XDG_CACHE_HOME: path.join(profileRoot, 'cache'),
      XDG_DATA_HOME: path.join(profileRoot, 'data')
    },
    timeout: 30000
  })
  const openPage = async electronApp => {
    const page = await electronApp.firstWindow()
    await page.waitForFunction(() => !!window.__kqueue)
    await page.locator('#form-entry').waitFor({ state: 'visible' })
    const primary = page.locator('#btn-startup-primary')
    if (await primary.isVisible()) await primary.click()
    return page
  }
  const add = async (page, name, table, song) => {
    await page.locator('#input-name').fill(name)
    await page.locator('#input-song').fill(song)
    await page.locator('#input-table').fill(table)
    await page.locator('#form-entry button[type="submit"]').click()
    await page.waitForTimeout(40)
  }
  const completeCurrent = async page => {
    const current = page.locator('#now-block .now-card')
    await current.waitFor({ state: 'visible' })
    await current.locator('.btn-done-lg').click()
    await page.locator('#now-block').waitFor({ state: 'hidden' })
  }

  try {
    app = await launch()
    let page = await openPage(app)

    await add(page, 'Yas histórico', '6', '1001')
    await completeCurrent(page)
    await add(page, 'Duda primeira rodada', '1', '1002')
    await completeCurrent(page)
    await add(page, 'Duda segunda rodada', '1', '1003')
    await completeCurrent(page)

    await add(page, 'Apresentação atual', '99', '1099')
    await page.evaluate(() => window.__kqueue.flushState())
    const userDataPath = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    assert.ok(path.resolve(userDataPath).startsWith(path.resolve(profileRoot)), 'the Electron profile is isolated in tmp')
    const databasePath = path.join(userDataPath, 'karaoke.sqlite')
    const currentDb = new DatabaseSync(databasePath, { readOnly: true })
    const currentId = currentDb.prepare('SELECT current_turn_id FROM app_state WHERE singleton = 1').get().current_turn_id
    currentDb.close()
    await add(page, 'Yas', '6', '2001')
    await add(page, 'Opa', '22', '2002')
    await add(page, 'Cristian', '18', '2003')
    const beforeDuda = await page.locator('#queue-list .queue-card .card-name').allTextContents()
    assert.deepEqual(beforeDuda, ['Yas', 'Opa', 'Cristian'])
    await add(page, 'Duda', '1', '2004')
    const expectedNames = ['Yas', 'Opa', 'Cristian', 'Duda']
    assert.deepEqual(await page.locator('#queue-list .queue-card .card-name').allTextContents(), expectedNames,
      'a later regular request preserves established debut turns')
    await page.evaluate(() => window.__kqueue.flushState())

    const db = new DatabaseSync(databasePath, { readOnly: true })
    let expectedIds
    try {
      const pendingRows = db.prepare("SELECT id, name, queue_order FROM entries WHERE status = 'pending' ORDER BY queue_order").all()
      const currentPosition = pendingRows.find(row => row.id === currentId).queue_order
      expectedIds = pendingRows.filter(row => row.id !== currentId).map(row => row.id)
      assert.deepEqual(pendingRows.filter(row => row.id !== currentId).map(row => row.name), expectedNames)
      assert.equal(db.prepare('SELECT queue_order_policy_version FROM app_state WHERE singleton = 1').get().queue_order_policy_version, 2)
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM entries WHERE table_number = '1' AND status = 'done'").get().count, 2)
      assert.ok(currentPosition < pendingRows.find(row => row.name === 'Yas').queue_order)
    } finally { db.close() }

    await app.evaluate(({ app: electronApp }) => electronApp.exit(0))
    await app.close()
    app = await launch()
    page = await openPage(app)
    assert.deepEqual(await page.locator('#queue-list .queue-card .card-name').allTextContents(), expectedNames,
      'the effective UI order is restored after restarting Electron')
    await page.evaluate(() => window.__kqueue.flushState())

    const recoveredDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.deepEqual(recoveredDb.prepare("SELECT id FROM entries WHERE status = 'pending' AND id != ? ORDER BY queue_order")
        .all(currentId).map(row => row.id), expectedIds)
      const cadence = recoveredDb.prepare('SELECT queue_order_policy_version, regulars_since_debut FROM app_state WHERE singleton = 1').get()
      assert.equal(cadence.queue_order_policy_version, 2)
    } finally { recoveredDb.close() }

    await app.evaluate(({ app: electronApp }) => electronApp.exit(0))
    await app.close()
    app = undefined
    console.log('PASS: Electron real + SQLite IPC — cenário Duda, ordem visual e DB, reinício e recuperação da fila')
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
