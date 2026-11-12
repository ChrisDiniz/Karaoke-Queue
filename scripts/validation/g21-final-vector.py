# Independent primitives for public fixture only; no PAKE mathematics.
import base64,json,hashlib,hmac,struct,sys
from pathlib import Path
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
root=Path(sys.argv[1]);v=json.loads((root/'final-profile-vector.json').read_text())
def un(s):return base64.urlsafe_b64decode(s+'='*((-len(s))%4))
def E(*xs):
 return b''.join(struct.pack('>I',len(x))+x for x in (x if isinstance(x,bytes) else x.encode('ascii') for x in xs))
def split(raw):
 out=[]
 while raw:
  n=struct.unpack('>I',raw[:4])[0];assert len(raw)>=4+n;out.append(raw[4:4+n]);raw=raw[4+n:]
 return out
T=un(v['T']);TH=hashlib.sha256(T).digest();assert TH==un(v['TH']);f=split(T)
assert f[:3]==[b'KQ-Pair-transcript',b'kq-pair/2',b'opaque-3dh-ristretto255-sha512-argon2id-m65536-t3-p4']
assert f[4:]==[un(v[k]) for k in ['KE1','KE2','KE3']]
x=v['context'];ctx=E('KQ-Pair-context','kq-pair/2',f[2],x['purpose'],*[un(x[k]) for k in ['sessionId','operationId','attemptId','nonceC','nonceP']],x['controllerId'],x['playerId'],'controller','player',un(x['fingerprint']),x['serverName'],x['expectedGeneration'],x['targetGeneration'],x['basePRevision'],x['baseCRevision'],'120')
assert f[3]==ctx
D=lambda key,label:HKDF(algorithm=hashes.SHA256(),length=32,salt=TH,info=E('KQ-Pair-v2',label)).derive(key)
K=un(v['sessionKeyFixture']);R=D(K,'recovery-root');assert R==un(v['R'])
for name,label,key in [('bindPlayerKey','bind-player',K),('bindControllerKey','bind-controller',K),('commitPlayerKey','commit-player',R),('commitControllerKey','commit-controller',R)]:assert un(v[name])==D(key,label)
pb=hmac.digest(un(v['bindPlayerKey']),E('player-bind',TH,*f[4:]),'sha256');assert pb==un(v['playerBind'])
cb=hmac.digest(un(v['bindControllerKey']),E('controller-bind',TH,*f[4:],pb),'sha256');assert cb==un(v['controllerBind'])
result={'independentPrimitives':'Python cryptography HKDF + hashlib/HMAC','encodingContextTranscript':'PASS','treeAndBothBindings':'PASS','scope':'application primitives; not independent OPAQUE AKE'}
(root/'decision-primitives.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
# Receipt/recovery extension: all fixtures public, fixed token/pairingId/nonce.
pairing=bytes([8])*32;token=bytes([9])*32;op=un(x['operationId']);nonce=bytes([13])*32
B=E('KQ-Pair-record','kq-pair/2',TH,pairing,op,'1','0','0',hashlib.sha256(token).digest());descriptor=hashlib.sha256(B).digest()
prev=descriptor;receipts=[]
for typ,label in [('prepare','commit-player'),('prepared','commit-controller'),('committed','commit-player'),('final','commit-controller'),('active','commit-player')]:
 message=E('KQ-Pair-receipt','kq-pair/2',typ,TH,pairing,op,'1','0','0',hashlib.sha256(token).digest(),prev)
 tag=hmac.digest(D(R,label),message,'sha256');receipts.append({'type':typ,'tag':base64.urlsafe_b64encode(tag).decode().rstrip('=')});prev=hashlib.sha256(E(typ,tag)).digest()
query=E('KQ-Pair-recovery','kq-pair/2','query',TH,b'',op,'1',nonce,'bound',bytes(32))
prepare_tag=un(receipts[0]['tag']);pd=hashlib.sha256(E(T,B,token,E('prepare',prepare_tag))).digest()
rd=hashlib.sha256(E('prepare',prepare_tag)).digest()
answer=E('KQ-Pair-recovery','kq-pair/2','answer',TH,pairing,op,'1',nonce,'pending',rd,E(E('prepare',prepare_tag)),pd)
enc=lambda b:base64.urlsafe_b64encode(b).decode().rstrip('=')
out={'descriptor':enc(B),'D':enc(descriptor),'receipts':receipts,'queryBytes':enc(query),'queryMac':enc(hmac.digest(D(R,'recovery-controller'),query,'sha256')),'answerBytes':enc(answer),'answerMac':enc(hmac.digest(D(R,'recovery-player'),answer,'sha256')),'prepareDigest':enc(pd),'fixture':'public fixed token09 pairing08 nonce0d; bound query with unknown pairingId'}
(root/'final-recovery-vector.json').write_text(json.dumps(out,indent=2)+'\n')
