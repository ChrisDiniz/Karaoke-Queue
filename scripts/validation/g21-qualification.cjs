// Isolated G2.1 experiment, never imported by production. No SRP mathematics here.
// Usage: node scripts/validation/g21-qualification.cjs /tmp/kq-g21-qualification
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const crypto=require('node:crypto'), {spawnSync}=require('node:child_process');
const root=path.resolve(process.argv[2]);
const source=path.join(root,'fast-srp-df6cdb6583024a3e4379501f4689777f02aa4d8c');
const ts=require(path.join(root,'tsc/package/lib/typescript.js'));
const meta=JSON.parse(fs.readFileSync(path.join(root,'metadata.json')));
const hash=(x,alg='sha256')=>crypto.createHash(alg).update(x).digest();
const eq=(a,b)=>assert.equal(Buffer.from(a).toString('hex'),Buffer.from(b).toString('hex'));
const results=[];function test(name,fn){fn();results.push(name);}
const bytes=fs.readFileSync(path.join(root,'package.tgz'));
test('npm SHA512 integrity and SHA1 shasum',()=>{assert.equal('sha512-'+hash(bytes,'sha512').toString('base64'),meta.dist.integrity);assert.equal(hash(bytes,'sha1').toString('hex'),meta.dist.shasum);});
const compile=(file)=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018,esModuleInterop:true}}).outputText;
test('published JS equals gitHead TS compiled by TypeScript 4.4.3 (map directive excluded)',()=>{
 const out=path.join(root,'source-compiled');
 ts.createProgram(['srp','params'].map(n=>path.join(source,`src/${n}.ts`)),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2018,esModuleInterop:true,outDir:out,noEmitOnError:false}).emit();
 for(const name of ['srp','params']){
 const actual=fs.readFileSync(path.join(root,`package/lib/${name}.js`),'utf8').replace(/\n?\/\/# sourceMappingURL=.*\s*$/,'').trim();
 assert.equal(actual,fs.readFileSync(path.join(out,`${name}.js`),'utf8').trim());
 }
 for(const name of ['jsbn/jsbn.js','LICENSE']) eq(fs.readFileSync(path.join(root,'package',name)),fs.readFileSync(path.join(source,name)));
});
const {SRP,SrpClient,SrpServer}=require(path.join(root,'package'));
const p=SRP.params.hap;
// Compile upstream fixed test data only; no upstream test runner or lifecycle scripts run.
const dataText=compile(path.join(source,'src/test/hap_test_data.ts')).replace('require("../params")',`require(${JSON.stringify(path.join(root,'package/lib/params.js'))})`);
fs.writeFileSync(path.join(root,'hap-data.cjs'),dataText);
const d=require(path.join(root,'hap-data.cjs'));
const input={I:Buffer.from(d.I),P:Buffer.from(d.p),s:d.s.toBuffer(true),a:d.a.toBuffer(true),b:d.b.toBuffer(true)};
function pair(password=input.P){const c=new SrpClient(p,input.s,input.I,password,input.a,true),s=new SrpServer(p,{username:input.I,salt:input.s,password:input.P},input.b);c.setB(s.computeB());s.setA(c.computeA());return {c,s};}
let known;
test('HAP upstream known vector: N/g/A/B/v/S/K/M1 and mutual M2',()=>{
 assert.equal(p.hash,'sha512');assert.equal(p.N_length_bits,3072);assert.equal(p.g.toString(10),'5');assert.equal(SRP.params[3072].hash,'sha256');
 known=pair();const {c,s}=known;
 for(const [a,b] of [[c.computeA(),d.A.toBuffer(true)],[s.computeB(),d.B.toBuffer(true)],[c._S,d.S.toBuffer(true)],[c.computeK(),d.K.toBuffer(true)],[SRP.computeVerifier(p,input.s,input.I,input.P),d.v.toBuffer(true)]])eq(a,b);
 assert.equal(c.computeM1().toString('hex'),'5f7c14ab57ed0e94fd1d78c6b4dd09ed7e340b7e05d419a9fd760f6b35e523d1310777a1ae1d2826f596f3a85116cc457c7c964d4f44ded5559da818c88b617f');
 s.checkM1(c.computeM1());c.checkM2(s.computeM2());eq(c.computeK(),s.computeK());assert.equal(s.computeM2().length,64);
});
const fixture={N:p.N.toString(16),...Object.fromEntries(Object.entries(input).map(([k,v])=>[k,v.toString('hex')])),A:known.c.computeA().toString('hex'),B:known.s.computeB().toString('hex'),K:known.c.computeK().toString('hex'),S:known.c._S.toString('hex'),M1:known.c.computeM1().toString('hex'),M2:known.s.computeM2().toString('hex')};
fs.writeFileSync(path.join(root,'srp-vector.json'),JSON.stringify(fixture,null,2)+'\n');
test('independent HAP-python server: B/S/K/M1/M2 and pysrp premaster',()=>{
 const r=spawnSync('python3',[path.join(__dirname,'g21-independent.py'),root],{encoding:'utf8'});assert.equal(r.status,0,r.stderr+r.stdout);results.push(r.stdout.trim());
});
test('wrong password, altered M1/M2, reflection, prior-session replay rejected',()=>{
 const wrong=pair(Buffer.from('wrong'));assert.throws(()=>wrong.s.checkM1(wrong.c.computeM1()));
 const {c,s}=pair();assert.throws(()=>s.checkM1(s.computeM2()));assert.throws(()=>c.checkM2(c.computeM1()));
 for(const method of ['checkM1','checkM2']){const target=method==='checkM1'?s:c;assert.throws(()=>target[method](Buffer.alloc(64)));assert.throws(()=>target[method](Buffer.alloc(63)));}
 const fresh=new SrpServer(p,{username:input.I,salt:input.s,password:input.P},Buffer.alloc(32,7));fresh.setA(c.computeA());assert.throws(()=>fresh.checkM1(c.computeM1()));
});
test('raw provider invalid public values rejected; short encoding accepted (wrapper mandatory)',()=>{
 const n=p.N.toBuffer(384);const above=Buffer.alloc(384,255);
 for(const value of [Buffer.alloc(384),n,above,Buffer.alloc(385,255),Buffer.alloc(0)]){
 const {c,s}=pair();assert.throws(()=>c.setB(value));assert.throws(()=>s.setA(value));}
 const {c,s}=pair();c.setB(Buffer.from([2]));s.setA(Buffer.from([2])); // demonstrates missing width guard
 assert.throws(()=>new SrpClient(p,input.s,input.I,input.P,input.a).setB('not-buffer'));
});
test('forced hash u=0 is NOT rejected by provider (fault injection, no feasible attack demonstrated)',()=>{
 const {c}=pair();const original=crypto.createHash;
 crypto.createHash=(alg,...args)=>{const h=original(alg,...args);let count=0;const update=h.update.bind(h),digest=h.digest.bind(h);h.update=(x,...rest)=>{count+=x.length;update(x,...rest);return h;};h.digest=(...args)=>alg==='sha512'&&count===768?Buffer.alloc(64):digest(...args);return h;};
 try{c.setB(known.s.computeB());assert.equal(c._u.toString(10),'0');assert.equal(c.computeK().length,64);}finally{crypto.createHash=original;}
});
// Exact binary framing/KDF candidate, primitives supplied exclusively by node:crypto.
const E=(...fields)=>Buffer.concat(fields.map(x=>{const b=Buffer.isBuffer(x)?x:Buffer.from(String(x),'ascii');const n=Buffer.alloc(4);n.writeUInt32BE(b.length);return Buffer.concat([n,b]);}));
const mac=(k,...f)=>crypto.createHmac('sha256',k).update(E(...f)).digest();
const kdf=(key,salt,label)=>Buffer.from(crypto.hkdfSync('sha256',key,salt,E('KQ-Pair-v1',label),32));
const pc=new SrpClient(p,Buffer.alloc(32,10),Buffer.from('KQ-Pair-v1:'+Buffer.alloc(32,1).toString('hex')),Buffer.from('00001234'),Buffer.alloc(32,11),true);
const ps=new SrpServer(p,{username:Buffer.from('KQ-Pair-v1:'+Buffer.alloc(32,1).toString('hex')),salt:Buffer.alloc(32,10),password:Buffer.from('00001234')},Buffer.alloc(32,12));
pc.setB(ps.computeB());ps.setA(pc.computeA());ps.checkM1(pc.computeM1());pc.checkM2(ps.computeM2());
fs.writeFileSync(path.join(root,'protocol-srp-vector.json'),JSON.stringify({K:pc.computeK().toString('hex'),M1:pc.computeM1().toString('hex'),M2:ps.computeM2().toString('hex'),salt:Buffer.alloc(32,10).toString('hex'),a:Buffer.alloc(32,11).toString('hex'),b:Buffer.alloc(32,12).toString('hex'),password:'00001234'},null,2)+'\n');
const fields=['KQ-Pair-transcript','kq-pair/1','srp6a-hap-3072-sha512','initial',Buffer.alloc(32,1),Buffer.alloc(32,2),Buffer.alloc(32,3),Buffer.alloc(32,4),Buffer.alloc(32,5),'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','controller','player',Buffer.alloc(32,6),Buffer.alloc(32,6),'player-22222222-2222-4222-8222-222222222222.karaoke.invalid','0','1','0',Buffer.alloc(32,10),pc.computeA(),ps.computeB(),'120',E()];
const T=E(...fields),TH=hash(T),R=kdf(pc.computeK(),TH,'recovery-root');
const bp=kdf(pc.computeK(),TH,'bind-player'),bc=kdf(pc.computeK(),TH,'bind-controller');
const cp=kdf(R,TH,'commit-player'),cc=kdf(R,TH,'commit-controller');
const proof=mac(bp,'player-bind',TH,pc.computeM1(),ps.computeM2());
test('RFC5869 test case 1',()=>{const out=crypto.hkdfSync('sha256',Buffer.alloc(22,11),Buffer.from('000102030405060708090a0b0c','hex'),Buffer.from('f0f1f2f3f4f5f6f7f8f9','hex'),42);assert.equal(Buffer.from(out).toString('hex'),'3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');});
test('every transcript field tamper, certificate substitution, reflection rejected',()=>{
 fields.forEach((v,i)=>{const f=[...fields];f[i]=Buffer.concat([Buffer.isBuffer(v)?v:Buffer.from(v),Buffer.from([0])]);const h=hash(E(...f));assert.notDeepEqual(mac(kdf(pc.computeK(),h,'bind-player'),'player-bind',h,pc.computeM1(),ps.computeM2()),proof);});assert.notDeepEqual(mac(bc,'player-bind',TH,pc.computeM1(),ps.computeM2()),proof);
});
test('recovery tree exactly reconstructs commit keys after discarding SRP K',()=>{eq(kdf(R,TH,'commit-player'),cp);eq(kdf(R,TH,'commit-controller'),cc);assert.notDeepEqual(cp,cc);});
const contract={T:T.toString('hex'),TH:TH.toString('hex'),R:R.toString('hex'),bindPlayer:bp.toString('hex'),bindController:bc.toString('hex'),commitPlayer:cp.toString('hex'),commitController:cc.toString('hex'),playerProof:proof.toString('hex')};
fs.writeFileSync(path.join(root,'binding-vector.json'),JSON.stringify(contract,null,2)+'\n');
// Cost is measured, not a timing-side-channel proof or universal performance threshold.
const costs=[];for(let i=0;i<8;i++){const t=performance.now();pair();costs.push(performance.now()-t);}
const report={node:process.version,electron:process.versions.electron||null,packageIntegrity:meta.dist.integrity,gitHead:meta.gitHead,tests:results,costMs:{min:Math.min(...costs),max:Math.max(...costs),mean:costs.reduce((a,b)=>a+b)/costs.length},sha256:{tarball:hash(bytes).toString('hex'),source:hash(fs.readFileSync(path.join(root,'source.tgz'))).toString('hex')}};
console.log(JSON.stringify(report,null,2));fs.writeFileSync(path.join(root,process.versions.electron?'electron-result.json':'node-result.json'),JSON.stringify(report,null,2)+'\n');
