import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countVisibleCharacters,
  DEFAULT_SIDEBAR_DISPLAY_NAME,
  normalizeSidebarDisplayName,
  sanitizeSidebarDisplayNameInput,
  validateSidebarDisplayName
} from '../src/ui/sidebar-display-name'

test('counts grapheme clusters including composed and decomposed accented letters', () => {
  assert.equal(countVisibleCharacters('e\u0301Á漢字'), 4)
  assert.equal(countVisibleCharacters('Karaoke Queue'), 13)
})

test('allows letters, numbers, accents and spaces, trims edges, and caps at 17 visible characters', () => {
  assert.equal(normalizeSidebarDisplayName('  Bar do João  '), 'Bar do João')
  assert.equal(normalizeSidebarDisplayName('Jose\u0301 123 東京'), 'José 123 東京')
  assert.equal(countVisibleCharacters(sanitizeSidebarDisplayNameInput('漢'.repeat(25))), 17)
  assert.equal(sanitizeSidebarDisplayNameInput('Bar! @João'), 'Bar João')
})

test('rejects blank names, invalid symbols and values over the visible character limit', () => {
  assert.throws(() => validateSidebarDisplayName('   '))
  assert.throws(() => validateSidebarDisplayName('Bar!'))
  assert.throws(() => validateSidebarDisplayName('漢'.repeat(18)))
  assert.equal(normalizeSidebarDisplayName('   '), '')
  assert.equal(DEFAULT_SIDEBAR_DISPLAY_NAME, 'Karaoke Queue')
})
