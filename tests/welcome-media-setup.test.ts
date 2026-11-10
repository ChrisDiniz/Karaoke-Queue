import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WelcomeMediaSetup } from '../src/welcome-media-setup'
import { createKaraokeDatabase, createPlayerMusicCatalogDatabase } from '../database'

for (const role of ['player', 'combined'] as const) test(`Welcome ${role}: real indexing, partial CSV, paging, cancel, atomic confirmation and restart`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-welcome-media-'))
  const roots = path.join(directory, 'videos'); fs.mkdirSync(roots)
  fs.writeFileSync(path.join(roots, '01001.mp4'), 'inventory fixture; playback not claimed')
  const states: string[] = []
  let setup = new WelcomeMediaSetup(directory, role, state => states.push(state.library.scanStatus))
  try {
    await setup.applyLibrary(roots)
    assert.deepEqual(states, ['scanning', 'ready'])
    assert.equal(setup.snapshot().library.counts.indexedFiles, 1)
    const valid = path.join(directory, 'valid.csv'); fs.writeFileSync(valid, 'numero;artista;nome_musica\n1001;Artista;Título\n')
    const partial = path.join(directory, 'partial.csv')
    fs.writeFileSync(partial, 'numero;artista;nome_musica\n1002;Outro;Título\n'+Array.from({length:61},(_,i)=>`bad${i};A;T`).join('\n'))
    assert.equal((await setup.prepareCatalog(valid)).outcome, 'imported')
    let prepared = await setup.prepareCatalog(partial)
    assert.equal(prepared.outcome, 'confirmation-required')
    if (prepared.outcome !== 'confirmation-required') throw Error('confirmation missing')
    assert.equal(prepared.issueCount, 61)
    assert.equal(setup.issues(0).issues.length, 50)
    assert.equal(setup.issues(50).issues.length, 11)
    assert.throws(() => setup.issues(-1))
    setup.cancelCatalog(prepared.token)
    prepared = await setup.prepareCatalog(partial)
    if (prepared.outcome !== 'confirmation-required') throw Error('confirmation missing')
    await assert.rejects(setup.confirmCatalog('wrong-token'))
    const confirmed = await setup.confirmCatalog(prepared.token)
    assert.equal(confirmed.recordCount, 1); assert.equal(confirmed.issueCount, 61)
    assert.equal(setup.issues(0).total, 61)
    await setup.close()
    const db = role === 'player' ? createPlayerMusicCatalogDatabase(directory) : createKaraokeDatabase(directory)
    assert.equal(db.getMusicCatalogMetadata().recordCount, 1)
    assert.equal(db.getMusicCatalogRecordByVideoCode('01002').record?.artist, 'Outro')
    db.close()
    setup = new WelcomeMediaSetup(directory, role, () => {})
    const corrupt = path.join(directory, 'bad.csv'); fs.writeFileSync(corrupt, 'wrong,header\nx,y\n')
    await assert.rejects(setup.prepareCatalog(corrupt))
  } finally { await setup.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('Combined partial import refuses a stale catalog revision and preserves the other writer', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-welcome-cas-'))
  const setup = new WelcomeMediaSetup(directory, 'combined', () => {})
  try {
    const original = path.join(directory,'original.csv'); fs.writeFileSync(original,'numero;artista;nome_musica\n1001;Original;Title\n')
    const partial = path.join(directory,'partial.csv'); fs.writeFileSync(partial,'numero;artista;nome_musica\n1002;Candidate;Title\ninvalid;Bad;Title\n')
    await setup.prepareCatalog(original)
    const prepared = await setup.prepareCatalog(partial)
    if (prepared.outcome !== 'confirmation-required') assert.fail('confirmation missing')
    const { MusicCatalogService } = await import('../src/music-catalog-service')
    const second = createKaraokeDatabase(directory); const service = new MusicCatalogService(second)
    const newer = path.join(directory,'newer.csv'); fs.writeFileSync(newer,'numero;artista;nome_musica\n1001;Newer;Title\n')
    await service.importFile(newer)
    await assert.rejects(setup.confirmCatalog(prepared.token), /CATALOG_CHANGED|catálogo|catalog/i)
    assert.equal(second.getMusicCatalogRecordByVideoCode('01001').record?.artist,'Newer')
    assert.equal(second.getMusicCatalogRecordByVideoCode('01002').record,null)
    await service.close(); second.close()
  } finally { await setup.close(); fs.rmSync(directory,{recursive:true,force:true}) }
})
