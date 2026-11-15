// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForPageCondition } from './async-page-polling'

test('async page polling keeps waiting after false and resolves only after the condition becomes true', async () => {
  let predicateCalls = 0
  const pauses: number[] = []
  const page = {
    async evaluate(predicate: (arg: unknown) => Promise<boolean>, arg: unknown) {
      return predicate(arg)
    },
    async waitForTimeout(milliseconds: number) { pauses.push(milliseconds) }
  }
  const result = await waitForPageCondition(page,
    async () => ++predicateCalls >= 4,
    undefined,
    { timeout: 1000, pollingInterval: 5, label: 'regression' })
  assert.equal(result, true)
  assert.equal(predicateCalls, 4)
  assert.equal(pauses.length, 3)
})

test('async page polling times out while the source remains false', async () => {
  let evaluations = 0
  const page = {
    async evaluate() { evaluations++; return false },
    async waitForTimeout() {}
  }
  await assert.rejects(waitForPageCondition(page, async () => false, undefined,
    { timeout: 5, pollingInterval: 1, label: 'stuck-backoff' }), /ASYNC_PAGE_CONDITION_TIMEOUT:stuck-backoff/)
  assert.ok(evaluations > 1)
})
