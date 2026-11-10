import test from 'node:test'
import assert from 'node:assert/strict'
import { InstallationRuntimeGate, type RuntimeGateNative } from '../src/installation-runtime-gate'

function nativeFor(acquire: RuntimeGateNative['acquireRuntime'] = () => ({ status: 'acquired', code: 0 })) {
  const calls: string[] = []
  const native: RuntimeGateNative = {
    acquireRuntime: () => { calls.push('acquire'); return acquire() },
    releaseRuntime: () => { calls.push('release'); return { status: 'released', code: 0 } }
  }
  return { native, calls }
}

test('runtime gate owns and releases the fixed mutex exactly once', () => {
  const { native, calls } = nativeFor()
  const gate = InstallationRuntimeGate.acquire(native)
  gate.release()
  gate.release()
  assert.deepEqual(calls, ['acquire', 'release'])
})

test('busy, abandoned, and failed native states never create a runtime lease', () => {
  for (const result of [
    { status: 'busy', code: 170 },
    { status: 'abandoned', code: 735 },
    { status: 'acl_error', code: 1338 }
  ]) {
    const { native, calls } = nativeFor(() => result)
    assert.throws(() => InstallationRuntimeGate.acquire(native), /INSTALLATION_RUNTIME_(?:RECOVERY_REQUIRED|LOCK_)/)
    assert.deepEqual(calls, ['acquire'])
  }
})

test('runtime release failure remains observable and is not reported as released', () => {
  const native = nativeFor().native
  native.releaseRuntime = () => ({ status: 'wrong_thread', code: 1444 })
  const gate = InstallationRuntimeGate.acquire(native)
  assert.throws(() => gate.release(), /RUNTIME_RELEASE_WRONG_THREAD:1444/)
})
