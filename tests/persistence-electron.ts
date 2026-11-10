// @ts-nocheck
export {}
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')
const { prepareControllerModeProfile } = require('./electron-test-profile')
const { getManagementPlayOrder } = require('../src/management-projections')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-persistence-'))
const profile = path.join(root, 'profile')
const project = path.resolve(__dirname, '../..')
let app, page
let dbPath
const read = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try { return { state: db.prepare('SELECT * FROM app_state').get(),
    entries: db.prepare('SELECT * FROM entries ORDER BY id').all(), sessions: db.prepare('SELECT * FROM sessions').all() } }
  finally { db.close() }
}
const sql = query => { const db = new DatabaseSync(dbPath); try { db.exec(query) } finally { db.close() } }
const fail = () => sql("CREATE TRIGGER fail_save BEFORE UPDATE ON app_state BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL test-only'); END")
const heal = () => sql('DROP TRIGGER fail_save')
const recover = async () => { await page.getByRole('button', { name: 'Verificar armazenamento' }).click(); await page.waitForFunction(() => document.querySelector('[role="alert"]')?.hidden) }
const add = async (table, name = `Test ${table}`) => {
  await page.locator('#input-table').fill(table)
  await page.locator('#input-name').fill(name)
  await page.locator('#input-song').fill('123')
  await page.locator('#form-entry button[type="submit"]').click()
}
const settled = () => page.evaluate(() => window.__kqueue.flushState().catch(() => false))
async function launch() {
  prepareControllerModeProfile(profile)
  app = await electron.launch({ executablePath: require('electron'), args: [project, `--user-data-dir=${profile}`],
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data') } })
  page = await app.firstWindow()
  await page.waitForFunction(() => !!window.__kqueue)
  if (await page.locator('#startup-modal').isVisible()) await page.locator('#btn-startup-primary').click()
  page.on('dialog', dialog => { void dialog.accept().catch(() => {}) })
  dbPath = path.join(await app.evaluate(({ app }) => app.getPath('userData')), 'karaoke.sqlite')
  assert.ok(dbPath.startsWith(root))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
}
async function closeForced() {
  if (!app) return
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await app.close().catch(() => {})
  app = null
}
async function run() {
 try {
  await launch()
  assert.equal(await page.evaluate(() => !!window.karaokeManagement), true)
  console.log('CHECK cadastro')
  const initial = read()
  fail()
  await add('1')
  await page.getByRole('button', { name: 'Verificar armazenamento' }).waitFor()
  assert.equal(await settled(), false)
  assert.equal(await page.locator('#input-name').inputValue(), 'Test 1')
  assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 0)
  assert.deepEqual(read(), initial)
  await page.screenshot({ path: path.join(root, 'cadastro-rejeitado.png') })
  heal(); await recover()
  await page.locator('#form-entry button[type="submit"]').click(); await settled()
  for (const table of ['2', '3', '4']) { await add(table); await settled() }
  assert.equal(read().entries.length, 4)

  // Batch is one commit and retains all rows on failure.
  await page.locator('#btn-open-batch').click()
  for (let row = 0; row < 2; row++) {
    await page.locator('.batch-row').nth(row).locator('.b-name').fill(`Batch ${row}`)
    await page.locator('.batch-row').nth(row).locator('.b-song').fill('456')
    await page.locator('.batch-row').nth(row).locator('.b-table').fill(String(30 + row))
  }
  const beforeBatch = read()
  fail()
  await page.locator('#btn-confirm-batch').click(); await settled()
  assert.deepEqual(read(), beforeBatch)
  assert.equal(await page.locator('#batch-modal').isVisible(), true)
  assert.equal(await page.locator('.batch-row').nth(0).locator('.b-name').inputValue(), 'Batch 0')
  heal(); await recover()
  await page.locator('#btn-confirm-batch').click(); await settled()
  assert.equal(await page.locator('#batch-modal').isVisible(), false)
  assert.equal(read().entries.length, 6)

  // Real SQLite abort happens after entry updates and before state/cadence commit.
  console.log('CHECK conclusão / pin / freeze / cancel')
  const before = read()
  const current = before.state.current_turn_id
  fail()
  await page.locator('#now-block .btn-done-lg').click(); await settled()
  assert.deepEqual(read(), before)
  assert.match(await page.locator('#now-block .btn-done-lg').getAttribute('onclick'), new RegExp(current))
  await page.screenshot({ path: path.join(root, 'conclusao-rejeitada.png') })
  // Pin failure through the real drag interaction restores preview and saved order.
  const beforeDragIds = await page.locator('#queue-list .queue-card').evaluateAll(cards => cards.map(card => card.dataset.id))
  await page.locator('#queue-list .queue-card').last().dragTo(page.locator('#queue-list .queue-card').first(), { targetPosition: { x: 110, y: 2 } })
  await page.locator('#manual-move-modal').waitFor({ state: 'visible' })
  await page.locator('#btn-confirm-manual-move').click(); await settled()
  assert.deepEqual(read(), before)
  assert.deepEqual(await page.locator('#queue-list .queue-card').evaluateAll(cards => cards.map(card => card.dataset.id)), beforeDragIds)
  // Freeze and cancel cannot report a committed change either.
  const lastId = before.entries.find(entry => entry.id !== current).id
  await page.evaluate(id => window.freezeThrough(id), lastId); await settled()
  assert.deepEqual(read(), before)
  await page.evaluate(id => window.cancelEntry(id), lastId); await settled()
  assert.deepEqual(read(), before)

  // Normal close is blocked on unresolved storage error; no endedAt fabricated.
  await app.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.closeErrors = []
    dialog.showMessageBox = async (_window, options) => { globalThis.closeErrors.push(options); return { response: 0 } }
    BrowserWindow.getAllWindows()[0].close()
  })
  await page.waitForFunction(async () => !!window.__kqueue)
  await app.evaluate(async () => { for (let i=0;i<100&&!globalThis.closeErrors.length;i++) await new Promise(resolve=>setTimeout(resolve,20)) })
  assert.match(await app.evaluate(() => globalThis.closeErrors[0].message), /não foram confirmados/)
  assert.deepEqual(read(), before)
  heal(); await recover()
  await page.locator('#now-block .btn-done-lg').click(); await settled()
  assert.equal(read().entries.find(entry => entry.id === current).status, 'done')

  // A clean close barrier followed by an actual failed session-end transaction.
  console.log('CHECK encerramento falha')
  const beforeEnd = read()
  fail()
  await app.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.closeErrors = []
    dialog.showMessageBox = async (_window, options) => { globalThis.closeErrors.push(options); return { response: 0 } }
    BrowserWindow.getAllWindows()[0].close()
  })
  await app.evaluate(async () => { for (let i=0;i<200&&globalThis.closeErrors.length<3;i++) await new Promise(resolve=>setTimeout(resolve,20)) })
  assert.equal(await app.evaluate(() => globalThis.closeErrors.length), 3)
  assert.deepEqual(read(), beforeEnd)
  heal()
  // Main owns the close flow; reconcile the repository directly through the same application host.
  await page.evaluate(() => window.karaokeManagement.command({ operationId: 'recover-after-close-failure', command: { type: 'recoverPersistence' } }))
  console.log('CHECK perda IPC')
  // A committed write with a lost IPC response reconciles the confirmed snapshot;
  // an explicit retry reuses the operation ID and receives its cached receipt.
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('management:command')
    globalThis.originalManagementCommand = handler
    globalThis.lostReplyOnce = false
    globalThis.lostCommandIds = []
    ipcMain.removeHandler('management:command')
    ipcMain.handle('management:command', async (event, request) => {
      if (request.command.type === 'addEntries' && request.command.entries[0].table === '5') globalThis.lostCommandIds.push(request.operationId)
      const reply = await handler(event, request)
      if (!globalThis.lostReplyOnce && request.command.type === 'addEntries' && request.command.entries[0].table === '5') {
        globalThis.lostReplyOnce = true
        throw Error('Injected lost IPC reply after confirmed commit')
      }
      return reply
    })
  })
  await add('5'); await settled()
  assert.equal(read().entries.filter(entry => entry.table_number === '5').length, 1)
  assert.equal(await page.locator('#input-name').inputValue(), 'Test 5')
  await page.locator('#form-entry button[type="submit"]').click(); await settled()
  assert.equal(read().entries.filter(entry => entry.table_number === '5').length, 1)
  assert.equal(await page.locator('#input-name').inputValue(), '')
  assert.equal(await app.evaluate(() => globalThis.lostCommandIds.length), 2)
  assert.equal(await app.evaluate(() => globalThis.lostCommandIds[0]), await app.evaluate(() => globalThis.lostCommandIds[1]))
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('management:command'); ipcMain.handle('management:command', globalThis.originalManagementCommand)
  })

  // Lose reply and snapshot; explicit retry still reuses the process-local receipt.
  await app.evaluate(({ ipcMain }) => {
    globalThis.originalSnapshot = ipcMain._invokeHandlers.get('management:snapshot')
    globalThis.lostReplySix = false
    globalThis.lostSixCommandIds = []
    ipcMain.removeHandler('management:command'); ipcMain.removeHandler('management:snapshot')
    ipcMain.handle('management:command', async (event, request) => {
      if (request.command.type === 'addEntries' && request.command.entries[0].table === '6') globalThis.lostSixCommandIds.push(request.operationId)
      const reply = await globalThis.originalManagementCommand(event, request)
      if (!globalThis.lostReplySix && request.command.type === 'addEntries' && request.command.entries[0].table === '6') {
        globalThis.lostReplySix = true
        throw Error('IPC reply unavailable')
      }
      return reply
    })
    ipcMain.handle('management:snapshot', () => { throw Error('snapshot temporarily unavailable') })
  })
  await add('6'); await settled()
  assert.equal(read().entries.filter(entry => entry.table_number === '6').length, 1)
  assert.equal(await page.locator('#input-name').inputValue(), 'Test 6')
  await page.locator('#form-entry button[type="submit"]').click(); await settled()
  assert.equal(read().entries.filter(entry => entry.table_number === '6').length, 1)
  assert.equal(await page.locator('#input-name').inputValue(), '')
  assert.equal(await app.evaluate(() => globalThis.lostSixCommandIds.length), 2)
  assert.equal(await app.evaluate(() => globalThis.lostSixCommandIds[0]), await app.evaluate(() => globalThis.lostSixCommandIds[1]))
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('management:command'); ipcMain.removeHandler('management:snapshot')
    ipcMain.handle('management:command', globalThis.originalManagementCommand)
    ipcMain.handle('management:snapshot', globalThis.originalSnapshot)
  })
  await recover(); await settled()
  assert.equal(read().entries.filter(entry => entry.table_number === '6').length, 1)
  console.log('CHECK operações concorrentes')
  // A confirmed failed completion stays pending; the subsequent independent
  // freeze command is accepted and persisted through the same Main authority.
  const beforeRapid = read()
  await add('10')
  const beforeRapidSnapshot = await page.evaluate(() => window.karaokeManagement.getSnapshot())
  const ids = getManagementPlayOrder(beforeRapidSnapshot.state)
    .filter(entry => entry.id !== beforeRapid.state.current_turn_id).map(entry => entry.id)
  sql("CREATE TRIGGER fail_turn_advance BEFORE UPDATE ON app_state WHEN NEW.current_turn_id IS NOT OLD.current_turn_id BEGIN SELECT RAISE(ABORT, 'SQLITE_READONLY test-only'); END")
  await page.evaluate(({ current, last }) => {
    void window.markDone(current)
    void window.freezeThrough(last)
  }, { current: beforeRapid.state.current_turn_id, last: ids.at(-1) })
  await settled()
  assert.equal(read().entries.length, beforeRapid.entries.length + 1)
  assert.equal(read().entries.find(entry => entry.id === beforeRapid.state.current_turn_id).status, 'pending')
  assert.equal(read().state.current_turn_id, beforeRapid.state.current_turn_id)
  assert.deepEqual(JSON.parse(read().state.frozen_turn_ids_json), ids,
    'the later confirmed freeze is persisted while the rejected completion remains unchanged')
  sql('DROP TRIGGER fail_turn_advance')
  await recover()
  const saved = read()
  await closeForced(); await launch()
  assert.deepEqual(read(), saved)
  assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), saved.entries.filter(entry => entry.status === 'pending').length)
  await page.screenshot({ path: path.join(root, 'recuperacao-confirmada.png') })
  console.log('CHECK fechamento normal')
  await add('20'); await settled()
  // Main may quit before the inspector acknowledges close(). Observe its durable
  // test-only receipt outside Electron instead of evaluating in a dying process.
  const closeReceipt = path.join(root, 'normal-close-prompts.json')
  await app.evaluate(({ dialog }, receipt) => {
    let prompts = 0
    dialog.showMessageBox = async () => {
      process.getBuiltinModule('node:fs').writeFileSync(receipt, JSON.stringify(++prompts))
      return { response: 1 }
    }
  }, closeReceipt)
  const child = app.process()
  const processExited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  const windowClosed = page.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(error => {
    if (!String(error.message).includes('Target page, context or browser has been closed')) throw error
  })
  await windowClosed
  // Disconnect the test inspector so Node can finish its normal shutdown.
  await app.close()
  assert.deepEqual(await processExited, { code: 0, signal: null }, 'normal close must exit cleanly')
  app = null
  assert.equal(JSON.parse(fs.readFileSync(closeReceipt, 'utf8')), 1, 'exactly one close confirmation')
  const normallyClosed = read()
  assert.equal(normallyClosed.entries.filter(entry => entry.table_number === '20').length, 1)
  assert.equal(normallyClosed.sessions.find(session => session.id === normallyClosed.state.current_session_id).ended_at, null)
  await launch()
  assert.deepEqual(read(), normallyClosed, 'normal close/restart preserves the complete confirmed SQLite state')
  assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), normallyClosed.entries.filter(entry => entry.status === 'pending').length)
  console.log(`PASS real Electron / SQLite: rollback, inputs, completion, cancel, freeze, close failure, IPC uncertainty, recovery and restart. Evidence: ${root}`)
 } finally { await closeForced() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
