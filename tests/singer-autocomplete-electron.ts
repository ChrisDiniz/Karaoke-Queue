// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-singer-autocomplete-'))
const userDataDir = path.join(profileRoot, 'profile')
const screenshotDir = path.join(os.tmpdir(), `karaoke-singer-autocomplete-shots-${Date.now()}`)
fs.mkdirSync(screenshotDir, { recursive: true })

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
  const pageOf = async instance => {
    const page = await instance.firstWindow()
    page.on('dialog', dialog => dialog.accept())
    await page.waitForFunction(() => !!window.__kqueue)
    return page
  }
  const add = async (page, { name, table, song }) => {
    await page.locator('#input-table').fill(String(table))
    await page.locator('#input-name').fill(name)
    await page.locator('#input-song').fill(song)
    await page.locator('#form-entry button[type="submit"]').click()
    await page.waitForTimeout(80)
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.id), 'input-table',
      'form resets and returns focus to Mesa after adding')
  }
  const databasePath = () => path.join(userDataDir, 'karaoke.sqlite')
  const readDb = callback => {
    const db = new DatabaseSync(databasePath(), { readOnly: true })
    try { return callback(db) } finally { db.close() }
  }
  const forceRestart = async () => {
    if (!app) return
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
    await app.close().catch(() => {})
    app = undefined
  }

  try {
    app = await launch()
    let page = await pageOf(app)
    await page.bringToFront()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
    if (await page.locator('#startup-modal').isVisible()) await page.locator('#btn-startup-primary').click()
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.id), 'input-table',
      'Mesa receives initial focus')
    assert.equal(await page.locator('#clock').count(), 0, 'top clock is removed')
    assert.equal(await page.locator('#btn-notifications').isVisible(), true, 'notification bell remains visible')
    const topMetrics = await page.evaluate(() => ({
      header: document.querySelector('.app-header')!.getBoundingClientRect().height,
      brand: document.querySelector('.sidebar-brand')!.getBoundingClientRect().height,
      form: document.querySelector('.form-section')!.getBoundingClientRect().height,
      formRow: document.querySelector('.form-row')!.getBoundingClientRect().height,
      sourceRow: document.querySelector('.source-selector')!.getBoundingClientRect().height,
      bellCenter: (() => {
        const header = document.querySelector('.app-header')!.getBoundingClientRect()
        const bell = document.querySelector('#btn-notifications')!.getBoundingClientRect()
        return bell.top + bell.height / 2 - (header.top + header.height / 2)
      })()
    }))
    assert.equal(topMetrics.header, 40)
    assert.equal(topMetrics.brand, 40)
    assert.ok(Math.abs(topMetrics.bellCenter) <= 1, 'notification bell is centered in the compact header')
    console.log(`1280x800 layout metrics: ${JSON.stringify(topMetrics)}`)
    assert.equal(await page.locator('.sidebar-brand-logo').isVisible(), true)
    await page.locator('#btn-sidebar-toggle').click()
    assert.equal(await page.locator('#app-sidebar').evaluate(element => element.classList.contains('is-expanded')), true)
    await page.locator('#btn-sidebar-toggle').click()
    assert.equal(await page.locator('#app-sidebar').evaluate(element => element.classList.contains('is-expanded')), false)
    await page.locator('#btn-notifications').click()
    await page.locator('#toast').waitFor({ state: 'visible' })
    assert.match(await page.locator('#toast').innerText(), /Notificações em breve/)
    const sourceTrigger = page.locator('#source-trigger')
    const sourceMenu = page.locator('#source-menu')
    const sourceLocal = page.locator('.source-menu-option[data-source="local"]')
    const sourceYoutube = page.locator('.source-menu-option[data-source="youtube"]')
    assert.equal(await page.locator('#source-selector').getAttribute('data-selected-source'), 'local',
      'Local is the initial visual source')
    assert.equal(await sourceMenu.isHidden(), true)
    const formHeightBeforeSourceMenu = await page.locator('.form-section').evaluate(element => element.getBoundingClientRect().height)
    await sourceTrigger.click()
    await sourceMenu.waitFor({ state: 'visible' })
    assert.equal(await sourceTrigger.getAttribute('aria-expanded'), 'true')
    assert.equal(await sourceLocal.getAttribute('aria-checked'), 'true')
    assert.equal(await sourceYoutube.getAttribute('aria-checked'), 'false')
    assert.equal(await sourceYoutube.isDisabled(), true, 'YouTube is disabled')
    assert.equal(await sourceYoutube.getAttribute('aria-disabled'), 'true')
    const youtubeTooltip = page.locator('#source-youtube-coming-soon')
    assert.equal(await youtubeTooltip.isVisible(), false)
    await page.locator('.source-menu-tooltip').hover()
    assert.equal(await youtubeTooltip.innerText(), 'Em breve')
    await youtubeTooltip.waitFor({ state: 'visible' })
    await page.screenshot({ path: path.join(screenshotDir, 'acervo-dropdown-aberto.png') })
    const disabledYoutubeBounds = await sourceYoutube.boundingBox()
    assert.ok(disabledYoutubeBounds)
    await page.mouse.click(disabledYoutubeBounds.x + disabledYoutubeBounds.width / 2,
      disabledYoutubeBounds.y + disabledYoutubeBounds.height / 2)
    assert.equal(await page.locator('#source-selector').getAttribute('data-selected-source'), 'local',
      'clicking disabled YouTube cannot change the selected origin')
    assert.equal(await sourceMenu.isVisible(), true, 'disabled YouTube does not close the menu')
    await sourceLocal.click()
    assert.equal(await sourceMenu.isHidden(), true, 'selecting Local closes the dropdown')
    await sourceTrigger.click()
    assert.equal(await sourceLocal.getAttribute('aria-checked'), 'true', 'Local remains selected when reopened')
    assert.equal(await sourceYoutube.getAttribute('aria-checked'), 'false')
    await sourceTrigger.click()
    assert.equal(await page.locator('.form-section').evaluate(element => element.getBoundingClientRect().height),
      formHeightBeforeSourceMenu, 'opening and selecting an origin does not change form height')
    await sourceTrigger.click()
    await page.keyboard.press('Escape')
    assert.equal(await sourceMenu.isHidden(), true, 'Escape closes the dropdown')
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.id), 'source-trigger',
      'Escape restores focus to the trigger')
    await sourceTrigger.press('ArrowDown')
    assert.equal(await sourceMenu.isVisible(), true, 'ArrowDown opens the dropdown')
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.source), 'local')
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.source), 'local',
      'keyboard navigation skips the disabled YouTube option')
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('#source-selector').getAttribute('data-selected-source'), 'local',
      'keyboard interaction keeps the only available source selected')
    await sourceTrigger.click()
    await page.locator('#input-table').click()
    assert.equal(await sourceMenu.isHidden(), true, 'outside click closes the dropdown')
    await sourceTrigger.click()
    await sourceLocal.click()
    assert.equal(await page.locator('#source-selector').getAttribute('data-selected-source'), 'local')
    await page.locator('#btn-theme-toggle').click()
    await sourceTrigger.click()
    assert.equal(await sourceMenu.isVisible(), true, 'dropdown opens in the light theme')
    const lightMenuBackground = await sourceMenu.evaluate(element => getComputedStyle(element).backgroundColor)
    await page.screenshot({ path: path.join(screenshotDir, 'acervo-dropdown-claro.png') })
    await page.keyboard.press('Escape')
    await page.locator('#btn-theme-toggle').click()
    const darkMenuBackground = await sourceMenu.evaluate(element => getComputedStyle(element).backgroundColor)
    assert.notEqual(lightMenuBackground, darkMenuBackground, 'dropdown follows both theme palettes')
    await page.mouse.move(1250, 780)

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1920, 1080)
      window.webContents.setZoomFactor(1)
    })
    await page.waitForTimeout(100)
    const wideLayout = await Promise.all([
      page.locator('#input-table').boundingBox(), page.locator('#btn-open-batch').boundingBox(),
      page.locator('.app-header').boundingBox()
    ])
    assert.ok(wideLayout.every(Boolean))
    assert.ok(Math.abs(wideLayout[0].y - wideLayout[1].y) <= 1, 'form remains on one line at 1920x1080')
    assert.equal(wideLayout[2].height, 40, 'compact header height is stable at 1920x1080')
    for (const factor of [1.1, 1.25]) {
      await app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), factor)
      await page.waitForTimeout(80)
      const scaledBounds = await Promise.all([
        page.locator('#input-table').boundingBox(), page.locator('#btn-open-batch').boundingBox()
      ])
      const scaledViewport = await page.evaluate(() => innerWidth)
      assert.ok(scaledBounds.every(Boolean) && scaledBounds.every(box => box.x + box.width <= scaledViewport + 1),
        `form controls remain within the window at ${Math.round(factor * 100)}%`)
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
    await page.waitForTimeout(100)
    const addButton = page.locator('#form-entry button[type="submit"]')
    const batchButton = page.locator('#btn-open-batch')
    assert.equal((await addButton.innerText()).replace(/\s+/g, ' ').trim(), '+ Adicionar')
    assert.equal((await batchButton.innerText()).trim(), 'Vários')
    assert.equal(await batchButton.getAttribute('aria-label'), 'Adicionar várias apresentações')
    assert.equal(await batchButton.getAttribute('title'), 'Adicionar várias apresentações')
    const [addBox, batchBox, tableBox] = await Promise.all([
      addButton.boundingBox(), batchButton.boundingBox(), page.locator('#input-table').boundingBox()
    ])
    assert.ok(addBox && batchBox && tableBox)
    assert.ok(Math.abs(addBox.height - tableBox.height) <= 2, 'Add button height matches the input')
    assert.ok(Math.abs(batchBox.y - addBox.y) <= 1, 'form actions share one horizontal row')
    await batchButton.hover()
    await page.waitForTimeout(180)
    assert.notEqual(await batchButton.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)',
      'secondary action has a visible hover state')
    await page.locator('#input-song2').focus()
    await page.keyboard.press('Tab')
    const keyboardFocus = await page.evaluate(() => ({
      text: (document.activeElement as HTMLElement)?.textContent?.replace(/\s+/g, ' ').trim(),
      type: (document.activeElement as HTMLButtonElement)?.type,
      outlineStyle: getComputedStyle(document.activeElement as HTMLElement).outlineStyle
    }))
    assert.equal(keyboardFocus.type, 'submit')
    assert.match(keyboardFocus.text, /Adicionar/)
    assert.equal(keyboardFocus.outlineStyle, 'solid', 'primary action shows keyboard focus')
    await batchButton.click()
    await page.locator('#batch-modal').waitFor({ state: 'visible' })
    await page.locator('#btn-close-batch').click()
    await page.locator('#batch-modal').waitFor({ state: 'hidden' })
    await add(page, { name: 'João', table: 5, song: '101' })
    assert.equal(await page.locator('#source-selector').getAttribute('data-selected-source'), 'local',
      'registration remains on Local because YouTube is unavailable')
    assert.ok(await page.evaluate(() => window.__kqueue.queueLength()) > 0)
    await page.locator('#now-block .btn-done-lg').click()
    await page.locator('#now-block').waitFor({ state: 'hidden' })
    await sourceTrigger.click()
    await sourceLocal.click()
    await add(page, { name: 'José', table: 5, song: '202' })
    await add(page, { name: 'JOSÉ', table: 5, song: '203' })
    await add(page, { name: 'Joana', table: 6, song: '303' })
    await add(page, { name: 'Juliana', table: 5, song: '404' })

    const julianaCard = page.locator('.queue-card').filter({ hasText: 'Juliana' }).first()
    await julianaCard.locator('.queue-action-menu-toggle').click()
    await page.getByRole('menuitem', { name: 'Cancelar' }).click()
    await julianaCard.waitFor({ state: 'detached' })
    await add(page, { name: 'Jana', table: 5, song: '606' })
    await add(page, { name: 'Jéssica', table: 5, song: '607' })
    await add(page, { name: 'Júlia', table: 5, song: '608' })
    await add(page, { name: 'Jorge', table: 5, song: '609' })

    const name = page.locator('#input-name')
    await page.locator('#input-table').fill('5')
    const list = page.locator('#singer-suggestions')
    const readLayout = () => page.evaluate(() => {
      const rect = (selector: string) => {
        const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect()
        return { x, y, width, height }
      }
      return {
        form: rect('.form-section'),
        sources: rect('#source-selector'),
        current: rect('#now-block'),
        queue: rect('.queue-section')
      }
    })
    await name.fill('')
    assert.equal(await list.isHidden(), true)
    const closedLayout = await readLayout()
    const [sourceSelectorBox, sourceTriggerBox] = await Promise.all([
      page.locator('#source-selector').boundingBox(), sourceTrigger.boundingBox()
    ])
    assert.ok(sourceSelectorBox && sourceTriggerBox)
    assert.ok(Math.abs(sourceSelectorBox.x - sourceTriggerBox.x) <= 1, 'Acervo trigger is aligned to the left of its row')
    await page.screenshot({ path: path.join(screenshotDir, 'formulario-autocomplete-fechado.png') })

    await name.fill('jana')
    await list.waitFor({ state: 'visible' })
    let options = await list.locator('[role="option"]').allTextContents()
    assert.deepEqual(options, ['Jana'], 'one matching suggestion is shown')
    const oneSuggestionLayout = await readLayout()
    assert.deepEqual(oneSuggestionLayout, closedLayout, 'one suggestion does not alter form or queue geometry')
    await page.screenshot({ path: path.join(screenshotDir, 'autocomplete-uma-sugestao.png') })

    await name.fill('j')
    await list.waitFor({ state: 'visible' })
    options = await list.locator('[role="option"]').allTextContents()
    assert.equal(options.length, 6, 'the six-suggestion limit is exercised')
    assert.ok(options.includes('João'))
    assert.ok(options.includes('JOSÉ'))
    assert.equal(options.filter(item => item.toLocaleLowerCase('pt-BR') === 'josé').length, 1,
      'case variants collapse into one suggestion')
    assert.ok(!options.includes('Joana'), 'another table is excluded')
    assert.ok(!options.includes('Juliana'), 'canceled-only singer is excluded')
    const dropdownBox = await list.boundingBox()
    const sixSuggestionLayout = await readLayout()
    assert.deepEqual(sixSuggestionLayout, closedLayout, 'six suggestions do not alter form, source or queue geometry')
    assert.ok(dropdownBox && dropdownBox.height <= 240, 'dropdown height stays capped')
    assert.equal(await list.evaluate(element => getComputedStyle(element).overflowY), 'auto',
      'long suggestion lists scroll internally')
    const layoutBeforeMenuWithAutocomplete = await readLayout()
    await sourceTrigger.click()
    await sourceMenu.waitFor({ state: 'visible' })
    assert.equal(await list.isVisible(), true, 'origin menu can open while singer autocomplete is visible')
    assert.deepEqual(await readLayout(), layoutBeforeMenuWithAutocomplete,
      'origin menu does not displace autocomplete, form, current turn or queue')
    await page.screenshot({ path: path.join(screenshotDir, 'acervo-dropdown-com-autocomplete.png') })
    await page.locator('#input-table').click()
    assert.equal(await sourceMenu.isHidden(), true, 'clicking outside closes source menu without blocking form inputs')
    await page.screenshot({ path: path.join(screenshotDir, 'autocomplete-seis-sugestoes.png') })
    await page.locator('#btn-theme-toggle').click()
    await page.locator('#input-name').fill('j')
    await page.locator('#singer-suggestions').waitFor({ state: 'visible' })
    await page.mouse.move(1250, 780)
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(screenshotDir, 'autocomplete-seis-sugestoes-claro.png') })
    await page.locator('#btn-theme-toggle').click()
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(960, 600)
      window.webContents.setZoomFactor(1.5)
    })
    await page.waitForTimeout(250)
    const compactBounds = await Promise.all([
      addButton.boundingBox(), batchButton.boundingBox(), page.locator('#input-song2').boundingBox()
    ])
    const compactViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    assert.ok(compactBounds.every(Boolean),
      `responsive form geometry unavailable: ${JSON.stringify({ compactBounds, compactViewport, page: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, ready: document.readyState, hidden: document.hidden })) })}`)
    assert.ok(compactBounds.every(box => box.x >= 0 && box.y >= 0 && box.x + box.width <= compactViewport.width + 1),
      'form fields and both actions remain inside a 960x600 viewport at 150%')
    const compactSource = await sourceTrigger.boundingBox()
    assert.ok(compactSource && compactSource.x >= 0 && compactSource.x + compactSource.width <= compactViewport.width + 1,
      'Acervo trigger remains inside the viewport at 150%')
    await page.locator('#input-name').fill('j')
    await page.locator('#singer-suggestions').waitFor({ state: 'visible' })
    const suggestionBounds = await page.locator('#singer-suggestions').boundingBox()
    assert.ok(suggestionBounds && suggestionBounds.x + suggestionBounds.width <= compactViewport.width + 1,
      'autocomplete remains visible and unclipped at 150%')
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.webContents.setZoomFactor(1)
      window.setContentSize(1280, 800)
    })
    await page.locator('#input-name').fill('')

    await name.press('Escape')
    assert.equal(await list.isHidden(), true, 'Escape closes suggestions')
    await name.focus()
    await name.fill('j')
    await list.waitFor({ state: 'visible' })
    await name.press('Tab')
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.id), 'input-song',
      'Tab continues through the form without trapping focus')
    await name.focus()
    await name.fill('j')
    await list.waitFor({ state: 'visible' })

    const beforeSelect = await page.evaluate(() => window.__kqueue.queueLength())
    await list.getByRole('option', { name: 'JOSÉ' }).click()
    assert.equal(await name.inputValue(), 'JOSÉ', 'mouse selection preserves saved spelling')
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), beforeSelect)

    await name.fill('jo')
    await list.waitFor({ state: 'visible' })
    await name.press('ArrowDown')
    await name.press('ArrowUp')
    await name.press('Enter')
    assert.equal(await name.inputValue(), 'João', 'keyboard selection updates the name')
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), beforeSelect,
      'Enter selecting a suggestion does not submit the form')
    await page.locator('#input-song').fill('505')
    await page.locator('#form-entry button[type="submit"]').click()
    await page.waitForFunction(count => window.__kqueue.queueLength() === count + 1, beforeSelect)
    assert.equal(await list.isHidden(), true, 'suggestions close after submission')

    // Changing the table refreshes the source set; no prior-table singer is filled automatically.
    await page.locator('#input-table').fill('5')
    await name.fill('jo')
    await list.waitFor({ state: 'visible' })
    await page.locator('#input-table').fill('6')
    await list.waitFor({ state: 'hidden' })
    await name.focus()
    await list.waitFor({ state: 'visible' })
    options = await list.locator('[role="option"]').allTextContents()
    assert.deepEqual(options, ['Joana'])
    await name.fill('Pessoa nova')
    assert.equal(await list.isHidden(), true, 'new names remain freely enterable')
    await page.locator('#input-song').fill('606')
    await page.locator('#form-entry button[type="submit"]').click()
    await page.waitForFunction(count => window.__kqueue.queueLength() === count + 1, beforeSelect + 1)
    await page.evaluate(() => window.__kqueue.flushState())

    const activeSessionId = readDb(db => db.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id)
    const completedPersisted = readDb(db => db.prepare("SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND status = 'done'").get(activeSessionId).n)
    assert.equal(completedPersisted, 1, 'completed records used by suggestions are persisted in SQLite')

    // Restart with the same open session: suggestions must be derived from SQLite-loaded state.
    await forceRestart()
    app = await launch()
    page = await pageOf(app)
    assert.equal(await page.locator('#startup-modal').isVisible(), true)
    await page.locator('#btn-startup-primary').click()
    await page.locator('#input-table').fill('5')
    await page.locator('#input-name').fill('jo')
    await page.locator('#singer-suggestions').waitFor({ state: 'visible' })
    options = await page.locator('#singer-suggestions [role="option"]').allTextContents()
    assert.ok(options.includes('João'))
    assert.ok(options.includes('JOSÉ'))

    // Starting a new session from the startup prompt must not inherit old suggestions.
    await forceRestart()
    app = await launch()
    page = await pageOf(app)
    assert.equal(await page.locator('#startup-modal').isVisible(), true)
    await page.locator('#btn-startup-secondary').click()
    await page.locator('#startup-modal').waitFor({ state: 'hidden' })
    const newSessionId = readDb(db => db.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id)
    assert.notEqual(newSessionId, activeSessionId)
    await page.locator('#input-table').fill('5')
    await page.locator('#input-name').fill('jo')
    await page.waitForTimeout(100)
    assert.equal(await page.locator('#singer-suggestions').isVisible(), false,
      'previous session names do not appear in a newly started session')
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 0)
    const oldSessionCounts = readDb(db => ({
      old: db.prepare("SELECT COUNT(*) AS n FROM entries WHERE session_id = ?").get(activeSessionId).n,
      new: db.prepare("SELECT COUNT(*) AS n FROM entries WHERE session_id = ?").get(newSessionId).n
    }))
    assert.ok(oldSessionCounts.old > 0)
    assert.equal(oldSessionCounts.new, 0)
    console.log(`Screenshots: ${screenshotDir}/acervo-dropdown-aberto.png, ${screenshotDir}/acervo-dropdown-claro.png, ${screenshotDir}/acervo-dropdown-com-autocomplete.png, ${screenshotDir}/formulario-autocomplete-fechado.png, ${screenshotDir}/autocomplete-uma-sugestao.png, ${screenshotDir}/autocomplete-seis-sugestoes.png`)
    console.log('PASS: Electron real + SQLite — suggestions per table/session, history, pending, cancellation, keyboard/mouse selection and restart isolation')
  } finally {
    await forceRestart()
    fs.rmSync(profileRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
