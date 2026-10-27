// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-queue-menu-e2e-'))
const profile = path.join(root, 'profile')
const screenshots = path.join(root, 'screenshots')
fs.mkdirSync(profile, { recursive: true })
fs.mkdirSync(screenshots, { recursive: true })

async function run() {
  const app = await electron.launch({ executablePath: require('electron'),
    args: [path.resolve(__dirname, '../..'), `--user-data-dir=${profile}`],
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data') }, timeout: 30000 })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!window.__kqueue)
    if (await page.locator('#startup-modal').isVisible()) await page.locator('#btn-startup-primary').click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))

    for (let i = 1; i <= 20; i++) {
      await page.locator('#input-table').fill(String(i))
      await page.locator('#input-name').fill(`Cantor ${String(i).padStart(2, '0')}`)
      await page.locator('#input-song').fill(String(100 + i))
      await page.locator('#form-entry button[type="submit"]').click()
    }
    await page.evaluate(() => window.__kqueue.flushState())
    const cards = page.locator('#queue-list > .queue-card')
    assert.ok(await cards.count() >= 18, 'the queue exceeds the visible viewport')

    const visibleBounds = async menu => page.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
      const list = document.querySelector('.app-main').getBoundingClientRect()
      return { rect: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        viewport, list: { left: list.left, top: list.top, right: list.right, bottom: list.bottom } }
    }, await menu.elementHandle())
    const assertInsideViewport = box => {
      assert.ok(box.rect.x >= 0 && box.rect.y >= 0, `menu starts inside viewport: ${JSON.stringify(box)}`)
      assert.ok(box.rect.right <= box.viewport.width + 0.5, `menu stays left of right edge: ${JSON.stringify(box)}`)
      assert.ok(box.rect.bottom <= box.viewport.height + 0.5, `menu stays above bottom edge: ${JSON.stringify(box)}`)
      assert.ok(box.rect.width > 0 && box.rect.height > 0)
    }
    const popover = () => page.locator('.queue-action-menu-popover.is-open')
    const closeByOutside = async () => {
      await page.locator('#queue-count').click()
      assert.equal(await popover().count(), 0, 'outside click closes and removes the portal menu')
    }

    const first = cards.first()
    await first.locator('.queue-action-menu-toggle').click()
    let menu = popover()
    let bounds = await visibleBounds(menu)
    assert.equal(await menu.getAttribute('data-placement'), 'down', 'the first card prefers opening down')
    assertInsideViewport(bounds)
    await page.screenshot({ path: path.join(screenshots, 'menu-opens-down.png') })
    await closeByOutside()

    await first.locator('.queue-action-menu-toggle').focus()
    await page.keyboard.press('ArrowDown')
    assert.equal(await popover().count(), 1, 'ArrowDown opens the menu and focuses its first action')
    await page.keyboard.press('Escape')
    assert.equal(await popover().count(), 0, 'Escape closes and restores focus')

    const second = cards.nth(1)
    await first.locator('.queue-action-menu-toggle').click()
    await second.locator('.queue-action-menu-toggle').click()
    assert.equal(await popover().count(), 1, 'opening another card leaves only one portal menu')
    assert.equal(await popover().getAttribute('aria-label'), `Ações para ${await second.locator('.card-name').innerText()}`)
    await closeByOutside()

    await first.locator('.queue-action-menu-toggle').click()
    await popover().getByRole('menuitem', { name: 'Editar' }).click()
    assert.equal(await page.locator('#edit-modal').isVisible(), true, 'menu actions still open the existing edit modal')
    await page.locator('#btn-cancel-edit').click()
    assert.equal(await popover().count(), 0)

    const appMain = page.locator('.app-main')
    await first.locator('.queue-action-menu-toggle').click()
    await appMain.evaluate(element => element.scrollBy(0, 240))
    await page.waitForTimeout(50)
    if (await popover().count()) {
      const anchored = await visibleBounds(popover())
      assertInsideViewport(anchored)
      assert.ok(anchored.rect.y !== bounds.rect.y || anchored.rect.x !== bounds.rect.x,
        'scrolling the queue repositions the menu with its card')
    }

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(960, 700))
    await page.waitForFunction(() => !document.querySelector('.queue-action-menu-popover.is-open'))
    assert.equal(await popover().count(), 0, 'resize closes an open menu')
    const last = cards.last()
    const lastToggle = last.locator('.queue-action-menu-toggle')
    await appMain.evaluate(element => { element.scrollTop = element.scrollHeight })
    await lastToggle.click()
    menu = popover()
    assert.equal(await menu.getAttribute('data-placement'), 'up', 'the last card opens upward when below-space is short')
    bounds = await visibleBounds(menu)
    assertInsideViewport(bounds)
    await page.screenshot({ path: path.join(screenshots, 'menu-opens-up.png') })
    await closeByOutside()

    // Position the final card partly beyond the scrollport and activate its still-visible toggle
    // without Playwright auto-scrolling it fully into view.
    await appMain.evaluate(element => {
      const card = document.querySelector('#queue-list > .queue-card:last-child')
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - card.getBoundingClientRect().height / 2)
    })
    const partialVisibility = await last.evaluate(card => {
      const cardRect = card.getBoundingClientRect()
      const appRect = document.querySelector('.app-main').getBoundingClientRect()
      return { card: { top: cardRect.top, bottom: cardRect.bottom }, app: { top: appRect.top, bottom: appRect.bottom } }
    })
    assert.ok(partialVisibility.card.bottom > partialVisibility.app.bottom, 'last card is partly clipped by the scrollport')
    await lastToggle.evaluate(button => button.click())
    assert.equal(await popover().count(), 1)
    bounds = await visibleBounds(popover())
    assertInsideViewport(bounds)
    assert.ok(bounds.rect.bottom <= bounds.list.bottom + 0.5, 'portal menu remains inside the visible queue region')
    await closeByOutside()

    console.log(`PASS Electron queue menus: up/down placement, viewport bounds, partial card, 1280x800 and 960x700, outside/Escape, single menu, action, scroll and resize. Screenshots: ${screenshots}`)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
  }
}

run().catch(error => { console.error(error); process.exitCode = 1 })
