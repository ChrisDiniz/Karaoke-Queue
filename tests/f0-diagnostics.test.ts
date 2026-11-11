import test from 'node:test'
import assert from 'node:assert/strict'
import { f0DiagnosticMetrics } from '../src/f0-diagnostics'

test('F0 diagnostics are opt-in, share a run id, and use a monotonic process clock', () => {
  const previous = process.env.KQ_F0_DIAGNOSTICS
  try {
    delete process.env.KQ_F0_DIAGNOSTICS
    assert.equal(f0DiagnosticMetrics({ phase: 'should-not-log' }), undefined)

    process.env.KQ_F0_DIAGNOSTICS = '1'
    const first = f0DiagnosticMetrics({ phase: 'first' })
    const second = f0DiagnosticMetrics({ phase: 'second' })
    assert.ok(first)
    assert.ok(second)
    assert.match(first.runId, /^[0-9a-f-]{36}$/i)
    assert.equal(second.runId, first.runId)
    assert.equal(first.phase, 'first')
    assert.equal(second.phase, 'second')
    assert.ok(first.elapsedMs >= 0)
    assert.ok(second.elapsedMs >= first.elapsedMs)
    assert.equal(JSON.stringify(first).includes('path'), false)
    assert.equal(JSON.stringify(first).includes('musicCode'), false)
  } finally {
    if (previous === undefined) delete process.env.KQ_F0_DIAGNOSTICS
    else process.env.KQ_F0_DIAGNOSTICS = previous
  }
})
