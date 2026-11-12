// Inspect isolated published artifacts; never installs packages or runs lifecycle scripts.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]),list=[];
for(const [file,metadata] of [['opaque','opaque-metadata'],['srp-alt','srp-alt-metadata'],['spake','spake-metadata']]){
 const m=JSON.parse(fs.readFileSync(path.join(root,metadata+'.json'))),b=fs.readFileSync(path.join(root,file+'.tgz'));
 const sha=alg=>crypto.createHash(alg).update(b).digest(alg==='sha512'?'base64':'hex');assert.equal('sha512-'+sha('sha512'),m.dist.integrity);
 list.push({name:m.name,version:m.version,url:m.dist.tarball,integrity:m.dist.integrity,sha256:sha('sha256'),license:m.license,runtimeNpmDependencies:m.dependencies||{},scope:'metadata integrity only; does not attest audited source correspondence'});
}
const s=require(path.join(root,'spake/package'));
const a=s.start('KQ-qualification-v1','00001234'),b=s.start('KQ-qualification-v1','00001234');
const am=s.msg(a),bm=s.msg(b),ak=s.finish(a,bm),bk=s.finish(b,am);assert.deepEqual(ak,bk);
const badA=s.start('KQ-qualification-v1','00001234'),badB=s.start('KQ-qualification-v1','87654321');const badAM=s.msg(badA),badBM=s.msg(badB);assert.notDeepEqual(s.finish(badA,badBM),s.finish(badB,badAM));
const payload=JSON.parse(fs.readFileSync(path.join(root,'opaque-provenance-payload.json')));
const raw=fs.readFileSync(path.join(root,'opaque.tgz'));assert.equal(payload.subject[0].digest.sha512,crypto.createHash('sha512').update(raw).digest('hex'));
const provenance={declaredCommit:payload.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit,subjectDigestMatches:true,signatureVerified:false,scope:'unverified signed statement retrieved from npm; no signature/root/transparency verification or reproducible WASM build'};
const result={provenance,artifacts:list,spakeSmoke:{sameProviderMatch:true,wrongCodeDifferentKeys:true,messageBytes:am.length,keyBytes:ak.length,independentVectors:false,scope:'one-shot smoke, not provider qualification or key confirmation'}};
fs.writeFileSync(path.join(root,'b3-artifacts.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
