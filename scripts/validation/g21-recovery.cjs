// Protocol-model experiment: real child processes and fsync; not a production store.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(process.argv[2]);const E=(...xs)=>Buffer.concat(xs.map(x=>{const b=Buffer.isBuffer(x)?x:Buffer.from(String(x));const n=Buffer.alloc(4);n.writeUInt32BE(b.length);return Buffer.concat([n,b]);}));
const vector=JSON.parse(fs.readFileSync(path.join(root,'binding-vector.json')));const TH=Buffer.from(vector.TH,'hex');
const key=role=>Buffer.from(vector[role==='P'?'commitPlayer':'commitController'],'hex');
const mac=(role,type,prev)=>crypto.createHmac('sha256',key(role)).update(E('KQ-Pair-receipt','kq-pair/1',type,TH,Buffer.alloc(32,8),Buffer.alloc(32,2),'1','0','0',Buffer.alloc(32,9),prev)).digest('hex');
const D=crypto.createHash('sha256').update(E('KQ-Pair-record','kq-pair/1',TH,Buffer.alloc(32,8),Buffer.alloc(32,2),'1','0','0',Buffer.alloc(32,9))).digest();
const receipts=[];let prev=D;for(const [role,type]of [['P','prepare'],['C','prepared'],['P','committed'],['C','final'],['P','active']]){const tag=mac(role,type,prev);receipts.push({role,type,prev:prev.toString('hex'),tag});prev=crypto.createHash('sha256').update(E(type,Buffer.from(tag,'hex'))).digest();}
if(process.argv[3]==='child'){
 const dir=process.argv[4],role=process.argv[5],state=process.argv[6];const file=path.join(dir,role+'.json');let current=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
 const seq=role==='P'?['pending','committed','active','revoked']:['prepared','committed','active','revoked'];
 if(current&&current.state===state)process.exit(0);
 if(current&&seq.indexOf(state)<seq.indexOf(current.state))process.exit(3);
 if(current&&current.state==='revoked')process.exit(3);
 const out={state,generation:state==='revoked'?2:1,pairingId:'fixed-test-id',receipt:receipts.find(r=>r.type===(state==='pending'?'prepare':state==='prepared'?'prepared':state==='committed'?'committed':state))||null};
 const fd=fs.openSync(file+'.tmp','w',0o600);fs.writeFileSync(fd,JSON.stringify(out));fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(file+'.tmp',file);const d=fs.openSync(dir,'r');fs.fsyncSync(d);fs.closeSync(d);process.exit(0);
}
const stages=[['P','pending'],['C','prepared'],['P','committed'],['C','committed'],['P','active'],['C','active']];
const outcomes=[];
for(let cut=0;cut<=stages.length;cut++){
 const dir=fs.mkdtempSync(path.join(root,'crash-'));
 const call=([role,state])=>spawnSync(process.execPath,[__filename,root,'child',dir,role,state]);
 for(const stage of stages.slice(0,cut))assert.equal(call(stage).status,0);
 // Restart both peers as new processes; duplicate original intent and all later stages.
 for(const stage of stages.slice(Math.max(0,cut-1)))assert.equal(call(stage).status,0);
 for(const role of ['P','C'])assert.equal(JSON.parse(fs.readFileSync(path.join(dir,role+'.json'))).state,'active');
 assert.equal(call(['P','revoked']).status,0);assert.equal(call(['P','active']).status,3);
 outcomes.push(`restart/lost response after durable stage ${cut}: recovered; revoked cannot reactivate`);
}
// MAC negatives and cross-language HKDF reference check.
for(const r of receipts){assert.equal(mac(r.role,r.type,Buffer.from(r.prev,'hex')),r.tag);assert.notEqual(mac(r.role==='P'?'C':'P',r.type,Buffer.from(r.prev,'hex')),r.tag);assert.notEqual(mac(r.role,r.type,Buffer.alloc(32)),r.tag);}
const R=Buffer.from(vector.R,'hex');
const derive=label=>Buffer.from(crypto.hkdfSync('sha256',R,TH,E('KQ-Pair-v1',label),32));
const nonce=Buffer.alloc(32,13),pairing=Buffer.alloc(32,8),op=Buffer.alloc(32,2);
const reqFields=['KQ-Pair-recovery','kq-pair/1','query',TH,pairing,op,'1',nonce,'committed',crypto.createHash('sha256').update(E(receipts[2].type,Buffer.from(receipts[2].tag,'hex'))).digest()];
const queryBytes=E(...reqFields),query=crypto.createHmac('sha256',derive('recovery-controller')).update(queryBytes).digest();
const responseBytes=E('KQ-Pair-recovery','kq-pair/1','answer',TH,pairing,op,'1',nonce,'active',prev,E(...receipts.map(r=>E(r.type,Buffer.from(r.tag,'hex')))));
const answer=crypto.createHmac('sha256',derive('recovery-player')).update(responseBytes).digest();
assert.notDeepEqual(query,answer);
const altered=[...reqFields];altered[7]=Buffer.alloc(32,14);assert.notDeepEqual(crypto.createHmac('sha256',derive('recovery-controller')).update(E(...altered)).digest(),query);
assert.notDeepEqual(crypto.createHmac('sha256',derive('recovery-player')).update(queryBytes).digest(),query);
fs.writeFileSync(path.join(root,'recovery-vector.json'),JSON.stringify({queryBytes:queryBytes.toString('hex'),answerBytes:responseBytes.toString('hex'),query:query.toString('hex'),answer:answer.toString('hex')},null,2)+'\n');
fs.writeFileSync(path.join(root,'receipt-vector.json'),JSON.stringify({D:D.toString('hex'),receipts},null,2)+'\n');
console.log(JSON.stringify({tests:outcomes,receiptTamper:'PASS',recoveryNonceAndDirectionTamper:'PASS',limits:'model only: no production store, no OS keychain, no power-loss/torn-write claim'},null,2));
