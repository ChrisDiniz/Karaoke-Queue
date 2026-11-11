import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'

const processStartedAt = performance.now()
let runId: string | undefined

/** Returns sanitized, monotonic diagnostic fields only when the F0 opt-in is enabled. */
export function f0DiagnosticMetrics(details: Record<string, string | number | boolean> = {}):
  ({ runId: string; elapsedMs: number } & Record<string, string | number | boolean>) | undefined {
  if (process.env.KQ_F0_DIAGNOSTICS !== '1') return undefined
  runId ??= crypto.randomUUID()
  return { runId, elapsedMs: Math.max(0, performance.now() - processStartedAt), ...details }
}
