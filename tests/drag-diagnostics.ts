import type { Page, Locator } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

/** Test-only observation. No application methods or synthetic drag events. */
export async function observeDrag(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    if (w.__dragAudit) return
    w.__dragAudit = { events: [], attempts: [] }
    for (const type of ['dragstart', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) {
      document.addEventListener(type, event => {
        const drag = event as DragEvent
        const target = event.target as Element | null
        const hit = document.elementFromPoint(drag.clientX, drag.clientY)
        w.__dragAudit.events.push({ type, time: performance.now(), x: drag.clientX, y: drag.clientY,
          target: target?.id || target?.className, turnId: target?.closest<HTMLElement>('[data-id]')?.dataset.id,
          hit: hit?.id || hit?.className, effect: drag.dataTransfer?.dropEffect,
          allowed: drag.dataTransfer?.effectAllowed, prevented: drag.defaultPrevented,
          trusted: drag.isTrusted, scroll: document.querySelector('.app-main')?.scrollTop,
          order: [...document.querySelectorAll<HTMLElement>('#queue-list .queue-card')].map(card => card.dataset.id) })
      })
    }
  })
}

export async function recordAttempt(page: Page, source: Locator, target: Locator): Promise<void> {
  await observeDrag(page)
  const attempt = { source: await source.getAttribute('data-id'), target: await target.getAttribute('data-id'),
    sourceBox: await source.boundingBox(), targetBox: await target.boundingBox() }
  await page.evaluate(attempt => (window as any).__dragAudit.attempts.push(attempt), attempt)
}

export async function saveDragDiagnostics(page: Page, directory: string, prefix: string): Promise<void> {
  fs.mkdirSync(directory, { recursive: true })
  const data = await page.evaluate(() => ({ ...(window as any).__dragAudit,
    modal: document.querySelector('#manual-move-modal')?.className,
    overlays: [...document.querySelectorAll('.modal, #overlay')].map(element => ({ id: element.id,
      display: getComputedStyle(element).display, pointerEvents: getComputedStyle(element).pointerEvents })),
    transient: [...document.querySelectorAll('.drag-source, .dragging, .queue-drop-placeholder, .drag-over')].map(element => element.className),
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    storageError: document.querySelector('.persistence-feedback')?.hasAttribute('hidden') === false
  }))
  fs.writeFileSync(path.join(directory, `${prefix}.json`), JSON.stringify(data, null, 2))
  await page.screenshot({ path: path.join(directory, `${prefix}.png`) })
}

export async function settleQueue(page: Page): Promise<void> {
  await page.evaluate(() => window.__kqueue?.flushState())
  await page.waitForFunction(() => !document.querySelector('#queue-list')?.getAnimations({ subtree: true })
    .some(animation => animation.playState === 'running'))
}

export async function dragQueuePreview(page: Page, source: Locator, target: Locator,
  edge: 'top' | 'bottom', screenshot?: string, drop = true): Promise<string[]> {
  await settleQueue(page)
  const sourceId = await source.getAttribute('data-id')
  const targetId = await target.getAttribute('data-id')
  if (!sourceId || !targetId) throw new Error('Queue drag requires stable turn IDs')
  source = page.locator(`#queue-list .queue-card[data-id="${sourceId}"]`)
  target = page.locator(`#queue-list .queue-card[data-id="${targetId}"]`)
  await source.scrollIntoViewIfNeeded()
  await (await source.elementHandle())!.waitForElementState('stable')
  await recordAttempt(page, source, target)
  const ids = await page.locator('#queue-list .queue-card').evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.id))
  const from = ids.indexOf(sourceId), to = ids.indexOf(targetId)
  const desired = sourceId === targetId ? from : to - (from < to ? 1 : 0) + (edge === 'bottom' ? 1 : 0)
  const start = await source.boundingBox()
  if (!start) throw new Error('Invisible drag source')
  const x = start.x + Math.min(180, start.width / 2)
  await page.mouse.move(x, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(x + 8, start.y + start.height / 2)
  const placeholder = page.locator('#queue-list .queue-drop-placeholder')
  await placeholder.waitFor({ state: 'visible' })
  if (sourceId !== targetId) {
    await target.scrollIntoViewIfNeeded()
    await (await target.elementHandle())!.waitForElementState('stable')
    const bounds = await target.boundingBox()
    if (!bounds) throw new Error('Invisible drop target')
    const targetX = bounds.x + Math.min(180, bounds.width / 2)
    const targetY = bounds.y + bounds.height * (edge === 'top' ? 0.25 : 0.75)
    // Chromium may emit only dragenter when the hit-tested element changes.
    // A second move at the destination produces the accepting dragover.
    await page.mouse.move(targetX, targetY)
    await page.mouse.move(targetX, targetY)
  }
  await page.waitForFunction(expected => {
    const children = [...document.querySelector('#queue-list')!.children]
      .filter(child => child.matches('.queue-card:not(.drag-source), .queue-drop-placeholder'))
    return children.findIndex(child => child.classList.contains('queue-drop-placeholder')) === expected
  }, desired)
  await (await placeholder.elementHandle())!.waitForElementState('stable')
  await page.waitForFunction(() => !document.querySelector('#queue-list')?.getAnimations({ subtree: true })
    .some(animation => animation.playState === 'running'))
  // Release inside the insertion space, never at a stale moving card edge.
  const space = await placeholder.boundingBox()
  if (!space) throw new Error('Insertion space disappeared')
  await page.mouse.move(space.x + Math.min(180, space.width / 2), space.y + space.height / 2)
  await page.mouse.move(space.x + Math.min(180, space.width / 2), space.y + space.height / 2)
  const preview = await page.locator('#queue-list').evaluate(list => [...list.children]
    .filter(child => child.matches('.queue-card:not(.drag-source), .queue-drop-placeholder'))
    .map(child => child.classList.contains('queue-drop-placeholder') ? '<inserção>' : child.querySelector('.card-name')!.textContent!.trim()))
  if (screenshot) await page.screenshot({ path: screenshot })
  if (drop) {
    const eventCount = await page.evaluate(() => (window as any).__dragAudit.events.length)
    await page.mouse.up()
    await page.waitForFunction(start => (window as any).__dragAudit.events.slice(start)
      .some((event: any) => event.type === 'drop' && event.prevented && event.trusted), eventCount)
  }
  return preview
}

export async function assertDragClean(page: Page): Promise<void> {
  await page.waitForFunction(() => !document.querySelector('.drag-source, .dragging, .queue-drop-placeholder, .drag-over, .drop-before, .drop-after')
    && document.querySelector('#manual-move-modal')?.classList.contains('hidden'))
  await settleQueue(page)
}

/** A blocked source must reject dragstart before scrolling to any destination. */
export async function assertFrozenDragBlocked(page: Page, source: Locator): Promise<void> {
  await settleQueue(page)
  await source.scrollIntoViewIfNeeded()
  await (await source.elementHandle())!.waitForElementState('stable')
  await observeDrag(page)
  const id = await source.getAttribute('data-id')
  const count = await page.evaluate(() => (window as any).__dragAudit.events.length)
  const box = await source.boundingBox()
  if (!box) throw new Error('Frozen source is not visible')
  const x = box.x + Math.min(180, box.width / 2), y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 12, y)
  await page.mouse.up()
  await page.waitForFunction(({ id, count }) => (window as any).__dragAudit.events.slice(count)
    .some((event: any) => event.type === 'dragstart' && event.turnId === id && event.trusted && event.prevented), { id, count })
  await assertDragClean(page)
}
