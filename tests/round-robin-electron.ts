// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')
const { applyFrozenQueueOrder } = require('../src/frozen-queue-rules')
const { createKaraokeDatabase } = require('../database')
const projectRoot = path.resolve(__dirname, '../..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-rr-electron-'))
const profile = path.join(root, 'profile')
const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-rr-evidence-'))

async function run() {
  let app
  let page
  let databasePath
  const launch = async () => {
    app = await electron.launch({ executablePath: require('electron'),
      args: [projectRoot, `--user-data-dir=${profile}`],
      env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data') }
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => !!window.__kqueue)
    if (await page.locator('#startup-modal').isVisible()) await page.locator('#btn-startup-primary').click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
    const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
    assert.ok(path.resolve(actualProfile).startsWith(path.resolve(root)), 'isolated profile')
    databasePath = path.join(actualProfile, 'karaoke.sqlite')
    assert.equal(await page.evaluate(() => !!window.karaokeDatabase), true, 'uses SQLite IPC bridge')
  }
  const close = async () => {
    if (!app) return
    await page.evaluate(() => window.__kqueue?.flushState()).catch(() => {})
    await app.evaluate(({ app }) => app.exit(0))
    await app.close()
    app = undefined
  }
  const read = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      return { state: db.prepare('SELECT * FROM app_state WHERE singleton = 1').get(),
        sessions: db.prepare('SELECT * FROM sessions').all(),
        entries: db.prepare('SELECT * FROM entries ORDER BY queue_order').all() }
    } finally { db.close() }
  }
  const pendingNames = () => page.locator('#queue-list .queue-card .card-name').allTextContents()
  const add = async (name, table) => {
    await page.locator('#input-table').fill(table)
    await page.locator('#input-name').fill(name)
    await page.locator('#input-song').fill('111')
    await page.locator('#input-song2').fill('222')
    await page.locator('#form-entry button[type="submit"]').click()
    await page.evaluate(() => window.__kqueue.flushState())
  }
  const checkDatabaseOrder = async () => {
    await page.evaluate(() => window.__kqueue.flushState())
    const data = read()
    const queue = data.entries.filter(entry => entry.status === 'pending' && entry.session_id === data.state.current_session_id)
    const ids = applyFrozenQueueOrder(queue, data.state.current_turn_id,
      JSON.parse(data.state.frozen_turn_ids_json), JSON.parse(data.state.fixed_turn_positions_json))
      .filter(entry => entry.id !== data.state.current_turn_id).map(entry => entry.id)
    assert.deepEqual(await page.locator('#queue-list .queue-card').evaluateAll(cards => cards.map(card => card.dataset.id)), ids)
    assert.equal(data.state.queue_order_policy_version, 2)
    assert.equal(new Set(queue.map(entry => entry.id)).size, queue.length)
    return data
  }
  const done = async () => {
    const before = await pendingNames()
    const beforeData = await checkDatabaseOrder()
    // Anchor retries to this turn. The generic current-button selector can
    // resolve to the following turn when a click removes/replaces its DOM node.
    const action = await page.locator('#now-block .btn-done-lg').getAttribute('onclick')
    await page.locator(`#now-block .btn-done-lg[onclick=${JSON.stringify(action)}]`).click()
    if (before.length) assert.equal(await page.locator('#now-block .now-name').innerText(), before[0], 'executes displayed first turn')
    const afterData = await checkDatabaseOrder()
    assert.equal(afterData.entries.filter(entry => entry.status === 'done').length,
      beforeData.entries.filter(entry => entry.status === 'done').length + 1, 'one click completes exactly one turn')
    assert.equal(afterData.entries.find(entry => entry.id === beforeData.state.current_turn_id).status, 'done')
  }
  try {
    await launch()
    for (const table of ['1', '2', '3']) { await add(`Histórico ${table}`, table); await done() }
    for (const [prefix, table, count] of [['A', '1', 5], ['B', '2', 3], ['C', '3', 2]]) {
      for (let i = 1; i <= count; i++) await add(`${prefix}${i}`, table)
    }
    const expected = ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'A4', 'A5']
    assert.equal(await page.locator('#now-block .now-name').innerText(), expected[0])
    assert.deepEqual(await pendingNames(), expected.slice(1))
    const first = await checkDatabaseOrder()
    assert.deepEqual(first.entries.filter(entry => entry.status === 'pending').map(entry => entry.name), expected,
      'queue_order itself stores Round Robin, not only a UI projection')
    await page.screenshot({ path: path.join(shots, 'round-robin.png') })
    await done()
    await done()
    const partial = await checkDatabaseOrder()
    const partialNames = await pendingNames()
    await close()
    await launch()
    assert.deepEqual(await pendingNames(), partialNames)
    const resumed = await checkDatabaseOrder()
    for (const field of ['current_turn_id', 'current_turn_automatic', 'regulars_since_debut'])
      assert.equal(resumed.state[field], partial.state[field])

    // Exercise the actual drag handler and confirmation before freezing.
    const moving = page.locator('#queue-list .queue-card').nth(2)
    const movedId = await moving.getAttribute('data-id')
    await moving.dragTo(page.locator('#queue-list .queue-card').first(), { targetPosition: { x: 110, y: 2 } })
    await page.locator('#manual-move-modal').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('#btn-confirm-manual-move').click()
    await page.locator('#manual-move-modal').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('#queue-list .queue-card').first().getAttribute('data-id'), movedId)
    assert.equal(JSON.parse((await checkDatabaseOrder()).state.fixed_turn_positions_json)[movedId], 1)
    page.once('dialog', dialog => dialog.accept())
    await page.locator('#queue-list .queue-card').nth(1).locator('.btn-freeze').click()
    const protectedData = await checkDatabaseOrder()
    const frozen = JSON.parse(protectedData.state.frozen_turn_ids_json)
    assert.equal(frozen.length, 2)
    await add('Chegada durante congelamento', '1')
    let protectedAfter = await checkDatabaseOrder()
    assert.deepEqual(JSON.parse(protectedAfter.state.frozen_turn_ids_json), frozen)
    assert.equal(protectedAfter.state.fixed_turn_positions_json, protectedData.state.fixed_turn_positions_json)
    await page.screenshot({ path: path.join(shots, 'round-robin-protecoes.png') })
    const protectedNames = await pendingNames()
    await close()
    await launch()
    assert.deepEqual(await pendingNames(), protectedNames)
    const protectedRestored = await checkDatabaseOrder()
    for (const field of ['frozen_turn_ids_json', 'fixed_turn_positions_json', 'current_turn_id', 'regulars_since_debut'])
      assert.equal(protectedRestored.state[field], protectedAfter.state[field])

    page.once('dialog', dialog => dialog.accept())
    await page.locator('#btn-release-freeze').click()
    await page.locator(`[data-id="${movedId}"] button[title="Remover fixação"]`).click()
    const released = await checkDatabaseOrder()
    assert.deepEqual(JSON.parse(released.state.frozen_turn_ids_json), [])
    assert.deepEqual(JSON.parse(released.state.fixed_turn_positions_json), {})
    const cancel = page.locator('#queue-list .queue-card').last()
    const cancelId = await cancel.getAttribute('data-id')
    await cancel.locator('.queue-action-menu-toggle').click()
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('menuitem', { name: 'Cancelar', exact: true }).click()
    assert.equal((await checkDatabaseOrder()).entries.find(entry => entry.id === cancelId).status, 'cancelled')
    while (await page.locator('#now-block .now-card').count()) await done()
    const final = await checkDatabaseOrder()
    assert.equal(final.entries.filter(entry => entry.status === 'done').length, 13)
    assert.equal(final.entries.filter(entry => entry.status === 'cancelled').length, 1)
    assert.equal(final.entries.filter(entry => entry.status === 'pending').length, 0)
    await close()

    // Restore an established 2:1 sequence in this test-only SQLite profile.
    // The renderer loads it via IPC, then every completion uses the real UI.
    const fixture = createKaraokeDatabase(profile)
    const state = fixture.loadState()
    // The preceding UI scenario finished at table 1. Start this fixture at 2
    // so anti-repetition and the cadence assertion do not intentionally clash.
    const plan = [ ['R1', '2'], ['R2', '3'], ['D1', '10'], ['R3', '1'], ['R4', '2'],
      ['D2', '11'], ['R5', '3'], ['R6', '1'], ['D3', '12'] ]
    state.queue = plan.map(([name, table], index) => ({
      id: `cadence-${name}`, name, table, songNumber: '333', songNumber2: '',
      status: 'pending', sessionId: state.currentSessionId, insertedAt: Date.now() + index
    }))
    state.currentTurnId = null
    state.currentTurnAutomatic = false
    state.regularsSinceDebut = 0
    fixture.saveState(state)
    fixture.close()
    await launch()
    const executed = []
    for (let index = 0; index < plan.length; index++) {
      const name = await page.locator('#now-block .now-name').innerText()
      assert.equal(name, plan[index][0])
      executed.push(name[0])
      await done()
      if (index === 1) {
        const before = await checkDatabaseOrder()
        assert.equal(before.state.regulars_since_debut, 2)
        assert.equal(before.state.current_turn_id, 'cadence-D1')
        await close()
        await launch()
        const after = await checkDatabaseOrder()
        assert.equal(after.state.regulars_since_debut, 2)
        assert.equal(after.state.current_turn_id, 'cadence-D1')
      }
    }
    assert.equal(executed.join(''), 'RRDRRDRRD')
    const endedCycle = await checkDatabaseOrder()
    assert.equal(endedCycle.state.regulars_since_debut, 0,
      'the final automatic debut resets the phase with no regular waiting')
    assert.equal(endedCycle.entries.find(entry => entry.id === 'cadence-D3').status, 'done')
    const sessionId = endedCycle.state.current_session_id

    // Exercise the normal native close flow: "Sair sem encerrar sessão".
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (_window, options) => {
        assertCloseChoice(options)
        return { response: 1 }
      }
      function assertCloseChoice(options) {
        if (!options.buttons[1].includes('Sair sem encerrar')) throw new Error('Unexpected close choices')
      }
    })
    const closed = page.waitForEvent('close', { timeout: 8000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await closed
    await app.close().catch(() => {})
    app = undefined
    assert.equal(read().state.regulars_since_debut, 0)
    assert.equal(read().sessions.find(session => session.id === sessionId).ended_at, null)
    await launch()
    assert.equal((await checkDatabaseOrder()).state.regulars_since_debut, 0)
    assert.equal(read().state.current_session_id, sessionId)
    await add('Novo R1', '1')
    await add('Novo R2', '2')
    await add('Nova estreia', '20')
    assert.equal(await page.locator('#now-block .now-name').innerText(), 'Novo R1')
    assert.deepEqual(await pendingNames(), ['Novo R2', 'Nova estreia'])
    const newCycle = await checkDatabaseOrder()
    assert.equal(newCycle.state.regulars_since_debut, 0, 'selection and arrivals consume no cadence opportunity')
    assert.deepEqual(newCycle.entries.filter(entry => entry.status === 'pending').map(entry => entry.name),
      ['Novo R1', 'Novo R2', 'Nova estreia'])
    await close()
    console.log(`PASS Electron + SQLite IPC: Round Robin 5/3/2, DnD/pin, freeze/release, cancellation, cadence RRDRRDRRD, final reset persisted as 0, normal exit without ending session, restart and new R1/R2/E1. Screenshots: ${shots}`)
  } finally {
    if (app) await close().catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
