// Regression reproducer for independent audit findings A1-A3; assertions confirm the corrected contracts.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { RemoteReconnectionService } = require('../build/src/remote-reconnection-service')
const { RemoteControlIntentStore, REMOTE_CONTROL_INTENT_DATABASE_FILENAME } = require('../build/src/remote-control-intent')
async function main() {
  const callbacks = new Map(); let next = 0; let release, reached
  const atSecondAuthorization = new Promise(r => { reached = r })
  const gate = new Promise(r => { release = r })
  const peer = { playerId:'player-1', fingerprintSha256:'a'.repeat(64), serverName:'player.local', port:12345,
    lastAddress:'192.168.1.2', active:true, credentialGeneration:1 }
  let checks = 0, closes = 0
  const service = new RemoteReconnectionService({
    async connect() { return { ...peer, connectionId:'old', close(){ closes++ } } },
    async reconcile() { return {state:'synchronized'} },
    async isAuthorizationCurrent() { if (++checks === 2) { reached(); await gate } return true }
  }, { now:()=>0, random:()=>0.5, setTimer(cb){const id=++next;callbacks.set(id,cb);return id}, clearTimer(id){callbacks.delete(id)} })
  await service.start([peer]); for(const cb of [...callbacks.values()]) cb(); callbacks.clear()
  await atSecondAuthorization
  await service.disable()
  assert.equal(service.status(peer.playerId).state,'disabled')
  release(); for(let i=0;i<5;i++) await new Promise(r=>setImmediate(r))
  assert.equal(service.status(peer.playerId).state,'disabled')
  assert.equal(service.status(peer.playerId).connectionId,null)
  assert.equal(closes,1)
  console.log('A1 FIXED: late authorization cannot promote disabled/closed channel')
  await service.close()
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'g4-audit-'))
  try {
    const store=new RemoteControlIntentStore(directory)
    await store.set('offline', (await store.read()).revision)
    await fs.writeFile(path.join(directory,'remote-player-identity.json'),'{}')
    await fs.unlink(path.join(directory,REMOTE_CONTROL_INTENT_DATABASE_FILENAME))
    assert.equal((await new RemoteControlIntentStore(directory).read()).intent,'recovery_required')
    console.log('A2 FIXED: initialized offline database loss stays recovery_required with G2 identity evidence')
    await store.set('offline', (await store.read()).revision); await fs.truncate(path.join(directory,REMOTE_CONTROL_INTENT_DATABASE_FILENAME),0)
    await assert.rejects(new RemoteControlIntentStore(directory).read(),/REMOTE_CONTROL_INTENT_DATABASE_INVALID/)
    console.log('A2 FIXED: truncated initialized database is preserved and rejected')
    await fs.unlink(path.join(directory,REMOTE_CONTROL_INTENT_DATABASE_FILENAME))
    await store.set('offline', null)
    await fs.writeFile(path.join(directory,'remote-control-intent.json'),JSON.stringify({version:1,intent:'enabled',revision:1}))
    await fs.unlink(path.join(directory,REMOTE_CONTROL_INTENT_DATABASE_FILENAME))
    assert.equal((await new RemoteControlIntentStore(directory).read()).intent,'recovery_required')
    console.log('A2 FIXED: lost offline database cannot reimport stale legacy enabled intent')
  } finally { await fs.rm(directory,{recursive:true,force:true}) }
  const { createKaraokeDatabase } = require('../build/database')
  const { ManagementRemoteJournalInbox } = require('../build/src/management-remote-journal')
  const { ManagementRemoteOutbox } = require('../build/src/management-remote-outbox')
  const { ManagementRemoteReconciliationService } = require('../build/src/remote-reconciliation-service')
  const fixture = require('../tests/fixtures/operational-v1/valid-messages.json')
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'g4-audit-inbox-'))
  const db=createKaraokeDatabase(dir), controllerId='controller-local-01', playerDeviceId='device-player-01'
  const inbox=new ManagementRemoteJournalInbox(db,{controllerId})
  const outbox=new ManagementRemoteOutbox(db,{deviceId:controllerId,controllerId})
  const abort=new AbortController();let calls=0
  try {
    const reconciler=new ManagementRemoteReconciliationService(inbox,outbox,{controllerId,playerDeviceId},{async query(request){
      const msg=structuredClone(fixture.find(m=>m.kind==='response' && m.body.type==='snapshot'))
      msg.deviceId=playerDeviceId;msg.controllerId=controllerId;msg.body.correlationId=request.body.queryId
      msg.body.payload.highWatermark=0;msg.body.payload.compactedThrough=0
      if(++calls===2) abort.abort()
      return msg
    }})
    await assert.rejects(reconciler.reconcile(abort.signal),/G4_RECOVERY_CANCELLED/)
    assert.equal(abort.signal.aborted,true)
    assert.equal(db.remoteJournal.getLatestSnapshot(playerDeviceId,controllerId),null)
    console.log('A3 FIXED: cancelled fresh snapshot is not persisted and cannot return synchronized')
  } finally {db.close();await fs.rm(dir,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
