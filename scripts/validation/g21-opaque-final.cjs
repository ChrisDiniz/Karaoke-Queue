// Isolated qualification experiment. Uses published OPAQUE unchanged and official RFC data.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const crypto=require('node:crypto'),https=require('node:https');
const root=path.resolve(process.argv[2]);const o=require(path.join(root,'opaque/package'));
const selfsigned=require(path.resolve('node_modules/selfsigned'));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const fromB64=s=>Buffer.from(s,'base64url');
const report={runtime:{node:process.version,electron:process.versions.electron||null},tests:[],scope:'isolated experiment, not approved wire contract or production G2'};
function pass(s){report.tests.push(s);}
function rejected(fn){try{assert.equal(fn(),undefined);}catch(e){assert.match(String(e),/opaque protocol error|base64 decoding failed/);}}
(async()=>{
 await o.ready;const before=process.memoryUsage().rss;const started=performance.now();
 const v=JSON.parse(fs.readFileSync(path.join(root,'rfc-vectors.json')));
 for(let i=0;i<v.length;i++){
  const x=v[i];const setup=Buffer.concat(['oprf_seed','server_private_key','server_public_key'].map(k=>Buffer.from(x[k],'hex'))).toString('base64url');
  const actual=o.server.createRegistrationResponse({serverSetup:setup,userIdentifier:Buffer.from(x.credential_identifier,'hex').toString('ascii'),registrationRequest:Buffer.from(x.registration_request,'hex').toString('base64url')});
  assert.equal(fromB64(actual.registrationResponse).toString('hex'),x.registration_response);pass(`RFC9807 C.1.${i+1}: deterministic OPRF/server public registration response exact`);
 }
 report.fullRfcAkeVector='NOT RUN: public API fixes nonempty-context=None and Argon2 KSF; RFC vectors use Identity KSF and explicit context; no library fork/RNG hook';
 const name='player-22222222-2222-4222-8222-222222222222.karaoke.invalid';
 const certs=await Promise.all([0,1].map(()=>selfsigned.generate([{name:'commonName',value:name}],{keyType:'rsa',keySize:2048,algorithm:'sha256',extensions:[{name:'subjectAltName',altNames:[{type:2,value:name}]}]})));
 const fp=cert=>hash(new crypto.X509Certificate(cert).raw);const realFp=fp(certs[0].cert);
 let record,setup,session,identifiers;const pending=new Map();const servers=[];
 const PASSWORD='00001234';
 function serverIdentifier(fingerprint,version='POC-only-1',purpose='initial'){return [version,'player','22222222-2222-4222-8222-222222222222',fingerprint,session,purpose].join('|');}
 function localRegistration(){
  session=crypto.randomBytes(32).toString('hex');setup=o.server.createSetup();identifiers={client:'11111111-1111-4111-8111-111111111111',server:serverIdentifier(realFp)};
  const start=o.client.startRegistration({password:PASSWORD});const response=o.server.createRegistrationResponse({serverSetup:setup,userIdentifier:session,registrationRequest:start.registrationRequest});
  record=o.client.finishRegistration({...start,...response,password:PASSWORD,identifiers}).registrationRecord;
 }
 localRegistration();pass('registration entirely inside trusted Player: no network registration, code never sent as plaintext');
 const createHandler=()=>async(req,res)=>{
  try{let body='';for await(const b of req){body+=b;if(body.length>16384)throw Error('size');}const q=JSON.parse(body);
   if(req.url==='/ke1'){const start=o.server.startLogin({serverSetup:setup,registrationRecord:record,userIdentifier:session,startLoginRequest:q.KE1,identifiers});const id=crypto.randomBytes(32).toString('hex');pending.set(id,start.serverLoginState);res.end(JSON.stringify({id,KE2:start.loginResponse}));}
   else if(req.url==='/ke3'){const state=pending.get(q.id);pending.delete(q.id);if(!state)throw Error('unknown operation');const result=o.server.finishLogin({serverLoginState:state,finishLoginRequest:q.KE3,identifiers});res.end(JSON.stringify({keyDigest:hash(fromB64(result.sessionKey))}));}
   else throw Error('route');
  }catch{res.statusCode=403;res.end(JSON.stringify({error:'rejected'}));}
 };
 async function listen(cert,handler){const server=https.createServer({key:cert.private,cert:cert.cert},handler);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});servers.push(server);return server;}
 async function request(index,route,body,ca=certs[index].cert){return new Promise((resolve,reject)=>{const req=https.request({hostname:'127.0.0.1',servername:name,port:servers[index].address().port,path:route,method:'POST',ca,agent:false,rejectUnauthorized:true,headers:{'Content-Type':'application/json'}},res=>{const observed=hash(res.socket.getPeerCertificate().raw);let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,observed,data:JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify(body));});}
 try{
  await listen(certs[0],createHandler());
  // TLS-terminating adversary forwards real protocol messages to the real Player.
  await listen(certs[1],async(req,res)=>{let body='';for await(const b of req)body+=b;const upstream=await request(0,req.url,JSON.parse(body));res.statusCode=upstream.status;res.end(JSON.stringify(upstream.data));});
  async function login(index,options={}){
   const password=options.password||PASSWORD;const client=o.client.startLogin({password});const response=await request(index,'/ke1',{KE1:client.startLoginRequest});assert.equal(response.status,200);
   let KE2=response.data.KE2;if(options.alter){const b=fromB64(KE2);b[10]^=1;KE2=b.toString('base64url');}
   const peerIds={client:options.client||identifiers.client,server:serverIdentifier(response.observed,options.version||'POC-only-1',options.purpose||'initial')};
   let finish;try{finish=o.client.finishLogin({...client,loginResponse:KE2,password,identifiers:peerIds});}catch(e){assert.match(String(e),/opaque protocol error/);}
   if(!finish){pending.delete(response.data.id);return false;}
   const answer=await request(index,'/ke3',{id:response.data.id,KE3:finish.finishLoginRequest});assert.equal(answer.status,200);assert.equal(answer.data.keyDigest,hash(fromB64(finish.sessionKey)));return true;
  }
  assert(await login(0));pass('real HTTPS bilateral login: both session-key digests equal');
  for(const [label,options]of [['wrong code',{password:'87654321'}],['altered KE2',{alter:true}],['client identity substituted',{client:'wrong-controller'}],['version/downgrade context',{version:'POC-only-0'}],['purpose context',{purpose:'renewal'}]]){assert.equal(await login(0,options),false);pass(label+' rejected before credentials');}
  assert.equal(await login(1),false);pass('TLS-terminating MITM with second certificate and relayed KE1/KE2: native authenticated server identifier mismatch');
  await assert.rejects(request(1,'/ke1',{KE1:o.client.startLogin({password:PASSWORD}).startLoginRequest},certs[0].cert));pass('certificate replacement after candidate pin rejected by TLS');
  const start=o.client.startLogin({password:PASSWORD});const reply=await request(0,'/ke1',{KE1:start.startLoginRequest});const finish=o.client.finishLogin({...start,loginResponse:reply.data.KE2,password:PASSWORD,identifiers});assert(finish);
  const fresh=o.client.startLogin({password:PASSWORD});const freshReply=await request(0,'/ke1',{KE1:fresh.startLoginRequest});assert.equal((await request(0,'/ke3',{id:freshReply.data.id,KE3:finish.finishLoginRequest})).status,403);pass('KE3 replay into different AKE rejected');
  pending.delete(reply.data.id);assert.equal((await request(0,'/ke3',{id:reply.data.id,KE3:finish.finishLoginRequest})).status,403);pass('authentication interrupted and state discarded: stale KE3 rejected');
  // Interrupted local registration: no record is retained and no AKE route is opened by it.
  const registration=o.client.startRegistration({password:PASSWORD});assert(registration.registrationRequest);assert.equal(registration.registrationRecord,undefined);pass('registration start alone emits no registrationRecord (no product-store claim)');
 }finally{await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));pending.clear();}
 report.elapsedMs=performance.now()-started;report.rssBeforeBytes=before;report.rssAfterBytes=process.memoryUsage().rss;report.maxRssKiB=process.resourceUsage().maxRSS;
 report.limits=['no frozen G2 OPAQUE wire contract','identifier binding experiment, not audited composition','full RFC AKE vectors not executed','no native Windows/cofre validation'];
 fs.writeFileSync(path.join(root,'opaque-final-'+(process.versions.electron?'electron':'node')+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
