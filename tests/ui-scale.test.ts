import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createUiScaleState,
  getUiScaleFactor,
  normalizeUiScalePreference,
  resolveUiScaleFactor
} from '../src/ui/ui-scale'
import { formatQueueDateTime, formatQueueWait } from '../src/ui/dom'

test('uses the requested scale for standard, QHD and UHD logical viewports', () => {
  assert.equal(getUiScaleFactor(1366, 768), 1)
  assert.equal(getUiScaleFactor(1920, 1080), 1)
  assert.equal(getUiScaleFactor(2560, 1440), 1.1)
  assert.equal(getUiScaleFactor(3840, 2160), 1.2)
})

test('requires sufficient height and does not scale a reduced desktop window', () => {
  assert.equal(getUiScaleFactor(960, 600), 1)
  assert.equal(getUiScaleFactor(2560, 1079), 1)
  assert.equal(getUiScaleFactor(3840, 1440), 1.1)
  assert.equal(getUiScaleFactor(3840, 1799), 1.1)
})

test('resolves manual preferences independently from the automatic factor', () => {
  assert.equal(resolveUiScaleFactor('auto', 1.1), 1.1)
  assert.equal(resolveUiScaleFactor('100', 1.2), 1)
  assert.equal(resolveUiScaleFactor('110', 1.2), 1.1)
  assert.equal(resolveUiScaleFactor('125', 1), 1.25)
  assert.equal(resolveUiScaleFactor('150', 1.2), 1.5)
  assert.deepEqual(createUiScaleState('125', 1.1), {
    preference: '125', automaticFactor: 1.1, effectiveFactor: 1.25
  })
})

test('normalizes unknown or corrupt persisted scale preferences to automatic', () => {
  assert.equal(normalizeUiScalePreference('150'), '150')
  assert.equal(normalizeUiScalePreference('75'), 'auto')
  assert.equal(normalizeUiScalePreference(null), 'auto')
})

test('formats queue request timestamps with local today/yesterday/date labels', () => {
  const now = new Date(2026, 4, 10, 18, 0, 0, 0).getTime()
  assert.match(formatQueueDateTime(new Date(2026, 4, 10, 17, 44).getTime(), now), /^Hoje · 17:44$/)
  assert.match(formatQueueDateTime(new Date(2026, 4, 9, 22, 45).getTime(), now), /^Ontem · 22:45$/)
  assert.match(formatQueueDateTime(new Date(2026, 4, 7, 8, 5).getTime(), now), /^07\/05\/26 · 08:05$/)
})

test('formats long wait without red-state language and keeps minutes stable', () => {
  const now = 3 * 60 * 60_000 + 17 * 60_000
  assert.equal(formatQueueWait(now - (18 * 60 + 57) * 60_000, now), 'há 18h57')
  assert.equal(formatQueueWait(now - 45 * 60_000, now), 'há 45min')
  assert.equal(formatQueueWait(now, now), 'agora')
})
