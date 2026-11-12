// Official Sigstore verifier installed only under the caller's temporary directory.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]),artifacts=path.resolve(process.argv[3]);
const sig=require(path.join(root,'verify/node_modules/sigstore'));
(async()=>{
 const bundle=JSON.parse(fs.readFileSync(path.join(artifacts,'opaque-attestations.json'))).attestations.find(a=>a.predicateType==='https://slsa.dev/provenance/v1').bundle;
 const issuer='https://token.actions.githubusercontent.com';
 const identity='https://github.com/serenity-kit/opaque/.github/workflows/release.yml@refs/heads/main';
 await sig.verify(bundle,{certificateIssuer:issuer,certificateIdentityURI:identity,tufCachePath:path.join(root,'tuf-cache')});
 const payload=JSON.parse(Buffer.from(bundle.dsseEnvelope.payload,'base64'));
 assert.equal(payload.subject[0].digest.sha512,crypto.createHash('sha512').update(fs.readFileSync(path.join(artifacts,'opaque.tgz'))).digest('hex'));
 const tampered=structuredClone(bundle);const altered=JSON.parse(Buffer.from(tampered.dsseEnvelope.payload,'base64'));altered.subject[0].digest.sha512='00'.repeat(64);tampered.dsseEnvelope.payload=Buffer.from(JSON.stringify(altered)).toString('base64');
 let rejectedTamper=false;try{await sig.verify(tampered,{certificateIssuer:issuer,certificateIdentityURI:identity,tufCachePath:path.join(root,'tuf-cache')});}catch(e){assert.match(e.message,/DSSE payload hash mismatch|signature/i);rejectedTamper=true;}assert(rejectedTamper);
 const result={tamperedPayloadRejected:true,verifier:'sigstore@'+require(path.join(root,'verify/node_modules/sigstore/package.json')).version,issuer,identity,signatureChainCTRekor:'PASS (verifier defaults)',digestMatches:true,commit:payload.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit};
 fs.writeFileSync(path.join(root,'provenance-result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
