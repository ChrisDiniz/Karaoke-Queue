import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { completeInitialWelcomeSetup, readWelcomeSetupState, requiresInitialWelcomeSetup, WELCOME_SETUP_FILENAME } from '../src/welcome-setup'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-welcome-setup-'))
  const userData = path.join(root, 'user-data')
  fs.mkdirSync(userData)
  return { root, userData, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('fresh profile enters setup, can defer, and records completion once', async () => {
  const f = fixture()
  try {
    assert.equal(requiresInitialWelcomeSetup(f.userData), true)
    await completeInitialWelcomeSetup(f.userData, 'player', {})
    assert.deepEqual(readWelcomeSetupState(f.userData), { version: 1, status: 'complete' })
    assert.equal(requiresInitialWelcomeSetup(f.userData), false)
    await completeInitialWelcomeSetup(f.userData, 'combined', { libraryRoot: path.join(f.root, 'missing') })
    assert.equal(fs.existsSync(path.join(f.userData, 'video-library.json')), false)
  } finally { f.cleanup() }
})

test('legacy profiles skip first-use setup without modifying their files', () => {
  const f = fixture()
  try {
    const legacy = path.join(f.userData, 'operating-mode.json')
    const original = Buffer.from('{"version":1,"mode":"controller"}\n')
    fs.writeFileSync(legacy, original)
    assert.equal(requiresInitialWelcomeSetup(f.userData), false)
    assert.deepEqual(fs.readFileSync(legacy), original)
    assert.equal(fs.existsSync(path.join(f.userData, WELCOME_SETUP_FILENAME)), false)
  } finally { f.cleanup() }
})

test('selected library path must be a readable existing directory and config is committed before completion', async () => {
  const f = fixture()
  try {
    const media = path.join(f.root, 'media')
    fs.mkdirSync(media)
    await completeInitialWelcomeSetup(f.userData, 'combined', { libraryRoot: media })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.userData, 'video-library.json'), 'utf8')),
      { version: 1, roots: [media] })
    assert.equal(readWelcomeSetupState(f.userData)?.status, 'complete')
  } finally { f.cleanup() }
})

test('catalog import uses the role-owned real SQLite catalog and invalid CSV leaves setup pending', async () => {
  const f = fixture()
  try {
    const csv = path.join(f.root, 'catalog.csv')
    fs.writeFileSync(csv, 'numero;artista;nome_musica\n123;Artista;Musica\n')
    await completeInitialWelcomeSetup(f.userData, 'player', { catalogFile: csv })
    const dbPath = path.join(f.userData, 'player-music-catalog.sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try { assert.equal(db.prepare('SELECT count(*) AS count FROM music_catalog').get()?.count, 1) }
    finally { db.close() }

    const g = fixture()
    try {
      fs.writeFileSync(csv, 'not,a,valid,catalog\n')
      await assert.rejects(completeInitialWelcomeSetup(g.userData, 'combined', { catalogFile: csv }))
      assert.equal(readWelcomeSetupState(g.userData)?.status, 'pending')
      assert.equal(requiresInitialWelcomeSetup(g.userData), true)
      assert.equal(fs.existsSync(path.join(g.userData, 'karaoke.sqlite')), true)
    } finally { g.cleanup() }
  } finally { f.cleanup() }
})

test('corrupt setup marker fails closed instead of repeating onboarding silently', () => {
  const f = fixture()
  try {
    fs.writeFileSync(path.join(f.userData, WELCOME_SETUP_FILENAME), '{invalid')
    assert.throws(() => requiresInitialWelcomeSetup(f.userData), /WELCOME_SETUP_STATE_INVALID/)
  } finally { f.cleanup() }
})
