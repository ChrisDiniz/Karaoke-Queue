// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-sidebar-name-'))
const userDataDir = path.join(profileRoot, 'profile')
const screenshotDir = path.join(os.tmpdir(), `karaoke-sidebar-name-shots-${Date.now()}`)
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
  const getPage = async instance => {
    const page = await instance.firstWindow()
    page.on('pageerror', error => console.error('Renderer error:', error))
    page.on('console', message => { if (message.type() === 'error') console.error('Renderer console:', message.text()) })
    page.on('dialog', dialog => dialog.accept())
    await page.waitForFunction(() => !!window.__kqueue)
    await page.setViewportSize({ width: 1280, height: 800 })
    if (await page.locator('#startup-modal').isVisible()) await page.locator('#btn-startup-primary').click()
    return page
  }
  const stop = async () => {
    if (!app) return
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
    await app.close().catch(() => {})
    app = undefined
  }
  const prefsPath = () => path.join(userDataDir, 'ui-preferences.json')
  const openSettings = async page => {
    await page.locator('#nav-settings').click()
    await page.locator('#settings-page').waitFor({ state: 'visible' })
    await page.waitForFunction(() => (document.querySelector('#settings-sidebar-name') as HTMLInputElement)?.value.length > 0)
  }
  const saveName = async (page, value) => {
    await page.locator('#settings-sidebar-name').fill(value)
    await page.locator('#settings-sidebar-name-save').click()
    await page.waitForFunction(expected =>
      document.querySelector('#settings-sidebar-name-status')?.textContent === expected, 'Nome salvo.')
  }

  try {
    app = await launch()
    let page = await getPage(app)
    await openSettings(page)
    const input = page.locator('#settings-sidebar-name')
    const count = page.locator('#settings-sidebar-name-count')
    const brand = page.locator('.sidebar-brand-name')
    const sidebar = page.locator('#app-sidebar')

    assert.equal(await input.inputValue(), 'Karaoke Queue', 'legacy or absent preference uses the default')
    assert.equal(await count.innerText(), '13/17')
    assert.equal(await brand.getAttribute('title'), 'Karaoke Queue')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()),
      'Karaoke Queue', 'customization does not alter the native window title')

    await saveName(page, 'Bar do João')
    assert.equal(await count.innerText(), '11/17', 'counter measures visible accented characters')
    assert.equal(await brand.evaluate(element => element.textContent), 'Bar do João')
    assert.equal(await brand.getAttribute('title'), 'Bar do João')
    assert.equal(await brand.isVisible(), false, 'the name stays hidden while the sidebar is collapsed')
    assert.equal(await sidebar.evaluate(element => getComputedStyle(element).width), '58px',
      'customizing the label does not expand the collapsed sidebar')
    await page.locator('#btn-sidebar-toggle').click()
    assert.equal(await sidebar.evaluate(element => element.classList.contains('is-expanded')), true)
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#app-sidebar')!).width === '232px')
    assert.equal(await brand.isVisible(), true)
    const brandAndToggleBounds = await Promise.all([
      brand.boundingBox(), page.locator('#btn-sidebar-toggle').boundingBox()
    ])
    assert.ok(brandAndToggleBounds[0] && brandAndToggleBounds[1]
      && brandAndToggleBounds[0].x + brandAndToggleBounds[0].width <= brandAndToggleBounds[1].x,
    'the custom name does not overlap the collapse control')
    assert.equal(await sidebar.evaluate(element => getComputedStyle(element).width), '232px',
      'expanded sidebar width remains unchanged')
    await page.locator('#btn-sidebar-toggle').click()
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#app-sidebar')!).width === '58px')
    await page.locator('#nav-dashboard').click()
    await page.locator('#dashboard-page').waitFor({ state: 'visible' })
    await page.locator('#btn-sidebar-toggle').click()
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#app-sidebar')!).width === '232px')
    await page.screenshot({ path: path.join(screenshotDir, 'sidebar-nome-personalizado.png'), animations: 'disabled' })
    await page.locator('#btn-sidebar-toggle').click()
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#app-sidebar')!).width === '58px')
    await page.locator('#nav-settings').click()
    await page.locator('#settings-page').waitFor({ state: 'visible' })

    await input.fill('  Bar do João  ')
    await page.locator('#settings-sidebar-name-save').click()
    await page.waitForFunction(() => document.querySelector('#settings-sidebar-name')?.getAttribute('value') === null
      || (document.querySelector('#settings-sidebar-name') as HTMLInputElement).value === 'Bar do João')
    await page.waitForFunction(() => document.querySelector('#settings-sidebar-name-status')?.textContent === 'Nome salvo.')
    assert.equal(await input.inputValue(), 'Bar do João', 'outer spaces are removed before saving')
    assert.equal(await count.innerText(), '11/17')

    await input.fill('Jose\u0301 東京')
    assert.equal(await input.inputValue(), 'José 東京', 'decomposed accents are normalized without losing spelling')
    assert.equal(await count.innerText(), '7/17', 'Unicode letters count as visible characters')
    await page.locator('#settings-sidebar-name-save').click()
    await page.waitForFunction(() => document.querySelector('#settings-sidebar-name-status')?.textContent === 'Nome salvo.')
    assert.equal(await brand.innerText(), 'José 東京')

    await input.fill('漢'.repeat(25))
    assert.equal(await input.inputValue(), '漢'.repeat(17), 'wide Unicode input is limited to 17 graphemes')
    assert.equal(await count.innerText(), '17/17')
    await page.locator('#settings-sidebar-name-save').click()
    await page.waitForFunction(() => document.querySelector('#settings-sidebar-name-status')?.textContent === 'Nome salvo.')
    assert.equal(await brand.getAttribute('title'), '漢'.repeat(17), 'full text is available as a tooltip')
    await page.locator('#btn-sidebar-toggle').click()
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#app-sidebar')!).width === '232px')
    const truncation = await brand.evaluate(element => ({
      overflow: element.scrollWidth > element.clientWidth,
      ellipsis: getComputedStyle(element).textOverflow,
      sidebarWidth: getComputedStyle(element.closest('nav')).width
    }))
    assert.equal(truncation.overflow, true, 'long wide names are constrained to the label area')
    assert.equal(truncation.ellipsis, 'ellipsis')
    assert.equal(truncation.sidebarWidth, '232px')
    const longNameBounds = await Promise.all([brand.boundingBox(), page.locator('#btn-sidebar-toggle').boundingBox()])
    assert.ok(longNameBounds[0] && longNameBounds[1]
      && longNameBounds[0].x + longNameBounds[0].width <= longNameBounds[1].x,
    'a wide 17-character name still leaves room for the collapse control')
    await page.locator('#btn-sidebar-toggle').click()
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#app-sidebar')!).width === '58px')

    await input.fill('    ')
    await page.locator('#settings-sidebar-name-save').click()
    assert.equal(await page.locator('#settings-sidebar-name-status').innerText(), 'Digite um nome antes de salvar.')
    assert.equal(await brand.getAttribute('title'), '漢'.repeat(17), 'spaces only cannot replace the saved name')

    await input.fill('ABCDEFGHIJKLMNOPQRST')
    assert.equal(await input.inputValue(), 'ABCDEFGHIJKLMNOPQ')
    assert.equal(await count.innerText(), '17/17')

    await saveName(page, 'Bar do João')
    const persisted = JSON.parse(fs.readFileSync(prefsPath(), 'utf8'))
    assert.equal(persisted.sidebarDisplayName, 'Bar do João')
    assert.equal(persisted.scalePreference, 'auto', 'saving the name preserves the existing scale preference')

    await page.locator('#btn-theme-toggle').click()
    const lightScaleSelect = page.locator('#settings-scale-select')
    await lightScaleSelect.selectOption('100')
    assert.equal(await input.inputValue(), 'Bar do João')
    assert.equal(await brand.innerText(), 'Bar do João')
    await page.screenshot({ path: path.join(screenshotDir, 'sidebar-nome-personalizado-claro.png'), animations: 'disabled' })
    await lightScaleSelect.selectOption('150')
    assert.equal(await brand.getAttribute('title'), 'Bar do João', 'name remains available at 150% scale')
    await lightScaleSelect.selectOption('100')
    await page.locator('#btn-theme-toggle').click()

    await stop()
    app = await launch()
    page = await getPage(app)
    await page.waitForFunction(() => document.querySelector('.sidebar-brand-name')?.getAttribute('title') === 'Bar do João')
    assert.equal(await page.locator('.sidebar-brand-name').innerText(), 'Bar do João',
      'custom name is restored on the first app page after restart')
    await page.locator('#btn-sidebar-toggle').click()
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#app-sidebar')!).width === '232px')
    assert.equal(await page.locator('#app-sidebar').evaluate(element => getComputedStyle(element).width), '232px')
    await page.locator('#btn-sidebar-toggle').click()
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#app-sidebar')!).width === '58px')
    await openSettings(page)
    assert.equal(await page.locator('#settings-sidebar-name').inputValue(), 'Bar do João')
    await page.locator('#settings-sidebar-name-reset').click()
    await page.waitForFunction(() => document.querySelector('#settings-sidebar-name-status')?.textContent === 'Nome padrão restaurado.')
    assert.equal(await page.locator('#settings-sidebar-name').inputValue(), 'Karaoke Queue')
    assert.equal(await page.locator('#settings-sidebar-name-count').innerText(), '13/17')
    assert.equal(await page.locator('.sidebar-brand-name').getAttribute('title'), 'Karaoke Queue')
    const afterReset = JSON.parse(fs.readFileSync(prefsPath(), 'utf8'))
    assert.equal(afterReset.sidebarDisplayName, 'Karaoke Queue')
    console.log(`Screenshot: ${path.join(screenshotDir, 'sidebar-nome-personalizado.png')}`)
    console.log('PASS: sidebar name preferences, Unicode counter, validation, ellipsis, theme/scale and Electron restart')
  } finally {
    await stop()
    fs.rmSync(profileRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
