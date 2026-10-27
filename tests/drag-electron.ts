// @ts-nocheck
export {}
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')
const { assertFrozenDragBlocked, dragQueuePreview, assertDragClean, settleQueue, saveDragDiagnostics } = require('./drag-diagnostics')
const { applyFrozenQueueOrder } = require('../src/frozen-queue-rules')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-drag-e2e-'))
const profile = path.join(root, 'profile')
let app, page
const read = () => {
  const db = new DatabaseSync(path.join(profile, 'karaoke.sqlite'), { readOnly: true })
  try {
    const state = db.prepare('SELECT * FROM app_state').get()
    // Object key order is not part of a pin's persisted meaning.
    state.fixed_turn_positions_json = JSON.stringify(Object.fromEntries(
      Object.entries(JSON.parse(state.fixed_turn_positions_json)).sort(([a], [b]) => a.localeCompare(b))))
    return { state, entries: db.prepare('SELECT * FROM entries ORDER BY queue_order').all() }
  }
  finally { db.close() }
}
const ids = () => page.locator('#queue-list .queue-card').evaluateAll(cards => cards.map(card => card.dataset.id))
async function check() {
  await settleQueue(page)
  const data = read()
  const pending = data.entries.filter(entry => entry.status === 'pending' && entry.session_id === data.state.current_session_id)
  assert.deepEqual(await ids(), applyFrozenQueueOrder(pending, data.state.current_turn_id,
    JSON.parse(data.state.frozen_turn_ids_json), JSON.parse(data.state.fixed_turn_positions_json))
    .filter(entry => entry.id !== data.state.current_turn_id).map(entry => entry.id))
  return data
}
async function launch() {
  app = await electron.launch({ executablePath: require('electron'),
    args: [path.resolve(__dirname, '../..'), `--user-data-dir=${profile}`],
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data') } })
  await app.context().tracing.start({ screenshots: true, snapshots: true })
  page = await app.firstWindow()
  page.on('dialog', dialog => { void dialog.accept().catch(() => {}) })
  page.on('pageerror', error => fs.appendFileSync(path.join(root, 'renderer-errors.log'), `${error}\n`))
  await page.waitForFunction(() => !!window.__kqueue)
  if (await page.locator('#startup-modal').isVisible()) await page.locator('#btn-startup-primary').click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
}
async function close(label) {
  await app.context().tracing.stop({ path: path.join(root, `${label}.zip`) })
  await app.evaluate(({ app }) => app.exit(0)); await app.close(); app = null
}
async function add(name, table) {
  await page.locator('#input-table').fill(table)
  await page.locator('#input-name').fill(name)
  await page.locator('#input-song').fill('111')
  await page.locator('#form-entry button[type=submit]').click()
  await settleQueue(page)
}
async function move(source, target, edge = 'top', label = 'move') {
  const id = await source.getAttribute('data-id')
  const name = await source.locator('.card-name').innerText()
  const preview = await dragQueuePreview(page, source, target, edge, path.join(root, `${label}.png`))
  await page.locator('#manual-move-modal').waitFor({ state: 'visible' })
  await page.locator('#btn-confirm-manual-move').click()
  await assertDragClean(page)
  assert.deepEqual(await page.locator('#queue-list .card-name').allTextContents(), preview.map(item => item === '<inserção>' ? name : item))
  const data = await check()
  assert.equal(JSON.parse(data.state.fixed_turn_positions_json)[id], (await ids()).indexOf(id) + 1)
  return id
}
async function run() {
 try {
  await launch()
  for (const table of ['1', '2', '3']) {
    await add(`Regular ${table}`, table)
    await page.locator('#now-block .btn-done-lg').click(); await settleQueue(page)
  }
  for (const [name, table] of [['A1','1'],['A2','1'],['B1','2'],['B2','2'],['C1','3'],['C2','3'],['D','4']]) await add(name,table)
  const before = await check(), beforeIds = await ids()
  await dragQueuePreview(page, page.locator('#queue-list .queue-card').last(), page.locator('#queue-list .queue-card').first(), 'top', path.join(root,'before-cancel.png'))
  await page.locator('#manual-move-modal').waitFor({ state: 'visible' })
  await page.locator('#btn-cancel-manual-move').click(); await assertDragClean(page)
  assert.deepEqual(await check(), before); assert.deepEqual(await ids(), beforeIds)
  await dragQueuePreview(page, page.locator('#queue-list .queue-card').first(), page.locator('#queue-list .queue-card').last(), 'bottom', path.join(root,'before-escape.png'), false)
  await page.keyboard.press('Escape'); await page.mouse.up(); await assertDragClean(page)
  assert.deepEqual(await check(), before); assert.deepEqual(await ids(), beforeIds)
  const pinned = await move(page.locator('#queue-list .queue-card').last(), page.locator('#queue-list .queue-card').first(), 'top', 'after-cancel-and-escape')
  await move(page.locator(`[data-id="${pinned}"]`), page.locator('#queue-list .queue-card').last(), 'bottom', 'move-pinned-down')
  await page.locator(`[data-id="${pinned}"] button[title="Remover fixação"]`).click(); await check()
  assert.equal(JSON.parse(read().state.fixed_turn_positions_json)[pinned], undefined)
  await move(page.locator(`[data-id="${pinned}"]`), page.locator('#queue-list .queue-card').first(), 'top', 'released-and-moved')
  await page.locator('#queue-list .queue-card').nth(1).locator('.btn-freeze').click(); await check()
  const frozen = JSON.parse(read().state.frozen_turn_ids_json)
  await move(page.locator('#queue-list .queue-card[data-frozen=false]').last(), page.locator('#queue-list .queue-card[data-frozen=false]').first(), 'top', 'dynamic-after-frozen')
  assert.deepEqual(JSON.parse(read().state.frozen_turn_ids_json), frozen)
  const protectedBefore = await check()
  await assertFrozenDragBlocked(page, page.locator('#queue-list .queue-card[data-frozen=true]').first())
  await assertDragClean(page); assert.deepEqual(await check(), protectedBefore)
  await page.locator('#btn-release-freeze').click(); await check()
  assert.equal(JSON.parse(read().state.fixed_turn_positions_json)[pinned] > 0, true)
  await add('Arrival','5')
  await move(page.locator('#queue-list .queue-card').last(), page.locator('#queue-list .queue-card').first(), 'top', 'after-add')
  await page.locator('#now-block .btn-done-lg').click(); await check()
  await move(page.locator('#queue-list .queue-card').last(), page.locator('#queue-list .queue-card').first(), 'top', 'after-completion')
  const cancel = page.locator('#queue-list .queue-card').last()
  await cancel.locator('.queue-action-menu-toggle').click(); await page.getByRole('menuitem',{name:'Cancelar',exact:true}).click(); await check()
  await move(page.locator('#queue-list .queue-card').last(), page.locator('#queue-list .queue-card').first(), 'top', 'after-cancellation')
  await page.locator('#nav-settings').click(); await page.locator('#settings-scale-select').selectOption('125')
  await page.waitForFunction(() => document.querySelector('#settings-scale-effective')?.textContent?.trim() === '125%')
  await page.locator('#nav-dashboard').click()
  await move(page.locator('#queue-list .queue-card').first(), page.locator('#queue-list .queue-card').last(), 'bottom', 'scale-125')
  const saved = await check()
  await saveDragDiagnostics(page, root, 'events-completed')
  await close('before-restart'); await launch()
  assert.deepEqual(await check(), saved)
  await page.screenshot({ path:path.join(root,'recovered-pin.png') })
  await close('after-restart')
  console.log(`PASS drag A–N: accepted native drops, cancel → Escape → confirm, pins/freeze, mutations, zoom and SQLite restart. Evidence: ${root}`)
 } catch(error) {
  if(app) { await saveDragDiagnostics(page,root,'failure').catch(()=>{}); await close('failure-trace').catch(()=>{}) }
  throw error
 }
}
run().catch(error=>{ console.error(error); process.exitCode=1 })
