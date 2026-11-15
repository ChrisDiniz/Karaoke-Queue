// @ts-nocheck
/** Poll a page predicate whose evaluation itself is asynchronous. */
export async function waitForPageCondition(page: any, predicate: (arg: any) => Promise<any>, arg: any,
  options: { timeout?: number; pollingInterval?: number; label?: string } = {}): Promise<any> {
  const timeout = options.timeout ?? 30_000
  const pollingInterval = options.pollingInterval ?? 50
  const deadline = performance.now() + timeout
  while (true) {
    const result = await page.evaluate(predicate, arg)
    if (result) return result
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error(`ASYNC_PAGE_CONDITION_TIMEOUT:${options.label ?? 'condition'}`)
    await page.waitForTimeout(Math.min(pollingInterval, remaining))
  }
}
