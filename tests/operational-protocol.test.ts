import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { OPERATIONAL_LIMITS as L } from '../src/operational-protocol-contracts'
import { parseOperationalMessage, parseOperationalMessageObject, validateOperationalMessage } from '../src/operational-protocol-validation'

const fixtureDir=path.join(process.cwd(),'tests','fixtures','operational-v1')
const valid=JSON.parse(fs.readFileSync(path.join(fixtureDir,'valid-messages.json'),'utf8')) as unknown[]
test('versioned fixtures parse and validate for every protocol kind and event',()=>{
 assert.ok(valid.length>=25)
 for(const message of valid){validateOperationalMessage(message);assert.deepEqual(parseOperationalMessage(JSON.stringify(message)),message)}
 const kinds=new Set(valid.map((v:any)=>v.kind));assert.deepEqual([...kinds].sort(),['ack','command','error','event','hello','query','ready','response'])
})
test('negative versioned fixtures reject their intended variants',()=>{
 const cases=JSON.parse(fs.readFileSync(path.join(fixtureDir,'invalid-messages.json'),'utf8')) as Array<{name:string;message:unknown;error?:string}>
 assert.ok(cases.length>=7)
 for(const fixture of cases){assert.throws(()=>parseOperationalMessage(JSON.stringify(fixture.message)),new RegExp(fixture.error??'OPERATIONAL_MESSAGE_INVALID'),fixture.name)}
})
test('accepts opaque persisted IDs, legacy queue IDs, leading zero music codes and UTF-8 text',()=>{
 const activate=valid.find((m:any)=>m.kind==='command'&&m.body.type==='activate-turn')!
 assert.equal(parseOperationalMessageObject(activate).body!==undefined,true)
 assert.equal((activate as any).body.target.turnId,'LOG-1762900000000-AB12')
 assert.equal((activate as any).body.payload.tracks[0].musicCode,'01001')
})
test('snapshot acceptedTurn reuses the closed one-or-two-track package contract',()=>{
 const base=structuredClone(valid.find((m:any)=>m.kind==='response'&&m.body.type==='snapshot')!) as any
 const track={occurrenceId:'occ-1',trackIndex:1,musicCode:'01001'}
 base.body.payload.acceptedTurn={sessionId:'session-1',turnId:'turn-1',packageRevision:2,tracks:[track]}
 assert.doesNotThrow(()=>parseOperationalMessageObject(base))
 base.body.payload.acceptedTurn.tracks.push({occurrenceId:'occ-2',trackIndex:2,musicCode:'00042'})
 assert.doesNotThrow(()=>parseOperationalMessageObject(base))
 const invalidCases=[
  [null],
  [{occurrenceId:'occ-1',trackIndex:1}],
  [{occurrenceId:'occ-1',trackIndex:1,musicCode:1001}],
  [{occurrenceId:'occ-1',trackIndex:2,musicCode:'01001'}],
  [{occurrenceId:'occ-1',trackIndex:1,musicCode:'01001',extra:true}],
  [{occurrenceId:'occ-1',trackIndex:1,musicCode:'01001'},{occurrenceId:'occ-1',trackIndex:2,musicCode:'00042'}],
  [{occurrenceId:'occ-1',trackIndex:1,musicCode:'01001'},{occurrenceId:'occ-2',trackIndex:1,musicCode:'00042'}],
  [{occurrenceId:'occ-1',trackIndex:1,musicCode:'01001'},{occurrenceId:'occ-2',trackIndex:2,musicCode:'00042'},{occurrenceId:'occ-3',trackIndex:3,musicCode:'00003'}]
 ]
 for(const tracks of invalidCases){const candidate=structuredClone(base);candidate.body.payload.acceptedTurn.tracks=tracks;assert.throws(()=>parseOperationalMessageObject(candidate),/OPERATIONAL_MESSAGE_INVALID/)}
})
test('rejects unknown fields, malformed targets, commands and musical codes',()=>{
 const base=JSON.parse(JSON.stringify(valid.find((m:any)=>m.kind==='command'&&m.body.type==='pause')))
 for(const mutate of [
  (x:any)=>x.unexpected=true,
  (x:any)=>x.body.target.occurrenceId=undefined,
  (x:any)=>x.body.type='toggle',
  (x:any)=>x.body.payload={unexpected:true},
 ]){const x=JSON.parse(JSON.stringify(base));mutate(x);assert.throws(()=>validateOperationalMessage(x),/OPERATIONAL_MESSAGE_INVALID/)}
 const activation=JSON.parse(JSON.stringify(valid.find((m:any)=>m.kind==='command'&&m.body.type==='activate-turn')))
 activation.body.payload.tracks[0].musicCode='1001';assert.throws(()=>validateOperationalMessage(activation),/OPERATIONAL_MESSAGE_INVALID/)
})
test('rejects incompatible versions, unsafe numbers, extra event fields and oversized arrays',()=>{
 const hello=JSON.parse(JSON.stringify(valid[0]));hello.protocolVersion=2;assert.throws(()=>validateOperationalMessage(hello),/OPERATIONAL_VERSION_UNSUPPORTED/)
 const query=JSON.parse(JSON.stringify(valid.find((m:any)=>m.kind==='query'&&m.body.type==='journal-page')));query.body.payload.limit=Number.MAX_SAFE_INTEGER+1;assert.throws(()=>validateOperationalMessage(query),/OPERATIONAL_MESSAGE_INVALID/)
 const event=JSON.parse(JSON.stringify(valid.find((m:any)=>m.kind==='event')));event.body.extra='x';assert.throws(()=>validateOperationalMessage(event),/OPERATIONAL_MESSAGE_INVALID/)
 const page=JSON.parse(JSON.stringify(valid.find((m:any)=>m.kind==='response'&&m.body.type==='journal-page')));page.body.payload.events=Array.from({length:L.maxPageEvents+1},()=>page.body.payload.events[0]);assert.throws(()=>validateOperationalMessage(page),/OPERATIONAL_MESSAGE_INVALID/)
})
test('operation-status not-found carries no invented command fingerprint',()=>{
 const message={protocolVersion:1,schemaVersion:1,kind:'response',messageId:'missing-response',deviceId:'device-player-01',
  controllerId:'controller-local-01',body:{correlationId:'query-missing',type:'operation-status',payload:{operationId:'not-created',
   fingerprint:null,status:'not-found',result:null,eventSequence:null}}}
 assert.doesNotThrow(()=>parseOperationalMessageObject(message))
 const invalid=structuredClone(message);(invalid.body.payload as any).fingerprint='0'.repeat(64)
 assert.throws(()=>parseOperationalMessageObject(invalid),/OPERATIONAL_MESSAGE_INVALID/)
})
test('measures UTF-8 bytes and rejects dangerous keys and excessive depth',()=>{
 const msg=JSON.parse(JSON.stringify(valid[2]));msg.body.payload.singerName='ê'.repeat(257);assert.throws(()=>validateOperationalMessage(msg),/OPERATIONAL_MESSAGE_INVALID/)
 for(const key of ['__proto__','constructor']){const x=JSON.parse(JSON.stringify(valid[0]));Object.defineProperty(x.body,key,{value:'bad',enumerable:true});assert.throws(()=>validateOperationalMessage(x),/OPERATIONAL_MESSAGE_INVALID/)}
 let nested:any={};for(let i=0;i<L.maxDepth+2;i++)nested={x:nested};const x=JSON.parse(JSON.stringify(valid[0]));x.body.extra=nested;assert.throws(()=>validateOperationalMessage(x),/OPERATIONAL_MESSAGE_INVALID/)
})
test('raw parser rejects duplicate keys before JSON.parse and rejects malformed raw JSON',()=>{
 const raw=fs.readFileSync(path.join(fixtureDir,'duplicate-keys.json.txt'),'utf8').trim()
 assert.throws(()=>parseOperationalMessage(raw),/OPERATIONAL_MESSAGE_INVALID/)
 assert.throws(()=>parseOperationalMessage('{'),/OPERATIONAL_MESSAGE_INVALID/)
 const escapedDuplicate='{"protocolVersion":1,"schemaVersion":1,"kind":"hello","messageId":"m","deviceId":"d","controllerId":"c","body":{"protocol":"kq-operation/1","protocolVersion":1,"schemaVersion":1,"\\u0070rotocol":"kq-operation/1"}}'
 assert.throws(()=>parseOperationalMessage(escapedDuplicate),/OPERATIONAL_MESSAGE_INVALID/)
})
test('rejects invalid UTF-8 and byte-bounded oversized wire messages',()=>{
 assert.throws(()=>parseOperationalMessage(Buffer.from([0xc3,0x28])),/OPERATIONAL_MESSAGE_INVALID/)
 assert.throws(()=>parseOperationalMessage('😀'.repeat(Math.ceil(L.maxEnvelopeBytes/4)+1)),/OPERATIONAL_MESSAGE_TOO_LARGE/)
 assert.throws(()=>parseOperationalMessage(fs.readFileSync(path.join(fixtureDir,'oversized-utf8.json.txt'))),/OPERATIONAL_MESSAGE_TOO_LARGE/)
})
