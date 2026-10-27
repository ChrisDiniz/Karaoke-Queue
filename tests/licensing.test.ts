import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalLicenseService } from '../src/license-service'
import { calculateLicenseStatus, DAY_MS, normalizeActivationToken, trialLabel, TRIAL_DURATION_MS } from '../src/licensing'

const VALID_TOKEN = 'YU3ZYVR88H4DRH2KLW43'

function profile(): { directory: string; file: string; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-license-'))
  return { directory, file: path.join(directory, 'license-state.json'), cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

test('trial starts once for 15 exact days and does not use the legacy 30-day marker', () => {
  const temp = profile()
  let now = Date.UTC(2026, 9, 27, 12)
  try {
    const service = new LocalLicenseService(temp.file, { now: () => now })
    assert.deepEqual(service.getStatus(), { activated: false, expired: false, remainingMs: TRIAL_DURATION_MS, checkedAt: now })
    now += DAY_MS
    assert.equal(service.getStatus().remainingMs, 14 * DAY_MS)
    now += 13 * DAY_MS
    assert.equal(service.getStatus().remainingMs, DAY_MS)
    assert.equal(service.getStatus().expired, false)
    now += DAY_MS - 1
    assert.equal(service.getStatus().expired, false)
    assert.equal(service.getStatus().remainingMs, 1)
    assert.equal(trialLabel(service.getStatus()), 'Teste · Menos de 1 dia')
    now += 1
    assert.equal(service.getStatus().expired, true, 'expiry is exactly 360 hours')
    assert.equal(trialLabel(service.getStatus()), 'Teste expirado')
  } finally { temp.cleanup() }
})

test('restarting the service does not reset the first-run timestamp or trial duration', () => {
  const temp = profile()
  let now = 50_000
  try {
    new LocalLicenseService(temp.file, { now: () => now })
    now += 14 * DAY_MS
    const restarted = new LocalLicenseService(temp.file, { now: () => now })
    assert.equal(restarted.getStatus().remainingMs, DAY_MS)
    const persisted = JSON.parse(fs.readFileSync(temp.file, 'utf8'))
    assert.equal(persisted.trialStartedAt, 50_000)
    assert.equal(persisted.policyVersion, 1)
  } finally { temp.cleanup() }
})

test('trial status calculation clamps clock rollback without expiring early', () => {
  assert.equal(calculateLicenseStatus(1000, false, 0).remainingMs, TRIAL_DURATION_MS)
  assert.equal(calculateLicenseStatus(0, false, 14 * DAY_MS + 1).remainingMs, DAY_MS - 1)
})

test('token normalization trims outer whitespace and converts to uppercase only', () => {
  assert.equal(normalizeActivationToken(`  ${VALID_TOKEN.toLowerCase()}  `), VALID_TOKEN)
  assert.equal(normalizeActivationToken(`${VALID_TOKEN.slice(0, 10)} ${VALID_TOKEN.slice(10)}`).includes(' '), true)
})

test('correct token activates persistently; the former password, empty, partial and invalid tokens do not', () => {
  const temp = profile()
  let now = 2_000
  try {
    const service = new LocalLicenseService(temp.file, { now: () => now })
    for (const invalid of ['', 'karaokequeue', VALID_TOKEN.slice(0, -1), 'A'.repeat(20)]) {
      assert.throws(() => service.activate(invalid), /INVALID_ACTIVATION_TOKEN/)
      assert.equal(service.getStatus().activated, false)
    }
    now += TRIAL_DURATION_MS + 500
    assert.equal(service.getStatus().expired, true)
    const activated = service.activate(`  ${VALID_TOKEN.toLowerCase()} `)
    assert.equal(activated.activated, true)
    assert.equal(activated.expired, false)
    assert.equal(service.isOperationallyAllowed(), true)
    const restarted = new LocalLicenseService(temp.file, { now: () => now + 1000 })
    assert.equal(restarted.getStatus().activated, true)
    assert.equal(restarted.getStatus().expired, false)
  } finally { temp.cleanup() }
})

test('failed activation persistence does not publish an activated state', () => {
  const temp = profile()
  let now = 0
  let rejectWrites = false
  try {
    const service = new LocalLicenseService(temp.file, {
      now: () => now,
      writeAtomic(filePath, value) {
        if (rejectWrites) throw new Error('injected write failure')
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, JSON.stringify(value))
      }
    })
    now = TRIAL_DURATION_MS
    rejectWrites = true
    assert.throws(() => service.activate(VALID_TOKEN), /injected write failure/)
    assert.equal(service.getStatus().activated, false)
    assert.equal(service.getStatus().expired, true)
    assert.equal(service.isOperationallyAllowed(), false)
  } finally { temp.cleanup() }
})

test('invalid persisted policy refuses to reset or silently restart the trial', () => {
  const temp = profile()
  try {
    fs.writeFileSync(temp.file, JSON.stringify({ policyVersion: 99, trialStartedAt: 0, activated: false }))
    assert.throws(() => new LocalLicenseService(temp.file, { now: () => 100 }), /refusing to restart the trial/)
  } finally { temp.cleanup() }
})
