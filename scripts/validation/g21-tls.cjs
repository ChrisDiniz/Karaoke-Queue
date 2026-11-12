// Real HTTPS sockets and certificate substitution; SRP K from verified fixed vector.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]);const {generate}=require(path.resolve('node_modules/selfsigned'));
const v=JSON.parse(fs.readFileSync(path.join(root,'binding-vector.json')));
const E=(...xs)=>Buffer.concat(xs.map(x=>{const b=Buffer.isBuffer(x)?x:Buffer.from(x);const n=Buffer.alloc(4);n.writeUInt32BE(b.length);return Buffer.concat([n,b]);}));
const srp=JSON.parse(fs.readFileSync(path.join(root,'protocol-srp-vector.json')));
const fields=[];const raw=Buffer.from(v.T,'hex');for(let i=0;i<raw.length;){const n=raw.readUInt32BE(i);i+=4;fields.push(raw.subarray(i,i+n));i+=n;}
const serverName=fields[15].toString('ascii');
const tag=fp=>{const local=[...fields];local[13]=fp;local[14]=fp;const TH=crypto.createHash('sha256').update(E(...local)).digest();const key=crypto.hkdfSync('sha256',Buffer.from(srp.K,'hex'),TH,E('KQ-Pair-v1','bind-player'),32);return crypto.createHmac('sha256',key).update(E('player-bind',TH,Buffer.from(srp.M1,'hex'),Buffer.from(srp.M2,'hex'))).digest('hex');};
(async()=>{
 const certs=await Promise.all([1,2].map(()=>generate([{name:'commonName',value:serverName}],{keyType:'rsa',keySize:2048,algorithm:'sha256',extensions:[{name:'subjectAltName',altNames:[{type:2,value:serverName}]}]})));
 const fp=cert=>crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest();const realFP=fp(certs[0].cert);const proof=tag(realFP);
 const servers=[];
 try{
 for(const cert of certs){const server=https.createServer({key:cert.private,cert:cert.cert},(_,res)=>res.end(proof));await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});servers.push(server);}
 async function request(index,ca){return new Promise((resolve,reject)=>{const req=https.get({hostname:'127.0.0.1',port:servers[index].address().port,servername:serverName,ca,agent:false,rejectUnauthorized:true},res=>{const observed=crypto.createHash('sha256').update(res.socket.getPeerCertificate().raw).digest();let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({observed,body}));});req.on('error',reject);});}
 const direct=await request(0,certs[0].cert);assert.equal(tag(direct.observed),direct.body);
 const relay=await request(1,certs[1].cert);assert.notEqual(tag(relay.observed),relay.body);
 await assert.rejects(request(1,certs[0].cert));
 console.log(JSON.stringify({direct:'PASS',terminatedTlsDifferentCertificate:'rejected by authenticated fingerprint',certificateSwapAfterProbe:'rejected by TLS',limits:'exact player-bind formula with observed DER fingerprints and SRP vector K/M1/M2; not G2 end-to-end'},null,2));
 }finally{await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));}
})().catch(e=>{console.error(e);process.exitCode=1;});
