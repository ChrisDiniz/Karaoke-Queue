// Cross-check independently generated Python receipt/recovery fixture, no product store.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]);const v=JSON.parse(fs.readFileSync(path.join(root,'final-profile-vector.json'))),r=JSON.parse(fs.readFileSync(path.join(root,'final-recovery-vector.json')));
const un=s=>Buffer.from(s,'base64url'),H=x=>crypto.createHash('sha256').update(x).digest();
const E=(...xs)=>Buffer.concat(xs.map(x=>{const b=Buffer.isBuffer(x)?x:Buffer.from(x,'ascii');const n=Buffer.alloc(4);n.writeUInt32BE(b.length);return Buffer.concat([n,b]);}));
const TH=un(v.TH),R=un(v.R),pairing=Buffer.alloc(32,8),token=Buffer.alloc(32,9),op=un(v.context.operationId),nonce=Buffer.alloc(32,13);
const D=label=>Buffer.from(crypto.hkdfSync('sha256',R,TH,E('KQ-Pair-v2',label),32));const mac=(label,bytes)=>crypto.createHmac('sha256',D(label)).update(bytes).digest();
const B=E('KQ-Pair-record','kq-pair/2',TH,pairing,op,'1','0','0',H(token));assert.deepEqual(B,un(r.descriptor));let prev=H(B);assert.deepEqual(prev,un(r.D));
for(const receipt of r.receipts){const direction=['prepare','committed','active'].includes(receipt.type)?'commit-player':'commit-controller';const bytes=E('KQ-Pair-receipt','kq-pair/2',receipt.type,TH,pairing,op,'1','0','0',H(token),prev);assert.deepEqual(mac(direction,bytes),un(receipt.tag));prev=H(E(receipt.type,un(receipt.tag)));}
const query=E('KQ-Pair-recovery','kq-pair/2','query',TH,Buffer.alloc(0),op,'1',nonce,'bound',Buffer.alloc(32));assert.deepEqual(query,un(r.queryBytes));assert.deepEqual(mac('recovery-controller',query),un(r.queryMac));
const pt=un(r.receipts[0].tag),pd=H(E(un(v.T),B,token,E('prepare',pt)));assert.deepEqual(pd,un(r.prepareDigest));
const answer=E('KQ-Pair-recovery','kq-pair/2','answer',TH,pairing,op,'1',nonce,'pending',H(E('prepare',pt)),E(E('prepare',pt)),pd);assert.deepEqual(answer,un(r.answerBytes));assert.deepEqual(mac('recovery-player',answer),un(r.answerMac));
const mutated=Buffer.from(answer);mutated[mutated.length-1]^=1;assert.notDeepEqual(mac('recovery-player',mutated),un(r.answerMac));assert.notDeepEqual(mac('recovery-controller',answer),un(r.answerMac));
const result={fiveReceipts:'PASS cross-language',boundRecoveryWithoutPairingId:'PASS cross-language',prepareDigestAndTamper:'PASS',scope:'cryptographic bytes/MACs only, no crash/store or product authorization claim'};fs.writeFileSync(path.join(root,'decision-receipts.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
