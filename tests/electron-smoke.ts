import { assertFrozenDragBlocked, dragQueuePreview, assertDragClean, settleQueue, observeDrag, saveDragDiagnostics } from './drag-diagnostics'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-queue-playwright-'))

async function run() {
  let app: import('playwright').ElectronApplication | undefined
  const userDataDir = path.join(profileRoot, 'profile')
  const evidenceDir = process.env.KQUEUE_SCREENSHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-smoke-evidence-'))
  fs.mkdirSync(evidenceDir, { recursive: true })
  let windowIndex = 0
  const traceNames = new Map<import('playwright').ElectronApplication, string>()
  const launch = async () => {
    const launched = await electron.launch({
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
    const label = `window-${++windowIndex}`
    traceNames.set(launched, label)
    await launched.context().tracing.start({ screenshots: true, snapshots: true })
    const opened: import('playwright').Page = await launched.firstWindow()
    opened.on('pageerror', error => fs.appendFileSync(path.join(evidenceDir, 'renderer-errors.log'), `${label}: ${error}\n`))
    opened.on('console', message => { if (message.type() === 'error') fs.appendFileSync(path.join(evidenceDir, 'console-errors.log'), `${label}: ${message.text()}\n`) })
    await opened.waitForFunction(() => !!window.__kqueue)
    await observeDrag(opened)
    return launched
  }
  const closeWithEvidence = async (instance: import('playwright').ElectronApplication) => {
    const opened = await instance.firstWindow()
    await saveDragDiagnostics(opened, evidenceDir, traceNames.get(instance)!)
    await instance.context().tracing.stop({ path: path.join(evidenceDir, `${traceNames.get(instance)}.zip`) })
    await instance.evaluate(({ app }: typeof import('electron')) => app.exit(0))
    await instance.close()
  }

  try {
    const electronApp = await launch()

    app = electronApp
    const page = await electronApp.firstWindow()
    await electronApp.evaluate(({ BrowserWindow }: typeof import('electron')) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800)
    })
    page.on('pageerror', (error: Error) => console.error('renderer error:', error))
    page.on('console', (message: import('playwright').ConsoleMessage) => {
      if (message.type() === 'error') console.error('renderer console:', message.text())
    })
    await page.waitForFunction(() => !!window.__kqueue, undefined, { timeout: 10000 })
    const confirmations: string[] = []
    page.on('dialog', (dialog: import('playwright').Dialog) => {
      confirmations.push(dialog.message())
      return dialog.accept()
    })
    await page.locator('#form-entry').waitFor({ state: 'visible' })

    const continueButton = page.locator('#btn-startup-primary')
    if (await continueButton.isVisible()) await continueButton.click()

    for (const [width, height, expectedScale] of [
      [1366, 768, 1], [1920, 1080, 1], [2560, 1440, 1.1], [3840, 2160, 1.2], [960, 600, 1]
    ]) {
      await electronApp.evaluate(({ BrowserWindow }: typeof import('electron'), size: number[]) => {
        BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1])
      }, [width, height])
      let actualScale = 0
      for (let attempt = 0; attempt < 20; attempt++) {
        actualScale = await electronApp.evaluate(({ BrowserWindow }: typeof import('electron')) =>
          BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
        if (actualScale === expectedScale) break
        await page.waitForTimeout(25)
      }
      assert.equal(actualScale, expectedScale, `automatic UI scale at ${width}x${height}`)
      await page.waitForFunction((expectedWidth: number) => Math.abs(innerWidth - expectedWidth) <= 2,
        width / expectedScale)
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }))
      assert.equal(viewport.horizontalOverflow, false, `no horizontal overflow at ${width}x${height}`)
      assert.ok(Math.abs(viewport.width - width / expectedScale) <= 2,
        `logical CSS viewport reflects ${expectedScale}x scale at ${width}x${height}`)
    }
    await electronApp.evaluate(({ BrowserWindow }: typeof import('electron')) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
    await page.waitForTimeout(100)

    const addSingerTo = async (target: import('playwright').Page, name: string, table: string, song: string, song2 = '') => {
      await target.locator('#input-name').fill(name)
      await target.locator('#input-song').fill(song)
      await target.locator('#input-song2').fill(song2)
      await target.locator('#input-table').fill(table)
      await target.locator('#form-entry button[type="submit"]').click()
      await target.evaluate(() => window.__kqueue?.flushState())
    }
    const addSinger = (name: string, table: string, song: string, song2 = '') => addSingerTo(page, name, table, song, song2)
    const selectTableFilter = async (target: import('playwright').Page, table: string | null) => {
      await target.locator('#btn-table-filter-select').click()
      const search = target.locator('#table-filter-search')
      if (table) await search.fill(table)
      await target.locator(`[data-table-option="${table ?? ''}"]`).click()
    }
    const singer = 'Playwright Smoke Test'
    const editedSinger = 'Playwright Editado'
    const screenshotDir = evidenceDir
    fs.mkdirSync(screenshotDir, { recursive: true })
    const capture = (name: string) => page.screenshot({
      path: path.join(screenshotDir, name), animations: 'disabled'
    })
    const sidebar = page.locator('#app-sidebar')
    const sidebarToggle = page.locator('#btn-sidebar-toggle')
    const queueNav = page.locator('#nav-dashboard')
    const queueSubmenu = page.locator('#sidebar-queue-submenu')
    const playbackNav = page.locator('#nav-playback')
    const playbackSubmenu = page.locator('#sidebar-playback-submenu')
    const historyNav = page.locator('#nav-history')
    const dashboardPreview = page.locator('#nav-dashboard-coming-soon')
    const assertToggleSitsOnSidebarEdge = async () => {
      const bounds = await page.evaluate(() => {
        const side = document.querySelector<HTMLElement>('#app-sidebar')!.getBoundingClientRect()
        const toggle = document.querySelector<HTMLElement>('#btn-sidebar-toggle')!.getBoundingClientRect()
        return { sideRight: side.right, toggleLeft: toggle.left, toggleRight: toggle.right, toggleWidth: toggle.width, center: toggle.left + toggle.width / 2 }
      })
      assert.ok(bounds.toggleWidth >= 46, `toggle should be large enough to hit: ${bounds.toggleWidth}px`)
      assert.ok(Math.abs(bounds.center - bounds.sideRight) <= 1, 'toggle center aligns with and straddles the sidebar edge')
      assert.ok(bounds.toggleLeft < bounds.sideRight && bounds.toggleRight > bounds.sideRight)
    }
    const assertThemeIconAligned = async () => {
      const centers = await page.evaluate(() => {
        const center = (selector: string) => {
          const rect = document.querySelector<SVGElement>(selector)!.getBoundingClientRect()
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        }
        return {
          queue: center('#nav-dashboard > svg:not(.sidebar-chevron)'),
          history: center('#nav-history > svg'),
          theme: center('#theme-toggle-icon > svg')
        }
      })
      assert.ok(Math.abs(centers.theme.x - centers.queue.x) < 0.5,
        `theme icon center ${centers.theme.x} matches Fila ${centers.queue.x}`)
      assert.ok(Math.abs(centers.theme.x - centers.history.x) < 0.5,
        `theme icon center ${centers.theme.x} matches Histórico ${centers.history.x}`)
      assert.ok(Math.abs(centers.theme.y - centers.queue.y) > 100,
        'footer theme icon remains in the footer row')
    }
    assert.equal(await sidebar.locator('.sidebar-brand-logo').count(), 1)
    assert.equal(await sidebar.locator('.sidebar-brand-logo').isVisible(), true, 'the karaoke logo remains visible in the compact sidebar')
    assert.equal(await queueNav.getAttribute('aria-label'), 'Fila')
    assert.equal(await queueNav.getAttribute('title'), 'Fila')
    assert.equal((await queueNav.locator('.sidebar-label').innerText()).trim(), 'Fila')
    assert.equal(await dashboardPreview.isDisabled(), true)
    assert.equal(await dashboardPreview.getAttribute('title'), 'Dashboard — Em breve')
    assert.equal(await dashboardPreview.locator('svg rect').count(), 4, 'Dashboard uses the layout-dashboard icon')
    assert.ok(await dashboardPreview.evaluate((element: HTMLElement) =>
      element.compareDocumentPosition(document.querySelector('#nav-dashboard')!) & Node.DOCUMENT_POSITION_FOLLOWING),
    'Dashboard placeholder precedes Fila')
    assert.ok(await queueNav.evaluate((element: HTMLElement) =>
      element.compareDocumentPosition(document.querySelector('#nav-playback')!) & Node.DOCUMENT_POSITION_FOLLOWING),
    'Reprodução follows Fila')
    assert.ok(await playbackNav.evaluate((element: HTMLElement) =>
      element.compareDocumentPosition(document.querySelector('#nav-history')!) & Node.DOCUMENT_POSITION_FOLLOWING),
    'Reprodução precedes Histórico')
    assert.equal(await playbackNav.getAttribute('title'), 'Reprodução — Em breve')
    assert.equal(await playbackNav.locator('svg:not(.sidebar-chevron) rect').count(), 1, 'Reprodução uses monitor-play')
    assert.equal(await page.locator('#sidebar-playback-submenu .sidebar-subitem').count(), 4)
    for (const id of ['nav-playback-now', 'nav-playback-library', 'nav-playback-youtube', 'nav-playback-settings']) {
      const option = page.locator(`#${id}`)
      assert.equal(await option.isDisabled(), true, `${id} remains unavailable`)
      assert.match(await option.innerText(), /Em breve/)
    }
    assert.equal(await page.locator('#nav-playback-now svg circle').count(), 1, 'Agora reproduzindo uses circle-play')
    assert.equal(await page.locator('#nav-playback-library svg path').count(), 2, 'Biblioteca local uses folder-open')
    assert.equal(await page.locator('#nav-playback-youtube svg path').count(), 2, 'YouTube icon is present')
    assert.equal(await page.locator('#nav-playback-settings svg line').count(), 6, 'Configurações de reprodução uses sliders-horizontal')
    assert.equal(await page.locator('#nav-playback-settings svg circle').count(), 3)
    assert.equal(await queueNav.locator('svg:not(.sidebar-chevron)').getAttribute('viewBox'), '0 0 24 24')
    assert.equal(await queueNav.locator('svg:not(.sidebar-chevron) path').count(), 2, 'Fila uses the ordered-list icon')
    assert.equal(await sidebar.evaluate((element: HTMLElement) => element.classList.contains('is-expanded')), false)
    assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await sidebarToggle.locator('.sidebar-toggle-icon--expand').isVisible(), true)
    assert.equal(await sidebarToggle.locator('.sidebar-toggle-icon--collapse').isVisible(), false)
    assert.match(await sidebarToggle.locator('.sidebar-toggle-icon--expand').getAttribute('src'), /sidebar-expand\.png$/)
    await assertToggleSitsOnSidebarEdge()
    await assertThemeIconAligned()
    if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.locator('#btn-theme-toggle').click()
    await assertThemeIconAligned()
    await capture('sidebar-recolhida-escuro.png')
    await sidebarToggle.click()
    await page.waitForFunction(() => document.querySelector('#app-sidebar')?.classList.contains('is-expanded'))
    assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'true')
    await sidebar.locator('.sidebar-brand-name').waitFor({ state: 'visible' })
    const sidebarName = await page.evaluate(() => window.karaokePreferences!.getSidebarDisplayName())
    assert.equal((await sidebar.locator('.sidebar-brand-name').innerText()).trim(), sidebarName)
    assert.equal(await sidebarToggle.locator('.sidebar-toggle-icon--expand').isVisible(), false)
    assert.equal(await sidebarToggle.locator('.sidebar-toggle-icon--collapse').isVisible(), true)
    assert.match(await sidebarToggle.locator('.sidebar-toggle-icon--collapse').getAttribute('src'), /sidebar-collapse\.png$/)
    await assertToggleSitsOnSidebarEdge()
    await assertThemeIconAligned()
    await page.locator('#btn-theme-toggle').click()
    await assertThemeIconAligned()
    await page.locator('#btn-theme-toggle').click()
    await capture('sidebar-expandida-escuro.png')
    await sidebarToggle.click()
    await page.waitForFunction(() => !document.querySelector('#app-sidebar')?.classList.contains('is-expanded'))

    const historySubmenu = page.locator('#sidebar-history-submenu')
    assert.equal(await page.locator('#nav-queue-requests svg rect').count(), 1, 'Solicitações uses the smartphone icon')
    assert.equal(await page.locator('#nav-queue-requests svg path').count(), 1)
    await dashboardPreview.hover()
    await dashboardPreview.click({ force: true }).catch(() => {})
    assert.equal(await queueSubmenu.isVisible(), false, 'disabled Dashboard does not open a flyout')
    await queueNav.hover()
    await queueSubmenu.waitFor({ state: 'visible' })
    await playbackNav.hover()
    await playbackSubmenu.waitFor({ state: 'visible' })
    assert.equal(await queueSubmenu.isVisible(), false, 'Reprodução replaces the Fila flyout')
    assert.equal(await historySubmenu.isVisible(), false, 'Reprodução is the only open flyout')
    await capture('reproducao-flyout-recolhido-escuro.png')
    await playbackNav.click()
    assert.equal(await playbackSubmenu.isVisible(), true, 'unimplemented module click does not navigate or hide its submenu')
    assert.equal(await page.locator('#dashboard-page').isVisible(), true, 'Reprodução does not navigate to a nonexistent page')
    await historyNav.hover()
    await historySubmenu.waitFor({ state: 'visible' })
    assert.equal(await playbackSubmenu.isVisible(), false, 'hovering Histórico closes Reprodução')
    await playbackNav.hover()
    await playbackSubmenu.waitFor({ state: 'visible' })
    assert.equal(await historySubmenu.isVisible(), false, 'hovering Reprodução closes Histórico')
    await page.locator('#nav-settings').hover()
    await playbackSubmenu.waitFor({ state: 'hidden' })
    await queueNav.hover()
    await queueSubmenu.waitFor({ state: 'visible' })
    assert.equal(await queueSubmenu.locator('.sidebar-flyout-heading').innerText(), 'Fila')
    assert.equal(await page.locator('#nav-queue-current').isEnabled(), true)
    assert.equal(await page.locator('#nav-queue-types').isDisabled(), true)
    assert.equal(await page.locator('#nav-queue-requests').isDisabled(), true)
    assert.equal(await historySubmenu.isVisible(), false)
    await capture('fila-flyout-recolhido-escuro.png')
    await historyNav.hover()
    await historySubmenu.waitFor({ state: 'visible' })
    assert.equal(await queueSubmenu.isVisible(), false, 'hovering Histórico closes the Fila flyout')
    await queueNav.hover()
    await queueSubmenu.waitFor({ state: 'visible' })
    assert.equal(await historySubmenu.isVisible(), false, 'hovering Fila closes the Histórico flyout')
    await historyNav.hover()
    await historySubmenu.waitFor({ state: 'visible' })
    assert.equal(await queueSubmenu.isVisible(), false, 'only one group panel remains visible')
    await page.locator('#nav-settings').hover()
    await historySubmenu.waitFor({ state: 'hidden' })
    assert.equal(await queueSubmenu.isVisible(), false, 'hovering a module without a submenu closes the active flyout')
    await queueNav.hover()
    await queueSubmenu.waitFor({ state: 'visible' })
    await historyNav.hover()
    await queueSubmenu.waitFor({ state: 'hidden' })
    await historySubmenu.waitFor({ state: 'visible' })
    await queueNav.hover()
    await historySubmenu.waitFor({ state: 'hidden' })
    await queueSubmenu.waitFor({ state: 'visible' })
    await page.locator('#nav-queue-current').hover()
    await page.waitForTimeout(220)
    assert.equal(await queueSubmenu.isVisible(), true, 'moving from Fila trigger into its flyout keeps it open')
    await page.keyboard.press('Escape')
    await queueSubmenu.waitFor({ state: 'hidden' })
    await queueNav.focus()
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'nav-queue-current',
      'Fila ArrowDown opens its submenu and focuses the first enabled option')
    await page.keyboard.press('Enter')
    await queueSubmenu.waitFor({ state: 'hidden' })
    await queueNav.hover()
    await queueSubmenu.waitFor({ state: 'visible' })
    await queueNav.click()
    await queueSubmenu.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('#dashboard-page').isVisible(), true, 'direct Fila click navigates even when its flyout is open')
    assert.equal(await historySubmenu.isVisible(), false, 'opening Fila never opens the History flyout')
    await historyNav.hover()
    await historySubmenu.waitFor({ state: 'visible' })
    assert.equal(await queueSubmenu.isVisible(), false)
    assert.equal(await historyNav.getAttribute('aria-expanded'), 'true')
    assert.equal(await historySubmenu.locator('.sidebar-flyout-heading').innerText(), 'Histórico')
    assert.equal(await page.locator('#nav-current-session').isVisible(), true)
    assert.equal(await page.locator('#nav-previous-sessions').isDisabled(), false)
    const flyoutBounds = await historySubmenu.evaluate((element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      const historyRect = document.querySelector('#nav-history')!.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        anchorRight: historyRect.right, viewportWidth: innerWidth, viewportHeight: innerHeight }
    })
    assert.ok(flyoutBounds.left >= flyoutBounds.anchorRight, 'flyout is positioned to the right of the collapsed sidebar item')
    assert.ok(flyoutBounds.right <= flyoutBounds.viewportWidth && flyoutBounds.bottom <= flyoutBounds.viewportHeight,
      'flyout is clamped to the window bounds')
    await capture('historico-flyout-recolhido-escuro.png')
    await page.locator('#nav-current-session').hover()
    await page.waitForTimeout(220)
    assert.equal(await historySubmenu.isVisible(), true, 'moving from the trigger into the flyout keeps it open')
    await sidebarToggle.click()
    await page.waitForFunction(() => document.querySelector('#app-sidebar')?.classList.contains('is-expanded'))
    assert.equal(await historySubmenu.isVisible(), false, 'expanding the sidebar closes the flyout')
    assert.equal(await queueSubmenu.isVisible(), false)
    await sidebarToggle.click()
    await page.waitForFunction(() => !document.querySelector('#app-sidebar')?.classList.contains('is-expanded'))
    await page.keyboard.press('Escape')
    await historySubmenu.waitFor({ state: 'hidden' })
    assert.equal(await historyNav.getAttribute('aria-expanded'), 'false')
    await historyNav.hover()
    await page.mouse.move(500, 500)
    await historySubmenu.waitFor({ state: 'hidden' })
    await historyNav.hover()
    await historySubmenu.waitFor({ state: 'visible' })
    await page.mouse.click(500, 500)
    await historySubmenu.waitFor({ state: 'hidden' })

    await historyNav.focus()
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'nav-current-session',
      'ArrowDown opens the flyout and focuses its first available option')
    await page.keyboard.press('Enter')
    await page.locator('#history-panel').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#nav-current-session').getAttribute('aria-current'), 'page')
    assert.equal(await historySubmenu.isVisible(), false, 'selecting a flyout option closes it')
    await historyNav.hover()
    await historySubmenu.waitFor({ state: 'visible' })
    await historyNav.click()
    await page.locator('#history-panel').waitFor({ state: 'visible' })
    assert.equal(await historySubmenu.isVisible(), false, 'direct History click navigates even when its flyout is open')
    await queueNav.click()
    await page.locator('#dashboard-page').waitFor({ state: 'visible' })

    await sidebarToggle.click()
    await page.waitForFunction(() => document.querySelector('#app-sidebar')?.classList.contains('is-expanded'))
    await historyNav.hover()
    assert.equal(await historySubmenu.isVisible(), false, 'hover does not open a flyout while expanded')
    await historyNav.locator('.sidebar-label').click()
    assert.equal(await historySubmenu.isVisible(), true, 'expanded sidebar keeps the inline history submenu')
    assert.equal(await historySubmenu.evaluate((element: HTMLElement) => getComputedStyle(element).position), 'static')
    await page.locator('#nav-current-session').click()
    await page.locator('#history-panel').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#app-sidebar').evaluate((element: HTMLElement) => element.classList.contains('is-expanded')), false)
    await queueNav.click()

    await sidebarToggle.click()
    await page.waitForFunction(() => document.querySelector('#app-sidebar')?.classList.contains('is-expanded'))
    await queueNav.locator('.sidebar-label').click()
    assert.equal(await queueSubmenu.isVisible(), true, 'expanded Fila label toggles its submenu')
    assert.equal(await page.locator('#nav-queue-current').getAttribute('aria-current'), 'page')
    await queueNav.locator('svg:not(.sidebar-chevron)').click()
    assert.equal(await queueSubmenu.isVisible(), false, 'Fila icon navigates and closes its inline submenu')
    assert.equal(await page.locator('#app-sidebar').evaluate((element: HTMLElement) => element.classList.contains('is-expanded')), false,
      'navigating from the Fila icon returns to the compact sidebar')

    await sidebarToggle.click()
    await page.waitForFunction(() => document.querySelector('#app-sidebar')?.classList.contains('is-expanded'))
    await playbackNav.locator('.sidebar-label').click()
    assert.equal(await playbackSubmenu.isVisible(), true, 'Reprodução expands inline when its name is clicked')
    assert.equal(await playbackSubmenu.evaluate((element: HTMLElement) => getComputedStyle(element).position), 'static')
    const expandedPlaybackLabelBounds = await page.evaluate(() => {
      const sidebarRect = document.querySelector('#app-sidebar')!.getBoundingClientRect()
      const labelRect = document.querySelector('#nav-playback-settings .sidebar-label')!.getBoundingClientRect()
      const badgeRect = document.querySelector('#nav-playback-settings .sidebar-label small')!.getBoundingClientRect()
      return { sidebarRight: sidebarRect.right, labelRight: labelRect.right, badgeRight: badgeRect.right }
    })
    assert.ok(expandedPlaybackLabelBounds.labelRight <= expandedPlaybackLabelBounds.sidebarRight
      && expandedPlaybackLabelBounds.badgeRight <= expandedPlaybackLabelBounds.sidebarRight,
    'long playback label and badge stay inside the expanded sidebar')
    await capture('sidebar-expandida-reproducao.png')
    await playbackNav.locator('svg:not(.sidebar-chevron)').click()
    assert.equal(await playbackSubmenu.isVisible(), true, 'Reprodução icon does not navigate or collapse its group')
    assert.equal(await page.locator('#dashboard-page').isVisible(), true)
    await playbackNav.locator('.sidebar-label').click()
    assert.equal(await playbackSubmenu.isVisible(), false, 'Reprodução label collapses its inline submenu')
    await sidebarToggle.click()
    await page.waitForFunction(() => !document.querySelector('#app-sidebar')?.classList.contains('is-expanded'))

    const setElectronContentSize = (width: number, height: number) => electronApp.evaluate(
      ({ BrowserWindow }: typeof import('electron'), size: number[]) =>
        BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height])
    const verifyFlyoutAtScale = async (preference: string, expected: number) => {
      await page.locator('#nav-settings').click()
      const scaleControl = page.locator('#settings-scale-select')
      await scaleControl.selectOption(preference)
      await page.waitForFunction((factor: number) =>
        Math.abs(Number(document.querySelector('#settings-scale-effective')?.textContent?.replace('%', '')) - factor * 100) < 0.01,
      expected)
      await page.waitForFunction(() => !(document.querySelector('#settings-scale-select') as HTMLSelectElement).disabled)
      await queueNav.click()
      await page.mouse.move(500, 500)
      await queueNav.hover()
      await queueSubmenu.waitFor({ state: 'visible' })
      const queueBounds = await queueSubmenu.evaluate((element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        return { right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight }
      })
      assert.ok(queueBounds.right <= queueBounds.width && queueBounds.bottom <= queueBounds.height,
        `Fila flyout fits at ${preference} scale`)
      await page.keyboard.press('Escape')
      await playbackNav.hover()
      await playbackSubmenu.waitFor({ state: 'visible' })
      const playbackBounds = await playbackSubmenu.evaluate((element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width,
          viewportWidth: innerWidth, viewportHeight: innerHeight }
      })
      assert.ok(playbackBounds.width >= 250 && playbackBounds.right <= playbackBounds.viewportWidth
        && playbackBounds.bottom <= playbackBounds.viewportHeight,
      `Playback flyout and long labels fit at ${preference} scale`)
      assert.equal(await playbackSubmenu.evaluate((element: HTMLElement) =>
        element.scrollWidth <= element.clientWidth + 1), true, 'long playback labels do not overflow horizontally')
      await capture(`reproducao-flyout-${preference}.png`)
      await page.keyboard.press('Escape')
      await historyNav.hover()
      await historySubmenu.waitFor({ state: 'visible' })
      assert.equal(await queueSubmenu.isVisible(), false, `only History is open at ${preference} scale`)
      const bounds = await historySubmenu.evaluate((element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          width: rect.width, viewportWidth: innerWidth, viewportHeight: innerHeight }
      })
      assert.ok(bounds.width > 150 && bounds.right <= bounds.viewportWidth && bounds.top >= 0
        && bounds.bottom <= bounds.viewportHeight, `flyout fits at ${preference} scale`)
      await page.keyboard.press('Escape')
    }
    await verifyFlyoutAtScale('auto', 1)
    await verifyFlyoutAtScale('100', 1)
    await verifyFlyoutAtScale('110', 1.1)
    await verifyFlyoutAtScale('125', 1.25)
    await verifyFlyoutAtScale('150', 1.5)
    await setElectronContentSize(960, 600)
    await page.waitForFunction(() => Math.abs(innerWidth - 640) < 2)
    await page.mouse.move(500, 500)
    await page.locator('#nav-history').hover()
    await historySubmenu.waitFor({ state: 'visible' })
    const minimumWindowFlyout = await historySubmenu.evaluate((element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      return { right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight }
    })
    assert.ok(minimumWindowFlyout.right <= minimumWindowFlyout.width
      && minimumWindowFlyout.bottom <= minimumWindowFlyout.height, '150% flyout stays in the 960x600 window')
    await capture('historico-flyout-150-960x600.png')
    await page.keyboard.press('Escape')
    await setElectronContentSize(1280, 800)
    await page.locator('#nav-settings').click()
    await page.locator('#settings-scale-select').selectOption('auto')
    await page.waitForFunction(() => Number(document.querySelector('#settings-scale-effective')?.textContent?.replace('%', '')) === 100)
    await queueNav.click()

    if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.locator('#btn-theme-toggle').click()
    await assertThemeIconAligned()
    await historyNav.hover()
    await historySubmenu.waitFor({ state: 'visible' })
    await capture('historico-flyout-recolhido-claro.png')
    await page.keyboard.press('Escape')
    await playbackNav.hover()
    await playbackSubmenu.waitFor({ state: 'visible' })
    await capture('reproducao-flyout-recolhido-claro.png')
    await page.keyboard.press('Escape')
    const dragWithPreview = async (
      source: import('playwright').Locator,
      target: import('playwright').Locator,
      edge: 'top' | 'bottom',
      screenshot: string,
      drop = true
    ): Promise<string[]> => {
      return dragQueuePreview(page, source, target, edge, path.join(screenshotDir, screenshot), drop)
    }
    if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.locator('#btn-theme-toggle').click()

    await addSinger(singer, '1', '1234', '5678')
    await page.locator('.now-name').getByText(singer, { exact: true }).waitFor()
    assert.match(await page.locator('#toast').innerText(), /adicionado/)
    await addSinger('Mesa 2', '2', '2345')
    await addSinger('Mesa 3', '3', '3456')
    await addSinger('Mesa 4', '4', '4567')
    await addSinger('Prioridade manual', '5', '5678')
    await page.locator('#toast').waitFor({ state: 'hidden' })

    const layoutProbeCard = page.locator('#queue-list .queue-card').first()
    const cardLayout = await layoutProbeCard.evaluate((card: HTMLElement) => {
      const bounds = (selector: string) => {
        const rect = card.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
        return { x: rect.x, y: rect.y, height: rect.height }
      }
      return {
        card: bounds('.queue-card-left'),
        singer: bounds('.card-name'),
        firstSong: bounds('.card-song-number'),
        wait: bounds('.card-wait'),
        inserted: bounds('.card-inserted'),
        roundsOrDebut: card.querySelector('.debut-badge, .rounds-label')?.textContent?.trim() ?? ''
      }
    })
    assert.ok(cardLayout.firstSong.y > cardLayout.singer.y,
      'song codes render below the singer in the second compact card line')
    assert.ok(cardLayout.inserted.y > cardLayout.wait.y,
      'the original request time is stacked under the wait duration')
    assert.match(cardLayout.roundsOrDebut, /Estreia/,
      'the first eligible pending entry from a never-sung table gets the debut indicator')
    assert.equal(await page.locator('#now-block .card-song-number').count(), 2,
      'the current turn preserves both song numbers in their original order')
    assert.ok(cardLayout.card.height <= 80, `queue cards remain compact (${cardLayout.card.height}px)`)
    await capture('cards-fila-refinados-claro.png')
    await page.locator('#btn-theme-toggle').click()
    await capture('cards-fila-refinados-escuro.png')
    await page.locator('#btn-theme-toggle').click()

    const debutCard = page.locator('#queue-list .queue-card').filter({ hasText: 'Mesa 2' })
    await debutCard.locator('.queue-action-menu-toggle').click()
    await page.getByRole('menuitem', { name: 'Por que esta posição?' }).click()
    await page.locator('#queue-reason-modal').waitFor({ state: 'visible' })
    assert.match(await page.locator('#queue-reason-position').innerText(), /Estreia/)
    assert.match(await page.locator('#queue-reason-description').innerText(), /dois turnos regulares/)
    await capture('explicacao-posicao-estreia.png')
    await page.keyboard.press('Escape')
    await page.locator('#queue-reason-modal').waitFor({ state: 'hidden' })

    for (const [width, height, expectedScale] of [[2560, 1440, 1.1], [3840, 2160, 1.2]]) {
      await electronApp.evaluate(({ BrowserWindow }: typeof import('electron'), size: number[]) =>
        BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height])
      for (let attempt = 0; attempt < 20; attempt++) {
        const scale = await electronApp.evaluate(({ BrowserWindow }: typeof import('electron')) =>
          BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
        if (scale === expectedScale) break
        await page.waitForTimeout(25)
      }
      await page.waitForFunction((expectedWidth: number) => Math.abs(innerWidth - expectedWidth) <= 2,
        width / expectedScale)

      const originalTheme = await page.locator('html').getAttribute('data-theme')
      if (expectedScale === 1.2 && originalTheme !== 'dark') await page.locator('#btn-theme-toggle').click()
      if (expectedScale === 1.2) assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')

      await sidebarToggle.click()
      await page.waitForFunction(() => document.querySelector('#app-sidebar')?.classList.contains('is-expanded'))
      assert.match(await dashboardPreview.locator('.sidebar-label').innerText(), /Dashboard.*Em breve/s)
      assert.equal((await queueNav.locator('.sidebar-label').innerText()).trim(), 'Fila')
      await sidebarToggle.click()
      await page.waitForFunction(() => !document.querySelector('#app-sidebar')?.classList.contains('is-expanded'))

      const actionMenu = page.locator('#queue-list .queue-card .queue-action-menu').first()
      await actionMenu.locator('.queue-action-menu-toggle').click()
      const actionPopover = page.locator('.queue-action-menu-popover.is-open')
      assert.equal(await actionPopover.isVisible(), true, `queue actions open at scale ${expectedScale}`)
      const popoverBounds = await actionPopover.boundingBox()
      const visibleViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      assert.ok(popoverBounds && popoverBounds.x >= 0 && popoverBounds.y >= 0 &&
        popoverBounds.x + popoverBounds.width <= visibleViewport.width + 1 &&
        popoverBounds.y + popoverBounds.height <= visibleViewport.height + 1,
      `queue action menu remains inside viewport at scale ${expectedScale}`)
      await page.locator('#form-entry').click({ position: { x: 10, y: 10 } })

      await page.locator('#queue-list .card-table-clickable').first().click()
      const tableModal = page.locator('#table-modal')
      await tableModal.waitFor({ state: 'visible' })
      const modalBounds = await page.locator('#table-modal .modal-box--table').boundingBox()
      assert.ok(modalBounds && modalBounds.x >= 0 && modalBounds.y >= 0 &&
        modalBounds.x + modalBounds.width <= visibleViewport.width + 1 &&
        modalBounds.y + modalBounds.height <= visibleViewport.height + 1,
      `table modal remains inside viewport at scale ${expectedScale}`)
      await page.locator('#btn-close-table-modal').click()

      if (expectedScale === 1.2 && originalTheme !== 'dark') await page.locator('#btn-theme-toggle').click()

      if (expectedScale === 1.1) {
        const orderBeforeScaledDrag = await page.locator('#queue-list .card-name').allTextContents()
        const dragPreview = await dragWithPreview(page.locator('#queue-list .queue-card').last(),
          page.locator('#queue-list .queue-card').first(), 'top', 'drag-preview-qhd.png', false)
        assert.equal(dragPreview.filter(value => value === '<inserção>').length, 1)
        await page.keyboard.press('Escape')
        await page.mouse.up()
        assert.deepEqual(await page.locator('#queue-list .card-name').allTextContents(), orderBeforeScaledDrag,
          'canceling a scaled drag preview preserves the queue')
      }
    }
    await electronApp.evaluate(({ BrowserWindow }: typeof import('electron')) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
    await page.waitForTimeout(100)

    assert.equal(await page.locator('#app-name').count(), 0, 'the editable centered app title is removed from the header')
    assert.equal(await page.locator('#clock').count(), 0, 'clock is removed from the compact header')
    assert.equal(await page.locator('#btn-notifications').isVisible(), true, 'notifications remain aligned in the header')
    assert.equal(await page.locator('#btn-notifications').isEnabled(), true, 'notification placeholder remains clickable')
    const firstCardMenu = page.locator('#queue-list .queue-card .queue-action-menu').first()
    const firstCardMenuToggle = firstCardMenu.locator('.queue-action-menu-toggle')
    await firstCardMenuToggle.focus()
    await firstCardMenuToggle.press('ArrowDown')
    assert.equal(await page.locator('.queue-action-menu-popover.is-open').isVisible(), true, 'keyboard opens the queue action menu')
    await page.keyboard.press('Escape')
    assert.equal(await firstCardMenuToggle.getAttribute('aria-expanded'), 'false', 'Escape closes the queue action menu')
    await firstCardMenuToggle.click()
    assert.equal(await page.locator('.queue-action-menu-popover.is-open').getByRole('menuitem', { name: 'Editar' }).isVisible(), true)
    await capture('acoes-menu-fila-claro.png')
    await page.locator('#form-entry').click({ position: { x: 10, y: 10 } })
    assert.equal(await firstCardMenu.getByRole('menuitem', { name: 'Editar' }).isVisible(), false, 'outside click closes the queue action menu')
    await page.locator('#now-block .queue-action-menu-toggle').click()
    assert.equal(await page.locator('#now-block .btn-done-lg').isVisible(), true, 'Cantou remains the visible primary action')
    assert.equal(await page.locator('.queue-action-menu-popover.is-open').getByRole('menuitem', { name: 'Cancelar' }).isVisible(), true)
    await page.locator('#now-block .queue-action-menu-toggle').click()
    await page.locator('#btn-theme-toggle').click()
    await page.locator('#now-block .queue-action-menu-toggle').click()
    await capture('acoes-menu-vez-atual-escuro.png')
    await page.locator('#now-block .queue-action-menu-toggle').click()
    await page.locator('#btn-theme-toggle').click()

    const priority = page.locator('#queue-list .queue-card').filter({ hasText: 'Prioridade manual' })
    const firstQueueCard = page.locator('#queue-list .queue-card').first()
    const orderBeforeCancelledMove = await page.locator('#queue-list .card-name').allTextContents()
    const upPreview = await dragWithPreview(priority, firstQueueCard, 'bottom', 'drag-preview-subindo.png')
    assert.equal(upPreview[1], '<inserção>', 'the live placeholder must open the exact second slot')
    assert.equal(upPreview.filter(value => value === '<inserção>').length, 1)
    await page.locator('#manual-move-modal').waitFor({ state: 'visible' })
    assert.match(await page.locator('#manual-move-modal').innerText(), /fixada na posição escolhida.*rodízio automático.*avançará/s)
    await capture('manual-pin-confirmacao.png')
    await page.locator('#btn-cancel-manual-move').click()
    await assertDragClean(page)
    assert.deepEqual(await page.locator('#queue-list .card-name').allTextContents(), orderBeforeCancelledMove,
      'canceling the explanation leaves queue order untouched')
    const downSource = page.locator('#queue-list .queue-card').first()
    const downTarget = page.locator('#queue-list .queue-card').last()
    const downPreview = await dragWithPreview(downSource, downTarget, 'bottom', 'drag-preview-descendo.png', false)
    assert.equal(downPreview[downPreview.length - 1], '<inserção>', 'the live placeholder must open the final slot')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await assertDragClean(page)
    assert.deepEqual(await page.locator('#queue-list .card-name').allTextContents(), orderBeforeCancelledMove,
      'Escape during a drag restores the exact original order')
    const commitPreview = await dragWithPreview(priority, firstQueueCard, 'top', 'drag-preview-confirmado.png')
    await page.locator('#manual-move-modal').waitFor({ state: 'visible' })
    await page.locator('#manual-move-dismiss').check()
    await page.locator('#btn-confirm-manual-move').click()
    await settleQueue(page)
    const expectedCommittedOrder = [...commitPreview]
    expectedCommittedOrder[expectedCommittedOrder.indexOf('<inserção>')] = 'Prioridade manual'
    assert.deepEqual(await page.locator('#queue-list .card-name').allTextContents(), expectedCommittedOrder,
      'confirmed queue order must exactly match the insertion preview')
    const firstRecommended = page.locator('#queue-list .queue-card').first()
    await firstRecommended.locator('.card-name').getByText('Prioridade manual', { exact: true }).waitFor()
    const noOpOrder = await page.locator('#queue-list .card-name').allTextContents()
    await dragWithPreview(firstRecommended, firstRecommended, 'top', 'drag-preview-no-op.png')
    assert.deepEqual(await page.locator('#queue-list .card-name').allTextContents(), noOpOrder)
    assert.equal(await page.locator('#manual-move-modal').isVisible(), false, 'a no-op drag must not ask for confirmation')
    const mesa4Waiting = page.locator('#queue-list .queue-card').filter({ hasText: 'Mesa 4' })
    await dragQueuePreview(page, mesa4Waiting, firstRecommended, 'top')
    await settleQueue(page)
    await page.locator('#queue-list .queue-card').first().locator('.card-name').getByText('Mesa 4', { exact: true }).waitFor()
    await dragQueuePreview(page, page.locator('#queue-list .queue-card').filter({ hasText: 'Prioridade manual' }),
      page.locator('#queue-list .queue-card').filter({ hasText: 'Mesa 4' }), 'top')
    await settleQueue(page)
    assert.deepEqual(await page.locator('#queue-list .card-name').allTextContents().then((names: string[]) => names.slice(0, 3)),
      ['Prioridade manual', 'Mesa 4', 'Mesa 2'])
    assert.equal(await page.locator('#queue-list .queue-card.is-fixed').count(), 2)
    assert.equal(await page.locator('#queue-list .queue-card').nth(0).getAttribute('data-position'), '1')
    assert.equal(await page.locator('#queue-list .queue-card').nth(1).getAttribute('data-position'), '2')
    assert.match(await page.locator('#toast').innerText(), /fixado\(a\) na posição/)
    await page.locator('#toast').waitFor({ state: 'hidden' })
    await capture('fila-com-fixacoes.png')
    const theme = await page.locator('html').getAttribute('data-theme')
    if (theme !== 'light') await page.locator('#btn-theme-toggle').click()
    await page.locator('#nav-history').hover()
    await page.locator('#sidebar-history-submenu:not([hidden])').waitFor()
    assert.equal(await page.locator('#nav-previous-sessions').isDisabled(), false)
    assert.doesNotMatch(await page.locator('#nav-previous-sessions').innerText(), /Em breve/)
    await page.locator('#nav-previous-sessions').click()
    await page.locator('#previous-sessions-page').waitFor({ state: 'visible' })
    assert.match(await page.locator('#previous-sessions-list').innerText(), /Nenhuma sessão anterior encontrada/)
    await page.locator('#nav-history').click()
    await page.locator('#history-panel').waitFor({ state: 'visible' })
    const currentBeforeNavigation = await page.locator('.now-name').first().innerText()
    await page.locator('#nav-dashboard').click()
    await page.locator('#dashboard-page').waitFor({ state: 'visible' })
    assert.equal(await page.locator('.now-name').first().innerText(), currentBeforeNavigation)
    const userDataPath = await electronApp.evaluate(({ app: electronMain }: typeof import('electron')) => electronMain.getPath('userData'))
    assert.ok(path.resolve(userDataPath).startsWith(path.resolve(profileRoot)), `userData must be isolated: ${userDataPath}`)
    await page.evaluate(() => window.__kqueue?.flushState())
    const priorityDb = new DatabaseSync(path.join(userDataPath, 'karaoke.sqlite'), { readOnly: true })
    try {
      const fixedEntries = Object.fromEntries(['Prioridade manual', 'Mesa 4'].map(name => {
        const id = priorityDb.prepare('SELECT id FROM entries WHERE name = ? AND status = ?').get(name, 'pending').id
        const fixed = priorityDb.prepare('SELECT fixed_turn_positions_json FROM app_state WHERE singleton = 1').get()
        return [name, JSON.parse(fixed.fixed_turn_positions_json)[id]]
      }))
      assert.deepEqual(fixedEntries, { 'Prioridade manual': 1, 'Mesa 4': 2 })
      assert.deepEqual(JSON.parse(priorityDb.prepare('SELECT priority_ids_json FROM app_state WHERE singleton = 1').get().priority_ids_json), [])
    } finally {
      priorityDb.close()
    }

    await page.locator('#now-block .queue-action-menu-toggle').click()
    await page.getByRole('menuitem', { name: 'Editar' }).click()
    await page.locator('#edit-name').fill(editedSinger)
    await page.locator('#btn-save-edit').click()
    await page.locator('.now-name').getByText(editedSinger, { exact: true }).waitFor()

    // Dragging a waiting singer onto the current slot requires confirmation;
    // the previous current turn becomes the forced next turn.
    await page.locator('.queue-card').filter({ hasText: 'Mesa 3' }).dragTo(page.locator('#now-block .now-card'))
    await page.locator('.now-name').getByText('Mesa 3', { exact: true }).waitFor()
    await page.locator('#now-block .btn-done-lg').click()
    await page.locator('.now-name').getByText(editedSinger, { exact: true }).waitFor()
    await page.locator('#now-block .btn-done-lg').click()
    await page.locator('.now-name').getByText('Prioridade manual', { exact: true }).waitFor()
    await page.locator('#now-block .queue-action-menu-toggle').click()
    await page.getByRole('menuitem', { name: 'Cancelar' }).click()
    await page.locator('.now-name').getByText('Mesa 4', { exact: true }).waitFor()

    await page.locator('#nav-history').click()
    const historyPanel = page.locator('#history-panel')
    await historyPanel.locator('.history-name').getByText(editedSinger, { exact: true }).waitFor()
    assert.equal(await page.locator('#history-stat-songs').innerText(), '3')
    assert.equal(await page.locator('#history-stat-singers').innerText(), '2')
    assert.equal(await page.locator('#history-stat-tables').innerText(), '2')
    await capture('01-sessao-atual-claro.png')
    const editedCard = historyPanel.locator('.history-card').filter({ hasText: editedSinger })
    assert.equal(await editedCard.locator('.history-song').count(), 0, 'song codes must not render in history cards')
    await editedCard.locator('.history-badge-clickable').getByText('Mesa 1', { exact: true }).waitFor()
    await editedCard.locator('.history-times').getByText('Cantou').waitFor()
    await editedCard.locator('.history-count').getByText(/2 músicas/).waitFor()
    await editedCard.locator('.history-view-table').getByText('Ver mesa').waitFor()

    const tableFilterButton = page.locator('#btn-table-filter-select')
    const openFilterFromCaret = async () => {
      const buttonWidth = await tableFilterButton.evaluate((element: HTMLElement) => element.getBoundingClientRect().width)
      await tableFilterButton.click({ position: { x: buttonWidth - 8, y: 16 } })
      await page.locator('#table-filter-popover:not(.hidden)').waitFor()
    }
    await openFilterFromCaret()
    await page.keyboard.press('Escape')
    await page.locator('#table-filter-popover').waitFor({ state: 'hidden' })
    await tableFilterButton.click({ position: { x: 20, y: 16 } })
    await page.locator('#table-filter-popover:not(.hidden)').waitFor()
    await page.locator('.session-page-header').click()
    await page.locator('#table-filter-popover').waitFor({ state: 'hidden' })
    await tableFilterButton.focus()
    await page.keyboard.press('Space')
    await page.locator('#table-filter-popover:not(.hidden)').waitFor()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Enter')
    await page.locator('#table-filter-popover:not(.hidden)').waitFor()
    await page.locator('#table-filter-search').fill('5')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await page.locator('#table-filter-popover').waitFor({ state: 'hidden' })
    assert.match(await tableFilterButton.innerText(), /Mesa 5/)
    await historyPanel.locator('.history-name').getByText('Prioridade manual', { exact: true }).waitFor()
    await selectTableFilter(page, null)

    await page.locator('#history-search').fill('Playwright Editado')
    await historyPanel.locator('.history-name').getByText(editedSinger, { exact: true }).waitFor()
    await page.locator('#history-search').fill('')
    await page.locator('#btn-sort-history').click()
    assert.match(await page.locator('#btn-sort-history').innerText(), /Antigas/)
    await page.locator('#btn-sort-history').click()
    await selectTableFilter(page, '5')
    await historyPanel.locator('.history-name').getByText('Prioridade manual', { exact: true }).waitFor()
    await selectTableFilter(page, null)
    await selectTableFilter(page, '1')
    await historyPanel.locator('.history-card').filter({ hasText: editedSinger })
      .locator('.history-view-table').click()
    await page.locator('#table-modal-title').getByText('Mesa 1', { exact: true }).waitFor()
    await page.locator('#table-modal').getByText('Músicas cantadas').waitFor()
    await page.locator('#table-modal').getByText('Cantadas (2)').waitFor()
    await page.locator('#table-modal').getByText('Na fila (0)').waitFor()
    assert.equal(await page.locator('#table-modal .tmodal-position-info').count(), 0)
    assert.equal(await page.locator('#table-modal .tmodal-position-help').count(), 0)
    await page.locator('#table-modal').locator('.tmodal-song-item').getByText('1234', { exact: false }).waitFor()
    await page.locator('#table-modal').locator('.tmodal-song-item').getByText('5678', { exact: false }).waitFor()
    await capture('02-detalhes-mesa-claro.png')
    await page.keyboard.press('Escape')
    await page.locator('#table-modal').waitFor({ state: 'hidden' })
    assert.match(await page.locator('#btn-table-filter-select').innerText(), /Mesa 1/)
    await page.locator('#btn-theme-toggle').click()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    await capture('03-sessao-atual-escuro.png')
    await historyPanel.locator('.history-card').filter({ hasText: editedSinger })
      .locator('.history-badge-clickable').click()
    await page.locator('#table-modal').waitFor({ state: 'visible' })
    await capture('04-detalhes-mesa-escuro.png')
    await page.locator('#table-modal').click({ position: { x: 8, y: 8 } })
    await page.locator('#table-modal').waitFor({ state: 'hidden' })
    // Reopen once to exercise the explicit close action.
    await historyPanel.locator('.history-card').filter({ hasText: editedSinger })
      .locator('.history-badge-clickable').click()
    await page.locator('#btn-close-table-modal').click()
    await historyPanel.locator('.history-card').filter({ hasText: editedSinger })
      .locator('.history-badge-clickable').click()
    await page.evaluate(() => window.__kqueue?.flushState())
    const preResetDb = new DatabaseSync(path.join(userDataPath, 'karaoke.sqlite'), { readOnly: true })
    try {
      assert.equal(preResetDb.prepare('SELECT status FROM entries WHERE name = ?').get(editedSinger).status, 'done')
    } finally {
      preResetDb.close()
    }
    await page.locator('#btn-reset-table').click()
    await historyPanel.locator('.history-name').getByText(editedSinger, { exact: true }).waitFor({ state: 'hidden' })
    assert.equal(confirmations.length, 3)
    assert.ok(confirmations.some(message => message.includes('cantar AGORA')))
    assert.ok(confirmations.some(message => message.includes('Cancelar')))
    assert.ok(confirmations.some(message => message.includes('Resetar Mesa')))
    await page.locator('#nav-dashboard').click()
    assert.equal(await historyPanel.evaluate((element: HTMLElement) => element.classList.contains('hidden')), true)

    await closeWithEvidence(electronApp)
    app = undefined

    const databasePath = path.join(userDataPath, 'karaoke.sqlite')
    assert.ok(fs.existsSync(databasePath), 'Electron must create its SQLite database in the isolated profile')
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const entries = database.prepare('SELECT id, name, status, queue_order FROM entries ORDER BY status, queue_order').all()
      assert.equal(entries.find((entry: any) => entry.name === editedSinger), undefined)
      assert.ok(entries.some((entry: any) => entry.name === 'Mesa 3' && entry.status === 'done'))
      assert.ok(entries.some((entry: any) => entry.name === 'Prioridade manual' && entry.status === 'cancelled'))
      assert.equal(entries.filter((entry: any) => entry.status === 'pending').length, 2)
      assert.deepEqual(entries.filter((entry: any) => entry.status === 'pending')
        .sort((a: any, b: any) => a.queue_order - b.queue_order).map((entry: any) => entry.name), ['Mesa 2', 'Mesa 4'])
      const appState = database.prepare('SELECT priority_ids_json, fixed_turn_positions_json, current_turn_id, next_turn_id FROM app_state WHERE singleton = 1').get()
      assert.ok(appState)
      const mesa4Id = entries.find((entry: any) => entry.name === 'Mesa 4').id
      assert.deepEqual(JSON.parse(appState.priority_ids_json), [])
      assert.equal(JSON.parse(appState.fixed_turn_positions_json)[mesa4Id], 0,
        'the fixed turn remains recorded while selected as current')
      assert.equal(appState.current_turn_id, mesa4Id)
      assert.equal(appState.next_turn_id, null)
      assert.equal(entries.find((entry: any) => entry.name === 'Mesa 2').queue_order, 0)
    } finally {
      database.close()
    }

    const reopened = await launch()
    app = reopened
    const reopenedPage = await reopened.firstWindow()
    await reopenedPage.locator('#form-entry').waitFor({ state: 'visible' })
    const startupContinue = reopenedPage.locator('#btn-startup-primary')
    if (await startupContinue.isVisible()) await startupContinue.click()
    await reopenedPage.locator('.now-name').getByText('Mesa 4', { exact: true }).waitFor()
    assert.deepEqual(await reopenedPage.locator('#queue-list .card-name').allTextContents(), ['Mesa 2'])
    await reopenedPage.locator('#nav-history').click()
    await reopenedPage.locator('#history-panel .history-name').getByText('Mesa 3', { exact: true }).waitFor()
    await reopenedPage.locator('#history-panel .history-name').getByText('Prioridade manual', { exact: true }).waitFor()

    await closeWithEvidence(reopened)
    app = undefined

    const newShiftApp = await launch()
    app = newShiftApp
    const newShiftPage = await newShiftApp.firstWindow()
    await newShiftPage.locator('#form-entry').waitFor({ state: 'visible' })
    const startNew = newShiftPage.locator('#btn-startup-secondary')
    if (await startNew.isVisible()) {
      newShiftPage.once('dialog', (dialog: import('playwright').Dialog) => dialog.accept())
      await startNew.click()
    }
    await newShiftPage.getByText('Nenhuma entrada na fila.', { exact: true }).waitFor()
    await newShiftPage.locator('#btn-open-batch').click()
    const batchRows = newShiftPage.locator('.batch-row')
    for (let i = 0; i < 4; i++) await newShiftPage.locator('#btn-add-batch-row').click()
    const batchSingers = [
      ['Novo expediente', '8'], ['Fila manual', '9'], ['Prioridade C', '10'],
      ['Prioridade D', '11'], ['Prioridade E', '12'], ['Boost não', '13'], ['Boost sim', '14']
    ]
    for (let i = 0; i < batchSingers.length; i++) {
      await batchRows.nth(i).locator('.b-name').fill(batchSingers[i][0])
      await batchRows.nth(i).locator('.b-song').fill(String(8800 + i))
      if (batchSingers[i][0] === 'Fila manual') await batchRows.nth(i).locator('.b-song2').fill('8899')
      await batchRows.nth(i).locator('.b-table').fill(batchSingers[i][1])
    }
    await newShiftPage.locator('#btn-confirm-batch').click()
    await newShiftPage.locator('.now-name').getByText('Novo expediente', { exact: true }).waitFor()
    await newShiftPage.locator('#now-block .btn-done-lg').click()
    await newShiftPage.locator('.now-name').getByText('Fila manual', { exact: true }).waitFor()
    assert.match(await newShiftPage.locator('#toast').innerText(), /marcado como cantado/)

    // A new session gets its own explanation; one manually moved turn is then
    // fixed while the wait alerts remain eligible from positions four onward.
    const priorityDCard = newShiftPage.locator('#queue-list .queue-card').filter({ hasText: 'Prioridade D' })
    await dragQueuePreview(newShiftPage, priorityDCard, newShiftPage.locator('#queue-list .queue-card').first(), 'top')
    await newShiftPage.locator('#manual-move-modal').waitFor({ state: 'visible' })
    await newShiftPage.locator('#manual-move-dismiss').check()
    await newShiftPage.locator('#btn-confirm-manual-move').click()
    await addSingerTo(newShiftPage, 'Boost extra 1', '15', '8815')
    await addSingerTo(newShiftPage, 'Boost extra 2', '16', '8816')
    const waitAlertDialogs: string[] = []
    newShiftPage.on('dialog', async (dialog: import('playwright').Dialog) => {
      waitAlertDialogs.push(dialog.message())
      await dialog.accept()
    })
    await newShiftPage.evaluate(() => window.__kqueue?.flushState())
    const overdueDb = new DatabaseSync(databasePath)
    try {
      overdueDb.prepare("UPDATE entries SET inserted_at = ? WHERE status = 'pending'")
        .run(Date.now() - 120 * 60_000)
    } finally {
      overdueDb.close()
    }
    await newShiftPage.reload()
    const continueShiftAgain = newShiftPage.locator('#btn-startup-primary')
    if (await continueShiftAgain.isVisible()) await continueShiftAgain.click()
    await newShiftPage.locator('.card-boost-msg').first().waitFor()
    assert.equal(await newShiftPage.locator('.card-boost-msg').count(), 4)
    const dismissedExtraCard = newShiftPage.locator('.queue-card').filter({ hasText: 'Boost extra 2' })
    await dismissedExtraCard.locator('.btn-boost-no').click()
    await dismissedExtraCard.locator('.card-boost').waitFor({ state: 'detached' })
    const dismissedExtraId = await dismissedExtraCard.getAttribute('data-id')
    assert.ok(dismissedExtraId)
    const frozenAlertCard = newShiftPage.locator('.queue-card').filter({ has: newShiftPage.locator('.card-boost-msg') }).first()
    const frozenAlertId = await frozenAlertCard.getAttribute('data-id')
    const frozenAlertPosition = Number(await frozenAlertCard.getAttribute('data-position'))
    assert.ok(frozenAlertId)
    const queueOrderBeforeFreeze = await newShiftPage.locator('#queue-list .queue-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.id!))
    const expectedFrozenPrefix = queueOrderBeforeFreeze.slice(0, frozenAlertPosition)
    await frozenAlertCard.locator('.btn-freeze').click()
    await newShiftPage.waitForFunction((count: number) => document.querySelectorAll('#queue-list .queue-card[data-frozen="true"]').length === count, frozenAlertPosition)
    const frozenAlertCards = newShiftPage.locator('#queue-list .queue-card[data-frozen="true"]')
    assert.deepEqual(await frozenAlertCards.evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.id!)), expectedFrozenPrefix)
    assert.equal(await frozenAlertCards.locator('.card-boost, .boost-badge').count(), 0,
      'frozen turns lose expanded and collapsed wait alerts immediately')
    assert.equal(await newShiftPage.locator('#queue-list .queue-card[data-frozen="false"]:has(.card-boost-msg)').count(), 1,
      'eligible dynamic turns retain their alerts while a prefix is frozen')
    const firstAfterFreezeId = await newShiftPage.locator(`#queue-list .queue-card[data-position="${frozenAlertPosition + 1}"]`).getAttribute('data-id')
    assert.ok(firstAfterFreezeId)
    const firstAfterFreezeCard = newShiftPage.locator(`#queue-list .queue-card[data-id="${firstAfterFreezeId}"]`)
    assert.equal(await firstAfterFreezeCard.locator('.card-boost, .boost-badge').count(), 0,
      'the first available dynamic turn has no alert because priority would be a no-op')
    const orderBeforeStaleFirstDynamicBoost = await newShiftPage.locator('#queue-list .queue-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.id!))
    await newShiftPage.evaluate((id: string) => {
      ;(window as unknown as { acceptBoost: (turnId: string) => void }).acceptBoost(id)
    }, firstAfterFreezeId)
    assert.deepEqual(await newShiftPage.locator('#queue-list .queue-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.id!)), orderBeforeStaleFirstDynamicBoost,
      'a stale alert for the first dynamic turn cannot change queue order')
    await newShiftPage.screenshot({ path: path.join(screenshotDir, 'alerta-espera-bloco-congelado.png'), animations: 'disabled' })

    const dynamicBoostCard = newShiftPage.locator('#queue-list .queue-card[data-frozen="false"]:has(.card-boost-msg)').last()
    const dynamicBoostId = await dynamicBoostCard.getAttribute('data-id')
    await dynamicBoostCard.locator('.btn-boost-yes').click()
    assert.deepEqual(await frozenAlertCards.evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.id!)), expectedFrozenPrefix,
      'a dynamic wait priority cannot cross or reorder the frozen prefix')
    assert.equal(Number(await newShiftPage.locator(`#queue-list .queue-card[data-id="${dynamicBoostId}"]`).getAttribute('data-position')),
      frozenAlertPosition + 1, 'dynamic priority is placed after the frozen block')
    assert.equal(await newShiftPage.locator(`#queue-list .queue-card[data-id="${dynamicBoostId}"]`).locator('.card-boost, .boost-badge').count(), 0,
      'the promoted turn no longer offers a no-op priority alert at the first dynamic position')
    const orderBeforeStaleFrozenPriority = await newShiftPage.locator('#queue-list .queue-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.id!))
    await newShiftPage.evaluate((id: string) => {
      ;(window as unknown as { acceptBoost: (turnId: string) => void }).acceptBoost(id)
    }, frozenAlertId)
    assert.deepEqual(await newShiftPage.locator('#queue-list .queue-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.id!)), orderBeforeStaleFrozenPriority,
      'a stale wait-alert action for a frozen ID has no queue effect')

    await newShiftPage.locator('#btn-release-freeze').click()
    await newShiftPage.waitForFunction(() => document.querySelectorAll('#queue-list .queue-card[data-frozen="true"]').length === 0)
    const releasedDismissedExtra = newShiftPage.locator(`#queue-list .queue-card[data-id="${dismissedExtraId}"]`)
    if (Number(await releasedDismissedExtra.getAttribute('data-position')) > 3) {
      assert.equal(await releasedDismissedExtra.locator('.card-boost').count(), 0,
        'a prior dismissal remains in effect when the turn is frozen and released')
    }
    const dynamicallyPinnedCard = newShiftPage.locator(`#queue-list .queue-card[data-id="${dynamicBoostId}"]`)
    if (await dynamicallyPinnedCard.locator('.fixed-turn-badge').count()) {
      await dynamicallyPinnedCard.locator('button[title="Remover fixação"]').click()
    }

    const dismissedCard = newShiftPage.locator('.queue-card').filter({ hasText: 'Boost não' })
    await dismissedCard.locator('.btn-boost-no').click()
    await dismissedCard.locator('.card-boost').waitFor({ state: 'detached' })
    const acceptedCard = newShiftPage.locator('.queue-card').filter({ hasText: 'Boost sim' })
    await acceptedCard.locator('.btn-boost-yes').click()
    await newShiftPage.locator('#queue-list .queue-card').first().locator('.card-name').getByText('Boost sim', { exact: true }).waitFor()
    const priorityECard = newShiftPage.locator('#queue-list .queue-card').filter({ hasText: 'Prioridade E' })
    await dragQueuePreview(newShiftPage, priorityECard, newShiftPage.locator('#queue-list .queue-card').nth(2), 'top')
    await settleQueue(newShiftPage)
    await newShiftPage.locator('#manual-move-modal').waitFor({ state: 'hidden' })
    assert.equal(await newShiftPage.locator('#queue-list .queue-card').filter({ hasText: 'Prioridade E' }).getAttribute('data-position'), '3')
    assert.equal(await newShiftPage.locator('#queue-list .queue-card').filter({ hasText: 'Prioridade E' }).locator('.fixed-turn-badge').count(), 1)

    await newShiftPage.locator('#nav-history').click()
    await newShiftPage.locator('.history-card').filter({ hasText: 'Novo expediente' })
      .locator('.history-badge-clickable').click()
    await newShiftPage.locator('#table-modal-title').getByText('Mesa 8', { exact: true }).waitFor()
    await newShiftPage.locator('#btn-close-table-modal').click()
    await newShiftPage.evaluate(() => window.__kqueue?.flushState())

    const sessionDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const sessions = sessionDb.prepare('SELECT id, ended_at FROM sessions ORDER BY session_order').all()
      assert.equal(sessions.length, 2)
      assert.ok(sessions[0].ended_at)
      assert.equal(sessions[1].ended_at, null)
      const currentSessionId = sessionDb.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id
      const newEntry = sessionDb.prepare('SELECT session_id, status FROM entries WHERE name = ?').get('Novo expediente')
      assert.equal(newEntry.session_id, currentSessionId)
      assert.equal(newEntry.status, 'done')
      for (const name of ['Fila manual', 'Prioridade C', 'Prioridade D', 'Prioridade E', 'Boost não', 'Boost sim']) {
        const pendingEntry = sessionDb.prepare('SELECT session_id, status FROM entries WHERE name = ?').get(name)
        assert.equal(pendingEntry.session_id, currentSessionId)
        assert.equal(pendingEntry.status, 'pending')
      }
      const state = sessionDb.prepare('SELECT priority_ids_json, fixed_turn_positions_json FROM app_state WHERE singleton = 1').get()
      assert.deepEqual(JSON.parse(state.priority_ids_json), [])
      const fixed = JSON.parse(state.fixed_turn_positions_json) as Record<string, number>
      const fixedRows = Object.entries(fixed).map(([id, position]) => ({
        name: sessionDb.prepare('SELECT name FROM entries WHERE id = ?').get(id).name,
        position
      }))
      assert.deepEqual(fixedRows.sort((a, b) => a.position - b.position),
        [{ name: 'Boost sim', position: 1 }, { name: 'Prioridade D', position: 2 }, { name: 'Prioridade E', position: 3 }])
      assert.equal(sessionDb.prepare('SELECT 1 FROM entries WHERE name = ?').get(editedSinger), undefined)
    } finally {
      sessionDb.close()
    }

    await closeWithEvidence(newShiftApp)
    app = undefined
    const resumedNewShift = await launch()
    app = resumedNewShift
    const resumedPage = await resumedNewShift.firstWindow()
    await resumedNewShift.evaluate(({ BrowserWindow }: typeof import('electron')) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800)
    })
    const activityConfirmations: string[] = []
    resumedPage.on('dialog', async (dialog: import('playwright').Dialog) => {
      activityConfirmations.push(dialog.message())
      await dialog.accept()
    })
    await resumedPage.locator('#form-entry').waitFor({ state: 'visible' })
    const continueNewShift = resumedPage.locator('#btn-startup-primary')
    if (await continueNewShift.isVisible()) await continueNewShift.click()
    await resumedPage.locator('.now-name').getByText('Fila manual', { exact: true }).waitFor()
    assert.deepEqual(await resumedPage.locator('#queue-list .card-name').allTextContents().then((names: string[]) => names.slice(0, 3)),
      ['Boost sim', 'Prioridade D', 'Prioridade E'])
    const persistedPinsDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const state = persistedPinsDb.prepare('SELECT fixed_turn_positions_json FROM app_state WHERE singleton = 1').get()
      const fixed = JSON.parse(state.fixed_turn_positions_json) as Record<string, number>
      const fixedE = persistedPinsDb.prepare('SELECT id FROM entries WHERE name = ?').get('Prioridade E').id
      assert.equal(fixed[fixedE], 3, 'manual positions survive Electron restart in SQLite')
    } finally {
      persistedPinsDb.close()
    }

    await addSingerTo(resumedPage, 'Fila manual', '9', '9901', '9902')
    await addSingerTo(resumedPage, 'Pendente sem histórico', '9', '9911', '9912')
    for (let i = 0; i < 7; i++) {
      await addSingerTo(resumedPage, 'Fila manual', '9', String(9920 + i * 2), String(9921 + i * 2))
    }
    for (let table = 20; table < 40; table++) {
      await addSingerTo(resumedPage, `Mesa extra ${table}`, String(table), String(11000 + table))
    }
    const unifiedQueue = resumedPage.locator('#queue-list .queue-card')
    await resumedPage.waitForFunction(() => {
      const count = document.querySelectorAll('#queue-list .queue-card').length
      return count > 10 && Number(document.querySelector('#queue-count')?.textContent) === count
    })
    const visiblePositions = await unifiedQueue.evaluateAll((cards: HTMLElement[]) =>
      cards.map(card => Number(card.dataset.position)))
    assert.deepEqual(visiblePositions, visiblePositions.map((_position: number, index: number) => index + 1),
      'unified queue positions are continuous and every pending turn is rendered')
    assert.equal(await resumedPage.locator('#queue-list .queue-card[ondrop]').count(), visiblePositions.length,
      'every pending card accepts a manual drop')
    const longQueueOrder = await resumedPage.locator('#queue-list .card-name').allTextContents()
    await resumedPage.evaluate(() => { document.querySelector<HTMLElement>('.app-main')!.scrollTop = 0 })
    const longSource = resumedPage.locator('#queue-list .queue-card').first()
    const longSourceBox = await longSource.boundingBox()
    if (!longSourceBox) throw new Error('long queue drag source must be visible')
    await resumedPage.mouse.move(longSourceBox.x + longSourceBox.width / 2, longSourceBox.y + longSourceBox.height / 2)
    await resumedPage.mouse.down()
    await resumedPage.mouse.move(longSourceBox.x + longSourceBox.width / 2 + 8, longSourceBox.y + longSourceBox.height / 2, { steps: 2 })
    await resumedPage.locator('#queue-list .queue-drop-placeholder').waitFor({ state: 'visible' })
    const scrollBounds = await resumedPage.locator('.app-main').boundingBox()
    if (!scrollBounds) throw new Error('Long queue scroll container is not visible')
    const edgeX = scrollBounds.x + scrollBounds.width / 2
    const edgeY = scrollBounds.y + scrollBounds.height - 8
    // Real pointer movement at the scroll edge; no fabricated DragEvent.
    await resumedPage.mouse.move(edgeX, edgeY)
    await resumedPage.mouse.move(edgeX, edgeY)
    await resumedPage.mouse.move(edgeX + 1, edgeY)
    await resumedPage.waitForFunction(() => document.querySelector<HTMLElement>('.app-main')!.scrollTop > 0)
    const dragScrollTop = await resumedPage.locator('.app-main').evaluate((element: HTMLElement) => element.scrollTop)
    await resumedPage.screenshot({ path: path.join(screenshotDir, 'drag-preview-autoscroll.png'), animations: 'disabled' })
    assert.ok(dragScrollTop > 0, 'dragover at the viewport edge scrolls a long queue')
    // Leave Chromium's native edge auto-scroll region before cancelling the
    // intercepted drag. CDP dragCancel at the edge can leave its scroll timer alive.
    // Moving the pointer afterwards does not stop that Chromium timer.
    const neutralY = scrollBounds.y + scrollBounds.height / 2
    await resumedPage.mouse.move(edgeX, neutralY)
    await resumedPage.mouse.move(edgeX, neutralY)
    await resumedPage.keyboard.press('Escape')
    await resumedPage.mouse.up()
    await assertDragClean(resumedPage)
    assert.deepEqual(await resumedPage.locator('#queue-list .card-name').allTextContents(), longQueueOrder,
      'canceling a long-list drag restores the original order')
    assert.equal(await resumedPage.locator('#queue-list .queue-card').filter({ hasText: 'Prioridade E' }).getAttribute('data-position'), '3',
      'new registrations do not displace the individual fixed turn')
    await resumedPage.evaluate(() => window.__kqueue?.flushState())
    const afterArrivalDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const fixedState = afterArrivalDb.prepare('SELECT fixed_turn_positions_json FROM app_state WHERE singleton = 1').get()
      const id = afterArrivalDb.prepare('SELECT id FROM entries WHERE name = ?').get('Prioridade E').id
      assert.equal(JSON.parse(fixedState.fixed_turn_positions_json)[id], 3,
        'the fixed rank is persisted unchanged after new table requests')
    } finally {
      afterArrivalDb.close()
    }
    await resumedPage.locator('#queue-list .queue-card').filter({ hasText: 'Prioridade D' })
      .locator('button[title="Remover fixação"]').click()
    assert.equal(await resumedPage.locator('#queue-list .queue-card').filter({ hasText: 'Prioridade D' }).locator('.fixed-turn-badge').count(), 0)
    if (await resumedPage.locator('html').getAttribute('data-theme') !== 'light') {
      await resumedPage.locator('#btn-theme-toggle').click()
    }
    await resumedPage.screenshot({ path: path.join(screenshotDir, 'fila-unificada-claro.png'), animations: 'disabled' })
    await resumedPage.locator('#btn-theme-toggle').click()
    await resumedPage.screenshot({ path: path.join(screenshotDir, 'fila-unificada-escuro.png'), animations: 'disabled' })
    await resumedPage.locator('#btn-theme-toggle').click()
    await resumedPage.locator('.now-name').getByText('Fila manual', { exact: true }).waitFor()
    await resumedPage.locator('#now-block .btn-done-lg').click()
    await resumedPage.locator('.now-name').getByText('Boost sim', { exact: true }).waitFor()
    await resumedPage.locator('#nav-history').click()
    await resumedPage.locator('#history-panel .history-name').getByText('Fila manual', { exact: true }).waitFor()
    assert.equal(await resumedPage.locator('#history-stat-songs').innerText(), '3')
    assert.equal(await resumedPage.locator('.history-card').filter({ hasText: editedSinger }).count(), 0,
      'previous-session records must not appear in the current-session page')
    await selectTableFilter(resumedPage, '9')

    const finalTheme = await resumedPage.locator('html').getAttribute('data-theme')
    if (finalTheme !== 'light') await resumedPage.locator('#btn-theme-toggle').click()
    await resumedPage.locator('#toast').waitFor({ state: 'hidden' })
    await resumedPage.screenshot({ path: path.join(screenshotDir, '01-sessao-atual-claro.png'), animations: 'disabled' })
    await resumedPage.locator('.history-card').filter({ hasText: 'Fila manual' })
      .locator('.history-badge-clickable').click()
    await resumedPage.locator('#table-modal-title').getByText('Mesa 9', { exact: true }).waitFor()
    await resumedPage.locator('#table-modal').getByText('Cantadas (2)').waitFor()
    await resumedPage.locator('#table-modal').getByText('Na fila (16)').waitFor()
    await resumedPage.locator('#table-modal').getByText('Na fila (2)').waitFor()
    assert.equal(await resumedPage.locator('.tmodal-activity-singer').count(), 2)
    await resumedPage.evaluate(() => window.__kqueue?.flushState())
    const activityDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(activityDb.prepare("SELECT COUNT(*) AS n FROM entries WHERE table_number = ? AND status = 'done'").get('9').n, 1)
      assert.equal(activityDb.prepare("SELECT COUNT(*) AS n FROM entries WHERE table_number = ? AND status = 'pending'").get('9').n, 9)
    } finally {
      activityDb.close()
    }
    await resumedPage.locator('#toast').waitFor({ state: 'hidden' })
    await resumedPage.screenshot({ path: path.join(screenshotDir, '02-detalhes-mesa-claro.png'), animations: 'disabled' })
    await resumedPage.keyboard.press('Escape')
    await resumedPage.locator('#table-modal').waitFor({ state: 'hidden' })
    assert.match(await resumedPage.locator('#btn-table-filter-select').innerText(), /Mesa 9/)
    await resumedPage.locator('#btn-theme-toggle').click()
    assert.equal(await resumedPage.locator('html').getAttribute('data-theme'), 'dark')
    await resumedPage.screenshot({ path: path.join(screenshotDir, '03-sessao-atual-escuro.png'), animations: 'disabled' })
    await resumedPage.locator('.history-card').filter({ hasText: 'Fila manual' })
      .locator('.history-badge-clickable').click()
    await resumedPage.locator('#table-modal').waitFor({ state: 'visible' })
    await resumedPage.screenshot({ path: path.join(screenshotDir, '04-detalhes-mesa-escuro.png'), animations: 'disabled' })

    await resumedPage.locator('#btn-close-table-modal').click()
    await resumedPage.locator('#btn-view-tables').click()
    await resumedPage.locator('#tables-popover:not(.hidden)').waitFor()
    await resumedPage.screenshot({ path: path.join(screenshotDir, '05-seletor-mesas-escuro.png'), animations: 'disabled' })
    await resumedPage.keyboard.press('Escape')
    await resumedPage.locator('#tables-popover').waitFor({ state: 'hidden' })
    await resumedPage.locator('#history-search').fill('Fila manual')
    await resumedPage.locator('#history-list').evaluate((el: HTMLElement) => { el.style.minHeight = '900px' })
    const appMain = resumedPage.locator('.app-main')
    await appMain.evaluate((el: HTMLElement) => { el.scrollTo({ top: 120, behavior: 'instant' }) })
    const historyTableButton = resumedPage.locator('.history-card').filter({ hasText: 'Fila manual' }).locator('.history-view-table')
    // locator.click may scroll the button into view. Measure after that necessary
    // positioning, so this assertion tests the modal rather than Playwright scrolling.
    await historyTableButton.scrollIntoViewIfNeeded()
    await (await historyTableButton.elementHandle())!.waitForElementState('stable')
    const sessionScrollBeforeDetails = await appMain.evaluate((el: HTMLElement) => el.scrollTop)
    assert.ok(sessionScrollBeforeDetails > 0, 'session page should have a scroll position for modal preservation check')
    assert.equal(await resumedPage.locator('#table-filter-context').count(), 0)
    await historyTableButton.click()
    await resumedPage.locator('#table-modal-title').getByText('Mesa 9', { exact: true }).waitFor()
    await resumedPage.locator('#btn-close-table-modal').click()
    assert.equal(await appMain.evaluate((el: HTMLElement) => el.scrollTop), sessionScrollBeforeDetails)
    assert.equal(await resumedPage.locator('#history-search').inputValue(), 'Fila manual')
    assert.match(await resumedPage.locator('#btn-table-filter-select').innerText(), /Mesa 9/)

    const queueLengthBeforeTablePicker = await resumedPage.evaluate(() => window.__kqueue?.queueLength())
    const currentSingerBeforeTablePicker = await resumedPage.locator('.now-name').first().innerText()
    await resumedPage.locator('#btn-table-filter-select').click()
    await resumedPage.locator('#table-filter-search').fill('39')
    assert.deepEqual(await resumedPage.locator('[data-table-option]').evaluateAll((items: HTMLElement[]) =>
      items.map(item => item.dataset.tableOption)), ['', '39'])
    await resumedPage.screenshot({ path: path.join(screenshotDir, '06-filtro-pesquisado.png'), animations: 'disabled' })
    await resumedPage.locator('[data-table-option="39"]').click()
    assert.match(await resumedPage.locator('#btn-table-filter-select').innerText(), /Mesa 39/)
    assert.equal(await resumedPage.locator('#table-modal').evaluate((el: HTMLElement) => el.classList.contains('hidden')), true,
      'selecting a filter must not open the table modal')
    assert.equal(await resumedPage.evaluate(() => window.__kqueue?.queueLength()), queueLengthBeforeTablePicker)
    await selectTableFilter(resumedPage, null)
    await selectTableFilter(resumedPage, '9')
    await resumedPage.locator('#btn-view-tables').click()
    await resumedPage.locator('#tables-popover:not(.hidden)').waitFor()
    assert.deepEqual(await resumedPage.locator('.table-picker-card').evaluateAll((cards: HTMLElement[]) =>
      cards.map(card => card.dataset.table)), ['8', '9', '10', '11', '12', '13', '14', '15', '16', ...Array.from({ length: 20 }, (_, index) => String(20 + index))])
    await resumedPage.locator('.table-picker-card[data-table="39"]').click()
    await resumedPage.locator('#table-modal-title').getByText('Mesa 39', { exact: true }).waitFor()
    assert.equal(await resumedPage.locator('#table-modal .tmodal-stat').nth(0).locator('.tmodal-stat-value').innerText(), '0')
    assert.equal(await resumedPage.locator('#table-modal .tmodal-stat').nth(1).locator('.tmodal-stat-value').innerText(), '1')
    await resumedPage.locator('#btn-close-table-modal').click()
    assert.equal(await resumedPage.evaluate(() => window.__kqueue?.queueLength()), queueLengthBeforeTablePicker)
    assert.equal(await resumedPage.locator('.now-name').first().innerText(), currentSingerBeforeTablePicker)
    assert.equal(await resumedPage.locator('#history-search').inputValue(), 'Fila manual')
    assert.match(await resumedPage.locator('#btn-table-filter-select').innerText(), /Mesa 9/)

    await resumedPage.locator('#btn-view-tables').click()
    await resumedPage.keyboard.press('Escape')
    await resumedPage.locator('#tables-popover').waitFor({ state: 'hidden' })
    await resumedPage.locator('#btn-view-tables').click()
    await resumedPage.locator('#session-page-title').click()
    await resumedPage.locator('#tables-popover').waitFor({ state: 'hidden' })
    await resumedPage.locator('#history-list').evaluate((el: HTMLElement) => { el.style.minHeight = '' })
    await resumedPage.locator('.history-card').filter({ hasText: 'Fila manual' })
      .locator('.history-badge-clickable').click()
    await resumedPage.locator('#table-modal-title').getByText('Mesa 9', { exact: true }).waitFor()

    await resumedNewShift.evaluate(({ BrowserWindow }: typeof import('electron')) => {
      BrowserWindow.getAllWindows()[0].setContentSize(960, 600)
    })
    await resumedPage.waitForFunction(() => window.innerWidth === 960)
    const tableModalBounds = await resumedPage.locator('#table-modal .modal-box').evaluate((el: HTMLElement) => {
      const rect = el.getBoundingClientRect()
      return { x: rect.x, right: rect.right, top: rect.top, bottom: rect.bottom }
    })
    assert.ok(tableModalBounds.x >= 0 && tableModalBounds.right <= 960)
    assert.ok(tableModalBounds.top >= 0 && tableModalBounds.bottom <= 600)
    assert.ok(await resumedPage.locator('#table-modal-body').evaluate((el: HTMLElement) => el.scrollHeight > el.clientHeight))
    await resumedNewShift.evaluate(({ BrowserWindow }: typeof import('electron')) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800)
    })
    await resumedPage.waitForFunction(() => window.innerWidth === 1280)
    await resumedPage.locator('#btn-reset-table').click()
    await resumedPage.locator('#table-modal').waitFor({ state: 'hidden' })
    assert.ok(activityConfirmations.some(message => message.includes('Resetar Mesa 9')))
    await resumedPage.evaluate(() => window.__kqueue?.flushState())
    const resetDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(resetDb.prepare("SELECT COUNT(*) AS n FROM entries WHERE table_number = ? AND status = 'done'").get('9').n, 0)
      assert.equal(resetDb.prepare("SELECT COUNT(*) AS n FROM entries WHERE table_number = ? AND status = 'pending'").get('9').n, 9)
    } finally {
      resetDb.close()
    }
    await resumedPage.locator('#nav-dashboard').click()
    await resumedPage.locator('.queue-card').filter({ hasText: 'Pendente sem histórico' }).locator('.card-table').click()
    await resumedPage.locator('#table-modal-title').getByText('Mesa 9', { exact: true }).waitFor()
    await resumedPage.locator('#table-modal').getByText('Cantadas (0)').first().waitFor()
    assert.equal(await resumedPage.locator('#table-modal').getByText('Cantadas (0)').count(), 2)
    await resumedPage.locator('#table-modal').getByText('Na fila (2)').waitFor()
    await resumedPage.locator('#table-modal').click({ position: { x: 8, y: 8 } })
    await resumedPage.locator('#table-modal').waitFor({ state: 'hidden' })
    await resumedPage.evaluate(() => window.__kqueue?.flushState())
    console.log(`Fila unificada e mesas (Electron 1280x800): ${screenshotDir}`)

    await closeWithEvidence(resumedNewShift)
    app = undefined
    const afterActivityRestart = await launch()
    app = afterActivityRestart
    const recoveredPage = await afterActivityRestart.firstWindow()
    await recoveredPage.locator('#form-entry').waitFor({ state: 'visible' })
    const continueRecovered = recoveredPage.locator('#btn-startup-primary')
    if (await continueRecovered.isVisible()) await continueRecovered.click()
    await recoveredPage.locator('#nav-history').click()
    await recoveredPage.locator('#history-stat-songs').waitFor({ state: 'visible' })
    assert.equal(await recoveredPage.locator('#history-stat-songs').innerText(), '1')
    assert.equal(await recoveredPage.locator('.history-card').count(), 1)
    await recoveredPage.locator('.history-name').getByText('Novo expediente', { exact: true }).waitFor()
    const recoveredDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const appState = recoveredDb.prepare('SELECT fixed_turn_positions_json FROM app_state WHERE singleton = 1').get()
      const fixedE = recoveredDb.prepare('SELECT id FROM entries WHERE name = ?').get('Prioridade E').id
      assert.equal(JSON.parse(appState.fixed_turn_positions_json)[fixedE], 2,
        'the fixed position advances after an earlier presentation and survives another restart')
      assert.equal(recoveredDb.prepare("SELECT COUNT(*) AS n FROM entries WHERE table_number = ? AND status = 'done'").get('9').n, 0)
      assert.equal(recoveredDb.prepare("SELECT COUNT(*) AS n FROM entries WHERE table_number = ? AND status = 'pending'").get('9').n, 9)
    } finally {
      recoveredDb.close()
    }

    // Seed identity edge cases in the disposable SQLite profile, then restart
    // Electron so the UI verifies exactly the records recovered from SQLite.
    await closeWithEvidence(afterActivityRestart)
    app = undefined
    const identityDb = new DatabaseSync(databasePath)
    try {
      const state = identityDb.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get()
      const currentSessionId = state.current_session_id as string
      const previousSessionId = identityDb.prepare(
        'SELECT id FROM sessions WHERE id <> ? ORDER BY session_order LIMIT 1'
      ).get(currentSessionId).id as string
      const original = identityDb.prepare("SELECT id FROM entries WHERE name = ? AND status = 'done'").get('Novo expediente')
      assert.ok(original, 'fixture singer entry must exist in the isolated SQLite profile')
      identityDb.prepare('UPDATE entries SET name = ?, table_number = ?, song_number = ?, song_number2 = ? WHERE id = ?')
        .run('  João   Silva ', '1', '7001', '7002', original.id)

      let historyOrder = Number(identityDb.prepare('SELECT COALESCE(MAX(history_order), -1) + 1 AS next FROM entries WHERE status IN (?, ?)')
        .get('done', 'cancelled').next)
      let queueOrder = Number(identityDb.prepare('SELECT COALESCE(MAX(queue_order), -1) + 1 AS next FROM entries WHERE status = ?')
        .get('pending').next)
      const insert = identityDb.prepare(`INSERT INTO entries (
        id, session_id, name, song_number, song_number2, table_number, inserted_at,
        status, done_at, cancelled_at, queue_order, history_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      const now = Date.now()
      const addDone = (id: string, session: string, name: string, table: string, song: string) => {
        insert.run(id, session, name, song, '', table, now - 120_000, 'done', now - 60_000,
          null, null, historyOrder++)
      }
      addDone('identity-same-table-repeat', currentSessionId, 'JOÃO SILVA', '1', '7003')
      addDone('identity-other-table', currentSessionId, 'joão silva', '3', '7004')
      addDone('identity-maria', currentSessionId, 'Maria', '1', '7010')
      insert.run('identity-pending', currentSessionId, '  joão  SILVA ', '7005', '', '1', now,
        'pending', null, null, queueOrder++, null)
      insert.run('identity-pending-two', currentSessionId, 'João Silva', '7006', '7007', '1', now + 1,
        'pending', null, null, queueOrder++, null)
      insert.run('identity-cancelled', currentSessionId, 'João Silva', '7999', '', '1', now - 30_000,
        'cancelled', null, now - 20_000, null, historyOrder++)
      addDone('identity-previous-session', previousSessionId, 'João Silva', '1', '7998')
      insert.run('position-current', currentSessionId, 'Vez atual teste', '7100', '', '1', now + 2,
        'pending', null, null, queueOrder++, null)
      const priorityIds = ['position-priority-1', 'position-priority-2', 'position-priority-3']
      priorityIds.forEach((id, index) => insert.run(id, currentSessionId, `Prioridade teste ${index + 1}`,
        String(7110 + index), '', '1', now + 3 + index, 'pending', null, null, queueOrder++, null))
      for (let position = 4; position <= 8; position++) {
        insert.run(`position-wait-${position}`, currentSessionId, `Aguardando teste ${position}`,
          String(7120 + position), '', '1', now + position + 2, 'pending', null, null, queueOrder++, null)
      }
      identityDb.prepare(`UPDATE app_state SET current_turn_id = ?, next_turn_id = NULL, priority_ids_json = ?,
        fixed_turn_positions_json = '{}' WHERE singleton = 1`).run('position-current', JSON.stringify(priorityIds))
      const fixtureStatus = identityDb.prepare('SELECT status FROM entries WHERE id = ?')
      assert.equal(fixtureStatus.get('identity-same-table-repeat').status, 'done')
      assert.equal(fixtureStatus.get('identity-other-table').status, 'done')
      assert.equal(fixtureStatus.get('identity-maria').status, 'done')
      assert.equal(fixtureStatus.get('identity-pending').status, 'pending')
      assert.equal(fixtureStatus.get('identity-pending-two').status, 'pending')
      assert.equal(fixtureStatus.get('identity-cancelled').status, 'cancelled')
    } finally {
      identityDb.close()
    }

    const identityApp = await launch()
    app = identityApp
    const identityPage = await identityApp.firstWindow()
    const freezeConfirmations: string[] = []
    identityPage.on('dialog', async (dialog: import('playwright').Dialog) => {
      freezeConfirmations.push(dialog.message())
      await dialog.accept()
    })
    await identityPage.locator('#form-entry').waitFor({ state: 'visible' })
    const continueIdentitySession = identityPage.locator('#btn-startup-primary')
    if (await continueIdentitySession.isVisible()) await continueIdentitySession.click()
    await identityPage.locator('#nav-history').click()
    await identityPage.locator('#history-stat-songs').waitFor({ state: 'visible' })
    assert.equal(await identityPage.locator('#history-stat-songs').innerText(), '5')
    assert.equal(await identityPage.locator('#history-stat-singers').innerText(), '3')
    assert.equal(await identityPage.locator('#history-stat-tables').innerText(), '2')
    const search = identityPage.locator('#history-search')
    await search.fill('  JOÃO ')
    assert.equal(await identityPage.locator('.history-card--done').count(), 3,
      'search should find the same display name across tables, but exclude previous sessions')
    assert.equal(await identityPage.locator('.history-card--cancelled').count(), 1)
    const sameTableCards = identityPage.locator('.history-card--done').filter({ hasText: /Mesa 1/ })
    assert.equal(await sameTableCards.count(), 2)
    for (const card of await sameTableCards.all()) {
      await card.locator('.history-count').getByText('3 músicas', { exact: false }).waitFor()
      assert.doesNotMatch(await card.locator('.history-count').innerText(), /último às/i)
    }
    const otherTableCard = identityPage.locator('.history-card--done').filter({ hasText: /Mesa 3/ })
    await otherTableCard.locator('.history-count').getByText('1 música', { exact: false }).waitFor()
    assert.equal(await identityPage.locator('.history-card--done .history-times').count(), 3)

    await identityPage.locator('#history-search').fill('')
    await selectTableFilter(identityPage, '1')
    await identityPage.locator('.history-card--done').filter({ hasText: /Mesa 1/ }).first()
      .locator('.history-view-table').click()
    await identityPage.locator('#table-modal-title').getByText('Mesa 1', { exact: true }).waitFor()
    const tableModal = identityPage.locator('#table-modal')
    assert.equal(await tableModal.locator('.tmodal-activity-singer').count(), 11,
      'same-table name variants should group while separate singers and turn entries remain distinct')
    await tableModal.getByText('Cantadas (3)').waitFor()
    await tableModal.getByText('Na fila (3)').waitFor()
    const joaoGroupInfo = await tableModal.locator('[data-entry-id="identity-pending"]')
      .evaluate((row: HTMLElement) => {
        const singer = row.closest('.tmodal-activity-singer')
        return {
          singer,
          pendingRows: singer?.querySelectorAll('.tmodal-song-item--pending').length,
          singerName: singer?.querySelector('h4')?.textContent?.trim().replace(/\s+/gu, ' ')
        }
      })
    assert.ok(joaoGroupInfo.singerName, 'the first João request should be inside a singer group')
    assert.equal(joaoGroupInfo.singerName?.toLocaleLowerCase('pt-BR'), 'joão silva')
    assert.equal(joaoGroupInfo.pendingRows, 2, 'same-table name variants should group while turns remain separate rows')
    assert.equal(await tableModal.locator('[data-entry-id="identity-pending-two"]').count(), 1)
    assert.match(await tableModal.locator('[data-entry-id="identity-pending-two"]').locator('xpath=..').innerText(), /7006.*7007/)
    assert.equal(await tableModal.locator('.tmodal-position-info').count(), 1)
    assert.match(await tableModal.locator('.tmodal-position-info').innerText(), /Posições baseadas na ordem da fila/)
    assert.match(await tableModal.locator('.tmodal-position-help').getAttribute('title') ?? '', /não significa que a reprodução já começou/)
    assert.equal(await tableModal.locator('.tmodal-turn-position[data-entry-id="position-current"]').innerText(), 'Vez atual')
    assert.equal(await tableModal.locator('.tmodal-turn-position[data-entry-id="position-priority-1"]').innerText(), 'Aguardando · 1º na fila')
    assert.equal(await tableModal.locator('.tmodal-turn-position[data-entry-id="position-priority-2"]').innerText(), 'Aguardando · 2º na fila')
    assert.equal(await tableModal.locator('.tmodal-turn-position[data-entry-id="position-priority-3"]').innerText(), 'Aguardando · 3º na fila')
    assert.match(await tableModal.locator('.tmodal-turn-position[data-entry-id="position-wait-8"]').innerText(), /Aguardando · \d+º na fila/)
    const modalBody = identityPage.locator('#table-modal-body')
    await modalBody.evaluate((element: HTMLElement) => { element.scrollTop = 120 })
    const scrollBeforePriorityChange = await modalBody.evaluate((element: HTMLElement) => element.scrollTop)
    await identityPage.evaluate(() => (window as unknown as Record<string, (id: string) => void>).unpin('position-priority-1'))
    await identityPage.waitForFunction(() => {
      const second = document.querySelector('[data-entry-id="position-priority-2"]')
      return second?.textContent === 'Aguardando · 2º na fila'
    })
    assert.equal(await tableModal.evaluate((element: HTMLElement) => element.classList.contains('hidden')), false,
      'position refresh must leave the modal open')
    assert.equal(await tableModal.locator('.tmodal-turn-position[data-entry-id="position-priority-2"]').innerText(), 'Aguardando · 2º na fila')
    assert.equal(await modalBody.evaluate((element: HTMLElement) => element.scrollTop), scrollBeforePriorityChange,
      'position refresh must preserve modal scroll')
    await identityPage.locator('#btn-close-table-modal').click()
    assert.match(await identityPage.locator('#btn-table-filter-select').innerText(), /Mesa 1/)
    const tableOneHistoryCard = identityPage.locator('.history-card--done').filter({ hasText: /Mesa 1/ }).first()
    const themeToggle = identityPage.locator('#btn-theme-toggle')
    if (await identityPage.locator('html').getAttribute('data-theme') !== 'light') await themeToggle.click()
    await tableOneHistoryCard.locator('.history-view-table').click()
    await identityPage.locator('#table-modal').waitFor({ state: 'visible' })
    await identityPage.screenshot({ path: path.join(screenshotDir, '07-posicoes-modal-claro.png'), animations: 'disabled' })
    await identityPage.locator('#btn-close-table-modal').click()
    await themeToggle.click()
    assert.equal(await identityPage.locator('html').getAttribute('data-theme'), 'dark')
    await tableOneHistoryCard.locator('.history-view-table').click()
    await identityPage.locator('#table-modal').waitFor({ state: 'visible' })
    await identityPage.screenshot({ path: path.join(screenshotDir, '08-posicoes-modal-escuro.png'), animations: 'disabled' })
    await identityApp.evaluate(({ BrowserWindow }: typeof import('electron')) => {
      BrowserWindow.getAllWindows()[0].setContentSize(960, 600)
    })
    await identityPage.waitForFunction(() => window.innerWidth === 960)
    const positionModalBounds = await identityPage.locator('#table-modal .modal-box').evaluate((element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, right: rect.right, top: rect.top, bottom: rect.bottom }
    })
    assert.ok(positionModalBounds.x >= 0 && positionModalBounds.right <= 960)
    assert.ok(positionModalBounds.top >= 0 && positionModalBounds.bottom <= 600)
    await identityApp.evaluate(({ BrowserWindow }: typeof import('electron')) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800)
    })
    await identityPage.waitForFunction(() => window.innerWidth === 1280)
    await identityPage.locator('#btn-close-table-modal').click()
    await identityPage.screenshot({ path: path.join(screenshotDir, '09-identidade-cantores.png'), animations: 'disabled' })
    await identityPage.evaluate(() => window.__kqueue?.flushState())
    const identityVerifyDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const currentCount = identityVerifyDb.prepare('SELECT COUNT(*) AS total FROM entries WHERE session_id = ?').get(
        identityVerifyDb.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id
      )
      assert.ok(currentCount.total >= 5)
      assert.equal(identityVerifyDb.prepare('SELECT COUNT(*) AS total FROM entries WHERE id = ?').get('identity-pending').total, 1)
      assert.equal(identityVerifyDb.prepare('SELECT COUNT(*) AS total FROM entries WHERE id = ?').get('identity-previous-session').total, 1)
    } finally {
      identityVerifyDb.close()
    }

    await identityPage.locator('#nav-dashboard').click()
    await identityPage.locator('#dashboard-page').waitFor({ state: 'visible' })
    for (let index = 0; index < 12; index++) {
      await addSingerTo(identityPage, `Freeze E2E ${index}`, String(70 + index), String(70000 + index))
    }
    const frozenCards = identityPage.locator('#queue-list .queue-card[data-frozen="true"]')
    const readFrozenIds = (): Promise<string[]> => frozenCards.evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.id!))
    const readQueueIds = (): Promise<string[]> => identityPage.locator('#queue-list .queue-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.id!))
    await identityPage.locator('#queue-list .queue-card').first().locator('.btn-freeze').click()
    await identityPage.waitForFunction(() => document.querySelectorAll('#queue-list .queue-card[data-frozen="true"]').length === 1)
    assert.equal(await identityPage.locator('#queue-freeze-status').isVisible(), false,
      'the frozen count is represented by the section heading rather than duplicated in the general header')
    assert.match(await identityPage.locator('#queue-list .queue-section-heading--frozen').innerText(), /Congeladas · 1/i)
    const oneFrozenId = (await readFrozenIds())[0]
    await addSingerTo(identityPage, 'Mesa nova durante congelamento', '99', '79999')
    assert.deepEqual(await readFrozenIds(), [oneFrozenId], 'new requests must remain outside the frozen block')
    await identityPage.locator('#queue-list .queue-card[data-position="3"] .btn-freeze').click()
    await identityPage.waitForFunction(() => document.querySelectorAll('#queue-list .queue-card[data-frozen="true"]').length === 3)
    const freezeSectionHeading = identityPage.locator('#queue-list .queue-section-heading--frozen')
    const dynamicSectionHeading = identityPage.locator('#queue-list .queue-section-heading--dynamic')
    assert.match(await freezeSectionHeading.innerText(), /Congeladas · 3/i)
    assert.equal(await freezeSectionHeading.locator('.freeze-lock-icon').count(), 1)
    assert.equal(await freezeSectionHeading.evaluate((element: Element) => element.nextElementSibling?.getAttribute('data-frozen')), 'true',
      'the frozen section title appears immediately before its first card')
    assert.equal(await dynamicSectionHeading.evaluate((element: Element) => element.nextElementSibling?.getAttribute('data-frozen')), 'false',
      'the dynamic title appears immediately before its first card')
    assert.equal(await identityPage.locator('#queue-freeze-status').isVisible(), false,
      'the frozen count is not repeated in the general header')
    assert.ok(await identityPage.locator('#queue-list .queue-card[data-frozen="true"] .fixed-turn-badge').count() > 0,
      'manual pins retain their purple marker inside the blue frozen block')
    if (await identityPage.locator('html').getAttribute('data-theme') !== 'light') await identityPage.locator('#btn-theme-toggle').click()
    assert.equal(await identityPage.locator('html').getAttribute('data-theme'), 'light')
    await identityPage.evaluate(() => { document.querySelector<HTMLElement>('.app-main')!.scrollTop = 0 })
    await identityPage.screenshot({ path: path.join(screenshotDir, 'fila-congelada-e-dinamica-claro.png'), animations: 'disabled' })
    await identityPage.locator('#queue-list .queue-card[data-position="10"] .btn-freeze').click()
    await identityPage.waitForFunction(() => document.querySelectorAll('#queue-list .queue-card[data-frozen="true"]').length === 10)
    let protectedIds = await readFrozenIds()
    assert.equal(protectedIds.length, 10)
    assert.deepEqual(protectedIds, (await readQueueIds()).slice(0, 10))
    assert.ok(freezeConfirmations.some(message => /não será reorganizada automaticamente/.test(message)))
    if (await identityPage.locator('html').getAttribute('data-theme') !== 'light') await identityPage.locator('#btn-theme-toggle').click()
    await identityPage.evaluate(() => { document.querySelector<HTMLElement>('.app-main')!.scrollTop = 0 })
    await identityPage.screenshot({ path: path.join(screenshotDir, 'fila-congelada-claro.png'), animations: 'disabled' })

    const currentSingerBeforeAdvance = await identityPage.locator('.now-name').innerText()
    const promotedFrozenSinger = await identityPage.locator(`#queue-list .queue-card[data-id="${protectedIds[0]}"] .card-name`).innerText()
    await identityPage.locator('#now-block .btn-done-lg').click()
    await identityPage.waitForFunction(() => document.querySelectorAll('#queue-list .queue-card[data-frozen="true"]').length === 9)
    await identityPage.locator('.now-name').getByText(promotedFrozenSinger, { exact: true }).waitFor()
    assert.notEqual(await identityPage.locator('.now-name').innerText(), currentSingerBeforeAdvance)
    protectedIds = protectedIds.slice(1)

    const cancelledFrozenId = protectedIds[0]
    const cancelledFrozenCard = identityPage.locator(`#queue-list .queue-card[data-id="${cancelledFrozenId}"]`)
    await cancelledFrozenCard.locator('.queue-action-menu-toggle').click()
    await identityPage.getByRole('menuitem', { name: 'Cancelar' }).click()
    await identityPage.waitForFunction(() => document.querySelectorAll('#queue-list .queue-card[data-frozen="true"]').length === 8)
    protectedIds = protectedIds.filter(id => id !== cancelledFrozenId)
    assert.deepEqual(await readFrozenIds(), protectedIds)
    const dynamicCards = identityPage.locator('#queue-list .queue-card[data-frozen="false"]')
    const dynamicSource = identityPage.locator('#queue-list .queue-card[data-position="9"]')
    const dynamicMoveId = await dynamicSource.getAttribute('data-id')
    assert.ok(dynamicMoveId)
    const dynamicTarget = identityPage.locator('#queue-list .queue-card[data-position="10"]')
    await dragQueuePreview(identityPage, dynamicSource, dynamicTarget, 'bottom')
    if (await identityPage.locator('#manual-move-modal').isVisible()) {
      await identityPage.locator('#btn-confirm-manual-move').click()
    }
    await settleQueue(identityPage)
    assert.deepEqual(await readFrozenIds(), protectedIds, 'manual movement in the dynamic region must preserve the protected sequence')
    const movedPosition = await identityPage.locator(`#queue-list .queue-card[data-id="${dynamicMoveId}"]`).getAttribute('data-position')
    assert.equal(movedPosition, '10',
      `drag inside the dynamic region should move the turn while leaving the frozen prefix intact (toast: ${await identityPage.locator('#toast').innerText()})`)
    const lockedFrozenCard = identityPage.locator(`#queue-list .queue-card[data-id="${protectedIds[0]}"]`)
    await assertFrozenDragBlocked(identityPage, lockedFrozenCard)
    await assertDragClean(identityPage)
    assert.match(await identityPage.locator('#toast').innerText(), /Este turno está congelado/)
    assert.deepEqual(await readFrozenIds(), protectedIds)

    const firstFrozenCard = identityPage.locator(`#queue-list .queue-card[data-id="${protectedIds[0]}"]`)
    await firstFrozenCard.locator('.card-table-clickable').click()
    await identityPage.locator('#table-modal').waitFor({ state: 'visible' })
    const firstFrozenPosition = identityPage.locator(`.tmodal-turn-position[data-entry-id="${protectedIds[0]}"]`)
    await firstFrozenPosition.waitFor()
    assert.equal(await firstFrozenPosition.innerText(), 'Aguardando · 1º na fila')
    await identityPage.locator('#btn-close-table-modal').click()
    await firstFrozenCard.locator('.queue-action-menu-toggle').click()
    await identityPage.getByRole('menuitem', { name: 'Editar' }).click()
    assert.ok(freezeConfirmations.some(message => /pode divergir do que já foi preparado no player/.test(message)))
    await identityPage.locator('#edit-modal').waitFor({ state: 'visible' })
    await identityPage.locator('#btn-cancel-edit').click()

    await identityPage.evaluate(() => window.__kqueue?.flushState())
    const frozenDb = new DatabaseSync(databasePath, { readOnly: true })
    let persistedFrozenIds: string[]
    let fixedBeforeRelease: Record<string, number>
    try {
      const row = frozenDb.prepare('SELECT frozen_turn_ids_json, fixed_turn_positions_json FROM app_state WHERE singleton = 1').get()
      persistedFrozenIds = JSON.parse(row.frozen_turn_ids_json)
      fixedBeforeRelease = JSON.parse(row.fixed_turn_positions_json)
      assert.deepEqual(persistedFrozenIds, protectedIds, 'SQLite stores ordered frozen IDs, not just a count')
    } finally {
      frozenDb.close()
    }

    if (await identityPage.locator('html').getAttribute('data-theme') !== 'dark') await identityPage.locator('#btn-theme-toggle').click()
    await identityPage.screenshot({ path: path.join(screenshotDir, 'fila-congelada-escuro.png'), animations: 'disabled' })
    await closeWithEvidence(identityApp)
    app = undefined

    const recoveredFreezeApp = await launch()
    app = recoveredFreezeApp
    const recoveredFreezePage = await recoveredFreezeApp.firstWindow()
    recoveredFreezePage.on('dialog', async (dialog: import('playwright').Dialog) => {
      freezeConfirmations.push(dialog.message())
      await dialog.accept()
    })
    await recoveredFreezeApp.evaluate(({ BrowserWindow }: typeof import('electron')) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
    const continueFrozenSession = recoveredFreezePage.locator('#btn-startup-primary')
    await recoveredFreezePage.locator('#form-entry').waitFor({ state: 'visible' })
    if (await continueFrozenSession.isVisible()) await continueFrozenSession.click()
    await recoveredFreezePage.waitForFunction(() => document.querySelectorAll('#queue-list .queue-card[data-frozen="true"]').length === 8)
    assert.deepEqual(await recoveredFreezePage.locator('#queue-list .queue-card[data-frozen="true"]')
      .evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.id!)), persistedFrozenIds)
    await recoveredFreezePage.evaluate(() => window.__kqueue?.flushState())
    const freezeRecoveryDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const row = freezeRecoveryDb.prepare('SELECT frozen_turn_ids_json, fixed_turn_positions_json FROM app_state WHERE singleton = 1').get()
      assert.deepEqual(JSON.parse(row.frozen_turn_ids_json), persistedFrozenIds)
      assert.deepEqual(JSON.parse(row.fixed_turn_positions_json), fixedBeforeRelease)
    } finally {
      freezeRecoveryDb.close()
    }
    await recoveredFreezePage.screenshot({ path: path.join(screenshotDir, 'fila-congelada-recuperada-escuro.png'), animations: 'disabled' })
    const pendingBeforeFullFreeze = await recoveredFreezePage.locator('#queue-list .queue-card').count()
    await recoveredFreezePage.locator('#queue-list .queue-card[data-frozen="false"] .btn-freeze').last().click()
    await recoveredFreezePage.waitForFunction((count: number) =>
      document.querySelectorAll('#queue-list .queue-card[data-frozen="true"]').length === count, pendingBeforeFullFreeze)
    assert.equal(await recoveredFreezePage.locator('#queue-list .queue-section-heading--dynamic').count(), 0,
      'a fully frozen queue has no empty dynamic section')
    assert.equal(await recoveredFreezePage.locator('#queue-list .queue-section-heading--frozen')
      .evaluate((element: Element) => element.nextElementSibling?.getAttribute('data-frozen')), 'true')
    await recoveredFreezePage.evaluate(() => { document.querySelector<HTMLElement>('.app-main')!.scrollTop = 0 })
    await recoveredFreezePage.screenshot({ path: path.join(screenshotDir, 'fila-totalmente-congelada-escuro.png'), animations: 'disabled' })
    await recoveredFreezePage.locator('#btn-release-freeze').click()
    await recoveredFreezePage.waitForFunction(() => document.querySelector('#queue-freeze-status')?.textContent === 'Fila automática')
    assert.equal(await recoveredFreezePage.locator('#btn-release-freeze').isVisible(), false,
      'the release control is hidden after the block has been removed')
    assert.equal(await recoveredFreezePage.locator('#queue-list .queue-section-heading').count(), 0,
      'an unfrozen queue renders without section dividers')
    await recoveredFreezePage.evaluate(() => window.__kqueue?.flushState())
    const releasedDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const row = releasedDb.prepare('SELECT frozen_turn_ids_json, fixed_turn_positions_json FROM app_state WHERE singleton = 1').get()
      assert.deepEqual(JSON.parse(row.frozen_turn_ids_json), [])
      assert.deepEqual(JSON.parse(row.fixed_turn_positions_json), fixedBeforeRelease,
        'releasing the block does not remove individual pins')
    } finally {
      releasedDb.close()
    }
    await recoveredFreezePage.evaluate(() => { document.querySelector<HTMLElement>('.app-main')!.scrollTop = 0 })
    await recoveredFreezePage.screenshot({ path: path.join(screenshotDir, 'fila-dinamica-escuro.png'), animations: 'disabled' })
    if (await recoveredFreezePage.locator('html').getAttribute('data-theme') !== 'light') {
      await recoveredFreezePage.locator('#btn-theme-toggle').click()
    }
    await recoveredFreezePage.screenshot({ path: path.join(screenshotDir, 'fila-dinamica-claro.png'), animations: 'disabled' })

    const settingsNav = recoveredFreezePage.locator('#nav-settings')
    assert.equal(await settingsNav.getAttribute('title'), 'Configurações')
    assert.equal(await settingsNav.getAttribute('aria-label'), 'Configurações')
    await settingsNav.click()
    await recoveredFreezePage.locator('#settings-page-title').waitFor({ state: 'visible' })
    assert.equal(await recoveredFreezePage.locator('#nav-settings').getAttribute('aria-current'), 'page')
    assert.equal(await recoveredFreezePage.locator('#settings-scale-select').inputValue(), 'auto')
    await recoveredFreezePage.locator('#btn-sidebar-toggle').click()
    await recoveredFreezePage.waitForFunction(() => document.querySelector('#app-sidebar')?.classList.contains('is-expanded'))
    assert.equal(await settingsNav.locator('.sidebar-label').innerText(), 'Configurações')
    assert.equal(await settingsNav.getAttribute('aria-current'), 'page', 'settings remains active when the sidebar expands')
    await recoveredFreezePage.locator('#btn-sidebar-toggle').click()
    await recoveredFreezePage.waitForFunction(() => !document.querySelector('#app-sidebar')?.classList.contains('is-expanded'))
    await recoveredFreezePage.screenshot({ path: path.join(screenshotDir, 'configuracoes-aparencia-claro.png'), animations: 'disabled' })
    if (await recoveredFreezePage.locator('html').getAttribute('data-theme') !== 'dark') {
      await recoveredFreezePage.locator('#btn-theme-toggle').click()
    }
    await recoveredFreezePage.screenshot({ path: path.join(screenshotDir, 'configuracoes-aparencia-escuro.png'), animations: 'disabled' })

    const scaleSelect = recoveredFreezePage.locator('#settings-scale-select')
    for (const [preference, expected] of [['100', 1], ['110', 1.1], ['125', 1.25], ['150', 1.5]] as const) {
      await scaleSelect.selectOption(preference)
      await recoveredFreezePage.waitForFunction((factor: number) =>
        Math.abs(Number(document.querySelector('#settings-scale-effective')?.textContent?.replace('%', '')) / 100 - factor) < .001,
        expected)
      const applied = await recoveredFreezeApp.evaluate(({ BrowserWindow }: typeof import('electron')) =>
        BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
      assert.equal(applied, expected, `manual scale ${preference}% applies immediately`)
    }
    await recoveredFreezePage.screenshot({ path: path.join(screenshotDir, 'configuracoes-150-1280x800.png'), animations: 'disabled' })

    const setContentSize = async (width: number, height: number) => recoveredFreezeApp.evaluate(
      ({ BrowserWindow }: typeof import('electron'), size: number[]) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]),
      [width, height])
    await setContentSize(2560, 1440)
    await recoveredFreezePage.waitForTimeout(100)
    assert.equal(await recoveredFreezeApp.evaluate(({ BrowserWindow }: typeof import('electron')) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1.5,
    'manual scale is retained when the window crosses the QHD automatic threshold')
    await scaleSelect.selectOption('auto')
    await recoveredFreezePage.waitForFunction(() => Number(document.querySelector('#settings-scale-effective')?.textContent?.replace('%', '')) === 110)
    assert.equal(await recoveredFreezeApp.evaluate(({ BrowserWindow }: typeof import('electron')) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1.1,
    'automatic scale recalculates immediately when restored at QHD')
    await setContentSize(3840, 2160)
    await recoveredFreezePage.waitForFunction(() => Number(document.querySelector('#settings-scale-effective')?.textContent?.replace('%', '')) === 120)
    await setContentSize(1280, 800)
    await recoveredFreezePage.waitForFunction(() => Number(document.querySelector('#settings-scale-effective')?.textContent?.replace('%', '')) === 100)
    await scaleSelect.selectOption('110')
    await setContentSize(2560, 1440)
    await recoveredFreezePage.waitForTimeout(100)
    assert.equal(await recoveredFreezeApp.evaluate(({ BrowserWindow }: typeof import('electron')) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1.1,
    'manual preference survives automatic threshold changes')
    await setContentSize(960, 600)
    await scaleSelect.selectOption('150')
    await recoveredFreezePage.waitForFunction(() => Number(document.querySelector('#settings-scale-effective')?.textContent?.replace('%', '')) === 150)
    const compactViewport = await recoveredFreezePage.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      pageVisible: !document.querySelector('#settings-page')!.classList.contains('hidden')
    }))
    assert.equal(compactViewport.pageVisible, true)
    assert.ok(compactViewport.scrollWidth <= compactViewport.width + 1, '150% at 960x600 has no horizontal overflow')
    await recoveredFreezePage.screenshot({ path: path.join(screenshotDir, 'configuracoes-150-960x600.png'), animations: 'disabled' })
    await setContentSize(1280, 800)
    await scaleSelect.selectOption('125')
    const preferencesPath = path.join(
      await recoveredFreezeApp.evaluate(({ app: electronMain }: typeof import('electron')) => electronMain.getPath('userData')),
      'ui-preferences.json'
    )
    const persistedPreferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'))
    assert.equal(persistedPreferences.scalePreference, '125',
      'the scale preference is persisted outside SQLite in the isolated Electron profile')
    assert.equal(persistedPreferences.sidebarDisplayName, 'Karaoke Queue',
      'the global sidebar name shares the persistent UI preference file')
    await closeWithEvidence(recoveredFreezeApp)
    app = undefined

    const scaleRecoveryApp = await launch()
    app = scaleRecoveryApp
    const scaleRecoveryPage = await scaleRecoveryApp.firstWindow()
    await scaleRecoveryPage.locator('#form-entry').waitFor({ state: 'visible' })
    assert.equal(await scaleRecoveryApp.evaluate(({ BrowserWindow }: typeof import('electron')) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1.25,
    'persisted manual scale is active on first window load after restart')
    const scaleRecoveryContinue = scaleRecoveryPage.locator('#btn-startup-primary')
    if (await scaleRecoveryContinue.isVisible()) await scaleRecoveryContinue.click()
    await scaleRecoveryPage.locator('#nav-settings').click()
    assert.equal(await scaleRecoveryPage.locator('#settings-scale-select').inputValue(), '125')
    assert.equal((await scaleRecoveryPage.locator('#settings-scale-effective').innerText()).trim(), '125%')
    await scaleRecoveryPage.screenshot({ path: path.join(screenshotDir, 'configuracoes-recuperadas-125.png'), animations: 'disabled' })
    await closeWithEvidence(scaleRecoveryApp)
    app = undefined

    console.log(`Screenshots Electron 1280x800 — fila e configurações: ${screenshotDir}`)
    console.log('PASS: Electron SQLite workflow and manual/automatic UI scale, profile persistence, resize behavior, and restart recovery')
  } catch (error) {
    if (app) {
      const failedPage = await app.firstWindow().catch(() => null)
      if (failedPage) await saveDragDiagnostics(failedPage, evidenceDir, 'failure').catch(() => {})
      await app.context().tracing.stop({ path: path.join(evidenceDir, 'failure.zip') }).catch(() => {})
      console.error(`Failure diagnostics: ${evidenceDir}`)
    }
    throw error
  } finally {
    if (app) {
      await app.evaluate(({ app: electronApp }: typeof import('electron')) => electronApp.exit(0)).catch(() => {})
      await app.close().catch(() => {})
    }
    fs.rmSync(profileRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
