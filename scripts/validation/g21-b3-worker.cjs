// Isolated B3 measurements. No production imports, no SRP arithmetic implementation.
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
const {once}=require('node:events'),fs=require('node:fs'),path=require('node:path');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(isMainThread?process.argv[2]:workerData.root);
const fixture=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../docs/evidence/g21/protocol-srp-vector.json')));
function srp(){
 const {SRP,SrpClient,SrpServer}=require(path.join(root,'package'));
 const p=SRP.params.hap,I=Buffer.from('KQ-Pair-v1:'+Buffer.alloc(32,1).toString('hex'));
 const c=new SrpClient(p,Buffer.from(fixture.salt,'hex'),I,Buffer.from(fixture.password),Buffer.from(fixture.a,'hex'),true);
 const s=new SrpServer(p,{username:I,salt:Buffer.from(fixture.salt,'hex'),password:Buffer.from(fixture.password)},Buffer.from(fixture.b,'hex'));
 c.setB(s.computeB());s.setA(c.computeA());s.checkM1(c.computeM1());c.checkM2(s.computeM2());
 assert.equal(c.computeK().toString('hex'),fixture.K);assert.deepEqual(c.computeK(),s.computeK());return {c,s};
}
async function opaque(){
 const o=require(path.join(root,'opaque/package'));await o.ready;
 const password='00001234',identifiers={client:'KQ-ephemeral-controller',server:'KQ-ephemeral-player'};
 const setup=o.server.createSetup(),userIdentifier='KQ-test-session';
 const reg=o.client.startRegistration({password});
 const response=o.server.createRegistrationResponse({serverSetup:setup,userIdentifier,registrationRequest:reg.registrationRequest});
 // Local registration on Player only; no real account/network/store is created.
 const {registrationRecord}=o.client.finishRegistration({...reg,...response,password,identifiers});
 function begin(pass=password){const client=o.client.startLogin({password:pass});const server=o.server.startLogin({serverSetup:setup,registrationRecord,userIdentifier,startLoginRequest:client.startLoginRequest,identifiers});return {client,server};}
 const {client,server}=begin();const completed=o.client.finishLogin({...client,...server,password,identifiers});assert(completed);
 const finish=o.server.finishLogin({...server,finishLoginRequest:completed.finishLoginRequest,identifiers});assert.equal(finish.sessionKey,completed.sessionKey);
 const bad=begin('87654321');assert.equal(o.client.finishLogin({...bad.client,...bad.server,password:'87654321',identifiers}),undefined);
 const fresh=begin();assert.throws(()=>o.server.finishLogin({...fresh.server,finishLoginRequest:completed.finishLoginRequest,identifiers}));
 const tampered=begin();const bytes=Buffer.from(tampered.server.loginResponse,'base64url');bytes[10]^=1;
 try{assert.equal(o.client.finishLogin({...tampered.client,loginResponse:bytes.toString('base64url'),password,identifiers}),undefined);}catch(e){assert.match(e.message,/opaque protocol error/);}
 return {keyBytes:Buffer.from(completed.sessionKey,'base64url').length,messageBytes:{KE1:Buffer.from(client.startLoginRequest,'base64url').length,KE2:Buffer.from(server.loginResponse,'base64url').length,KE3:Buffer.from(completed.finishLoginRequest,'base64url').length,registrationRecord:Buffer.from(registrationRecord,'base64url').length},negatives:['wrong password','old finish to fresh session','altered loginResponse'],independentVectors:false};
}
if(!isMainThread){
 const initialized=workerData.kind==='opaque'?require(path.join(root,'opaque/package')).ready:Promise.resolve(require(path.join(root,'package')));
 initialized.then(()=>parentPort.postMessage({event:'ready'})).catch(e=>{throw e;});
 parentPort.once('message',async action=>{
  parentPort.postMessage({event:'started'});const start=performance.now();
  try{let result;if(workerData.kind==='opaque')result=await opaque();else{for(let i=0;i<(action==='cancel'?64:3);i++)srp();result={knownVector:true};}
   parentPort.postMessage({event:'result',elapsedMs:performance.now()-start,result});
  }catch(e){parentPort.postMessage({event:'failure',error:e.stack});}finally{parentPort.close();}
 });
}else (async()=>{
 const integrity=crypto.createHash('sha512').update(fs.readFileSync(path.join(root,'package.tgz'))).digest('base64');
 assert.equal(integrity,'lHRYYaaIbMrhZtsdGTwPN82UbqD9Bv8QfOlKs+Dz6YRnByZifOh93EYmf2iEWFtkOEIqR2IK8cFD0UN5wLIWBQ==');
 const active=new Set();
 async function trial(kind,cancel=false){
  const w=new Worker(__filename,{workerData:{root,kind}});active.add(w);
  const exited=once(w,'exit');await once(w,'online');const [ready]=await once(w,'message');assert.equal(ready.event,'ready');
  const samples=[];let last=performance.now(),ticks=0;const timer=setInterval(()=>{const t=performance.now();samples.push(t-last);last=t;ticks++;},10);
  const events=[];let sawStarted=false,completed=false,processedWhileBusy=false;
  const answer=new Promise((resolve,reject)=>{
   w.on('error',reject);w.on('message',m=>{events.push(m.event);if(m.event==='started'){sawStarted=true;setImmediate(()=>{processedWhileBusy=!completed;});if(cancel)resolve(null);}if(m.event==='failure')reject(new Error(m.error));if(m.event==='result'){completed=true;resolve(m);}});
  });
  w.postMessage(cancel?'cancel':'run');let response,cancelMs=null;
  try{response=await answer;if(cancel){const t=performance.now();await w.terminate();cancelMs=performance.now()-t;}await exited;
   assert(sawStarted);if(!cancel){assert(processedWhileBusy);assert(ticks>0);}else assert(!events.includes('result'));
  }finally{clearInterval(timer);await w.terminate();active.delete(w);}
  return {kind,cancel,events,response,main:{processedWhileBusy,ticks,maxIntervalMs:samples.length?Math.max(...samples):null},cancelMs};
 }
 const syncStart=performance.now();let serviced=false;const turn=new Promise(resolve=>setImmediate(()=>{serviced=true;resolve();}));srp();const syncMs=performance.now()-syncStart;assert.equal(serviced,false);await turn;
 const measurements=[];
 for(const kind of ['srp','opaque']){measurements.push(await trial(kind));measurements.push(await trial(kind,true));}
 measurements.push(await trial('srp'));assert.equal(active.size,0);
 const {s}=srp(),expected=Buffer.from(s._M1),classes=[0,31,63],timing={};
 // Deliberately bypasses the real attempt budget: microbenchmark only, not a remote attack.
 for(const index of classes){const bad=Buffer.from(expected);bad[index]^=1;const times=[];for(let batch=0;batch<12;batch++){const t=performance.now();for(let i=0;i<1000;i++)assert.throws(()=>s.checkM1(bad));times.push((performance.now()-t)*1e6/1000);}times.sort((a,b)=>a-b);timing[index]={medianNs:times[6],minNs:times[0],maxNs:times.at(-1)};}
 const result={node:process.version,electron:process.versions.electron||null,integrityVerified:true,synchronousMainDelayMs:syncMs,measurements,proofMismatchMicrobenchmark:timing,activeWorkersAtEnd:active.size,securityClaim:'NONE: scheduling/cancellation measurements and same-provider OPAQUE negatives do not prove constant time or independent OPAQUE interoperability'};
 const output=path.join(root,process.versions.electron?'b3-electron.json':'b3-node.json');fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
