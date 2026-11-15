// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function createElectronTestTempRoot(prefix: string): string {
  const configuredRoot = process.env.KARAOKE_TEST_TEMP_ROOT
  if (configuredRoot) fs.mkdirSync(path.resolve(configuredRoot), { recursive: true })
  return fs.mkdtempSync(path.join(configuredRoot ? path.resolve(configuredRoot) : os.tmpdir(), `${prefix}-`))
}

export function withElectronTestDeadline<T>(operation: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`ELECTRON_TEST_AUTOMATION_TIMEOUT:${label}`)), timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

/** Run a test body and its cleanup without allowing teardown to hide the original failure. */
export async function runWithElectronTestCleanup<T>(
  body: () => Promise<T>, cleanup: () => Promise<void>,
  reportCleanupFailure: (error: unknown) => void = error => {
    const rawMessage = error instanceof Error ? error.message : ''
    const message = /^[A-Za-z0-9_:.-]{1,80}$/.test(rawMessage) ? rawMessage : 'UNKNOWN_CLEANUP_ERROR'
    console.error('ELECTRON_TEST_CLEANUP_FAILURE', message)
  }
): Promise<T> {
  let value!: T
  let primaryFailure: unknown
  let hasPrimaryFailure = false
  try { value = await body() } catch (error) { primaryFailure = error; hasPrimaryFailure = true }

  let cleanupFailure: unknown
  let hasCleanupFailure = false
  try { await cleanup() } catch (error) { cleanupFailure = error; hasCleanupFailure = true }
  const markCleanupFailure = (error: unknown): void => {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return
    try {
      Object.defineProperty(error, 'electronTestCleanupFailed', { value: true, configurable: true })
    } catch { /* preserve the original thrown value even when it is immutable */ }
  }
  if (hasCleanupFailure) {
    try { reportCleanupFailure(cleanupFailure) } catch { /* reporting cannot replace either test outcome */ }
    if (!hasPrimaryFailure) {
      markCleanupFailure(cleanupFailure)
      throw cleanupFailure
    }
    markCleanupFailure(primaryFailure)
  }
  if (hasPrimaryFailure) throw primaryFailure
  return value
}

/** A failed cleanup must make the test harness exit even if an orphaned Playwright handle remains. */
export function hasElectronTestCleanupFailure(error: unknown): boolean {
  return Boolean(error && (typeof error === 'object' || typeof error === 'function') &&
    (error as { electronTestCleanupFailed?: unknown }).electronTestCleanupFailed === true)
}

/** Exit only the automation process after a failed bounded teardown; never signals the Electron child. */
export function terminateElectronTestHarnessAfterCleanupFailure(error: unknown,
  exit: (code: number) => never = code => process.exit(code)): void {
  if (hasElectronTestCleanupFailure(error)) exit(1)
}

function waitForProcessExit(app: any, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const child = app.process()
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error('ELECTRON_TEST_NORMAL_EXIT_TIMEOUT'))
    }, timeoutMs)
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    child.once('exit', onExit)
  })
}

async function waitForExitAndReleaseAutomation(app: any, timeoutMs: number): Promise<void> {
  let exit: { code: number | null; signal: NodeJS.Signals | null }
  try {
    exit = await waitForProcessExit(app, timeoutMs)
  } catch (error) {
    // Drop only the test automation connection after its deadline. The Electron app is left alive for inspection;
    // the Windows runner's residual-process gate will fail and preserve its profile instead of killing the app.
    const child = app.process()
    child.unref()
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.()
    // ElectronApplication.close() invokes the same app.quit path and waits for the Electron process to exit.
    // After the normal UI exit already timed out, calling it again can leave the test harness waiting forever.
    // Callers must report cleanup failure and end only the harness; never force-kill the product to get PASS.
    throw error
  }
  await withElectronTestDeadline(app.close(), 'playwright-app-close', 5_000)
  if (exit.signal !== null || exit.code !== 0) {
    throw new Error(`ELECTRON_TEST_NORMAL_EXIT_FAILED:${exit.code ?? 'null'}:${exit.signal ?? 'none'}`)
  }
}

/** Close a test app through app.quit; Player confirmation is answered through its real UI. */
export async function closeElectronTestAppNormally(
  app: any, role: 'player' | 'management', timeoutMs = 30_000
): Promise<void> {
  const page = await withElectronTestDeadline(app.firstWindow(), `${role}:first-window`, 5_000).catch(() => undefined)
  if (role === 'management') {
    // Keep the real close coordinator in the path. A test profile may have an open
    // session, so answer its normal native prompt through Electron's test dialog port.
    await withElectronTestDeadline(app.evaluate(({ dialog }: any) => {
      const original = dialog.showMessageBox
      dialog.showMessageBox = function (...args: any[]) {
        const options = args[args.length - 1]
        const response = options?.buttons?.indexOf('Sair sem encerrar sessão') ?? -1
        if (response >= 0) {
          dialog.__kqManagementCloseChoice = response
          return Promise.resolve({ response, checkboxChecked: false })
        }
        return original.apply(this, args)
      }
    }), 'management:install-session-preserving-close-port', 5_000)
    await withElectronTestDeadline(app.evaluate(({ app: electronApp }: any) => electronApp.quit()),
      'management:request-normal-exit', 5_000).catch(() => undefined)
    await waitForExitAndReleaseAutomation(app, timeoutMs)
    return
  }

  await withElectronTestDeadline(app.evaluate(({ app: electronApp }: any) => electronApp.quit()),
    'player:request-normal-exit', 5_000).catch(() => undefined)

  if (page) {
    const confirmation = page.locator('#standalone-exit-confirmation')
    try { await confirmation.waitFor({ state: 'visible', timeout: 10_000 }) } catch { /* startup failure can quit directly */ }
    if (await confirmation.isVisible().catch(() => false)) {
      await page.locator('#exit-confirmation-confirm').click({ timeout: 10_000 })
    }
  }

  await waitForExitAndReleaseAutomation(app, timeoutMs)
}
