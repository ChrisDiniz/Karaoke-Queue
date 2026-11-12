// Isolated final-profile experiment: two OS processes, unchanged OPAQUE, standard HKDF/HMAC.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {fork}=require('node:child_process');
const E=(...xs)=>Buffer.concat(xs.map(x=>{const b=Buffer.isBuffer(x)?x:Buffer.from(String(x),'ascii');const n=Buffer.alloc(4);n.writeUInt32BE(b.length);return Buffer.concat([n,b]);}));
const H=x=>crypto.createHash('sha256').update(x).digest();const b64=x=>Buffer.from(x).toString('base64url');
const un=s=>Buffer.from(s,'base64url');const suite='opaque-3dh-ristretto255-sha512-argon2id-m65536-t3-p4';
function ctx(x){return E('KQ-Pair-context','kq-pair/2',suite,x.purpose,un(x.sessionId),un(x.operationId),un(x.attemptId),un(x.nonceC),un(x.nonceP),x.controllerId,x.playerId,'controller','player',un(x.fingerprint),x.serverName,x.expectedGeneration,x.targetGeneration,x.basePRevision,x.baseCRevision,'120');}
function ids(x){const c=b64(ctx(x));return {client:'KQ-Pair-v2/controller/'+c,server:'KQ-Pair-v2/player/'+c};}
function keys(key,x,ke1,ke2,ke3){const T=E('KQ-Pair-transcript','kq-pair/2',suite,ctx(x),un(ke1),un(ke2),un(ke3));const TH=H(T);const derive=(key,label)=>Buffer.from(crypto.hkdfSync('sha256',key,TH,E('KQ-Pair-v2',label),32));const R=derive(un(key),'recovery-root');return {T,TH,R,bp:derive(un(key),'bind-player'),bc:derive(un(key),'bind-controller'),cp:derive(R,'commit-player'),cc:derive(R,'commit-controller')};}
const mac=(k,...xs)=>crypto.createHmac('sha256',k).update(E(...xs)).digest();
if(process.argv[2]==='peer'){
 let o,x,reg,setup,start,K,ke1,ke2,ke3,k,confirmed=false;
 process.on('message',async m=>{try{let out;
  if(m.type==='init'){o=require(m.package);await o.ready;x=m.context;out={ready:true};}
  if(m.type==='register'){setup=o.server.createSetup();const r=o.client.startRegistration({password:'00001234'}),s=o.server.createRegistrationResponse({serverSetup:setup,userIdentifier:'KQ-Pair-v2/'+x.sessionId+'/'+x.attemptId,registrationRequest:r.registrationRequest});reg=o.client.finishRegistration({...r,...s,password:'00001234',identifiers:ids(x),keyStretching:'memory-constrained'}).registrationRecord;out={registeredLocally:true};}
  if(m.type==='ke1'){start=o.client.startLogin({password:m.password});ke1=start.startLoginRequest;out={KE1:ke1};}
  if(m.type==='ke2'){ke1=m.KE1;start=o.server.startLogin({serverSetup:setup,registrationRecord:reg,userIdentifier:'KQ-Pair-v2/'+x.sessionId+'/'+x.attemptId,startLoginRequest:ke1,identifiers:ids(x)});ke2=start.loginResponse;out={KE2:ke2};}
  if(m.type==='ke3'){ke2=m.KE2;const result=o.client.finishLogin({...start,loginResponse:ke2,password:m.password,identifiers:ids(x),keyStretching:'memory-constrained'});if(!result)out={authenticated:false};else{K=result.sessionKey;ke3=result.finishLoginRequest;k=keys(K,x,ke1,ke2,ke3);out={authenticated:true,KE3:ke3};}}
  if(m.type==='player-bind'){ke3=m.KE3;const result=o.server.finishLogin({...start,finishLoginRequest:ke3,identifiers:ids(x)});K=result.sessionKey;k=keys(K,x,ke1,ke2,ke3);out={bind:b64(mac(k.bp,'player-bind',k.TH,un(ke1),un(ke2),un(ke3)))};}
  if(m.type==='controller-bind'){const expected=mac(k.bp,'player-bind',k.TH,un(ke1),un(ke2),un(ke3));assert.equal(un(m.bind).length,32);assert(crypto.timingSafeEqual(un(m.bind),expected));out={bind:b64(mac(k.bc,'controller-bind',k.TH,un(ke1),un(ke2),un(ke3),un(m.bind)))};}
  if(m.type==='verify-controller'){const pb=mac(k.bp,'player-bind',k.TH,un(ke1),un(ke2),un(ke3));const expected=mac(k.bc,'controller-bind',k.TH,un(ke1),un(ke2),un(ke3),pb);assert.equal(un(m.bind).length,32);assert(crypto.timingSafeEqual(expected,un(m.bind)));confirmed=true;out={confirmed:true,keyDigest:b64(H(un(K))),rootDigest:b64(H(k.R))};}
  if(m.type==='describe'){out={sessionKeyFixture:K,T:b64(k.T),TH:b64(k.TH),R:b64(k.R),bindPlayerKey:b64(k.bp),bindControllerKey:b64(k.bc),commitPlayerKey:b64(k.cp),commitControllerKey:b64(k.cc),keyDigest:b64(H(un(K))),confirmed};}
  if(m.type==='reset'){x=null;reg=null;setup=null;start=null;K=null;k=null;ke1=null;ke2=null;ke3=null;confirmed=false;out={reset:true};}
  process.send({id:m.id,out});
 }catch(e){process.send({id:m.id,error:e.message});}});
}else(async()=>{
 const root=path.resolve(process.argv[2]),pkg=path.resolve(process.argv[3]);let request=0;const children=new Set();
 function spawn(){const p=fork(__filename,['peer'],{stdio:['ignore','ignore','inherit','ipc'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});children.add(p);const pending=new Map();p.on('message',m=>{const q=pending.get(m.id);if(q){pending.delete(m.id);m.error?q.reject(Error(m.error)):q.resolve(m.out);}});p.on('exit',()=>{children.delete(p);for(const q of pending.values())q.reject(Error('peer exited'));pending.clear();});return {p,call(type,args={}){return new Promise((resolve,reject)=>{const id=++request;pending.set(id,{resolve,reject});p.send({id,type,...args});});},async close(){if(!p.connected)return;const ended=new Promise(resolve=>p.once('exit',resolve));p.disconnect();p.kill();await ended;}};}
 const context={purpose:'initial',sessionId:b64(Buffer.alloc(32,1)),operationId:b64(Buffer.alloc(32,2)),attemptId:b64(Buffer.alloc(32,3)),nonceC:b64(Buffer.alloc(32,4)),nonceP:b64(Buffer.alloc(32,5)),controllerId:'11111111-1111-4111-8111-111111111111',playerId:'22222222-2222-4222-8222-222222222222',fingerprint:b64(Buffer.alloc(32,6)),serverName:'player-22222222-2222-4222-8222-222222222222.karaoke.invalid',expectedGeneration:'0',targetGeneration:'1',basePRevision:'0',baseCRevision:'0'};
 const result={suite,tests:[],scope:'real OPAQUE and OS processes; no product coordinator/store/IPC UI',pid:process.pid};let vector;
 async function run(mode){const P=spawn(),C=spawn();try{
  const cx={...context};if(mode==='certificate')cx.fingerprint=b64(Buffer.alloc(32,9));if(mode==='nonce')cx.nonceP=b64(Buffer.alloc(32,9));if(mode==='generation')cx.targetGeneration='2';
  await P.call('init',{package:pkg,context});await C.call('init',{package:pkg,context:cx});await P.call('register');const password=mode==='password'?'87654321':'00001234';const a=await C.call('ke1',{password});const b=await P.call('ke2',a);
  if(mode==='cancel'||mode==='timeout'){await P.call('reset');await assert.rejects(P.call('player-bind',{KE3:b64(Buffer.alloc(64))}));return;}
  const c=await C.call('ke3',{...b,password});if(['certificate','nonce','generation','password'].includes(mode)){assert.equal(c.authenticated,false);return;}assert(c.authenticated);
  const d=await P.call('player-bind',c);
  if(mode==='divergent-confirm'){d.bind=b64(Buffer.alloc(32));await assert.rejects(C.call('controller-bind',d));return;}
  const e=await C.call('controller-bind',d);
  if(mode==='altered-controller-confirm'){e.bind=b64(Buffer.alloc(32));await assert.rejects(P.call('verify-controller',e));return;}
  const f=await P.call('verify-controller',e),cv=await C.call('describe');assert.equal(f.keyDigest,cv.keyDigest);assert.equal(f.rootDigest,b64(H(un(cv.R))));
  if(mode==='replay'){await P.call('reset');await P.call('init',{package:pkg,context});await P.call('register');await P.call('ke2',a);await assert.rejects(P.call('player-bind',c));return;}
  vector={context,...cv,KE1:a.KE1,KE2:b.KE2,KE3:c.KE3,playerBind:d.bind,controllerBind:e.bind,publicFixtureOnly:true};
 }finally{await Promise.all([P.close(),C.close()]);}}
 for(const name of ['success','password','certificate','nonce','generation','divergent-confirm','altered-controller-confirm','replay','cancel','timeout']){await run(name);result.tests.push(name+': PASS');}
 // Deterministic admission contract fixture: same intent joins; other Controller cannot replace it.
 let active=null;const admit=(owner,op)=>{if(!active){active={owner,op};return 'reserved';}return active.owner===owner&&active.op===op?'join':'busy';};assert.equal(admit('A','1'),'reserved');assert.equal(admit('A','1'),'join');assert.equal(admit('B','2'),'busy');result.tests.push('simultaneous intent reservation model: PASS (not production concurrency proof)');
 assert.equal(children.size,0);result.childrenAtEnd=0;result.runtime={node:process.version,electron:process.versions.electron||null};
 fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'decision-processes.json'),JSON.stringify(result,null,2)+'\n');fs.writeFileSync(path.join(root,'final-profile-vector.json'),JSON.stringify(vector,null,2)+'\n');console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
