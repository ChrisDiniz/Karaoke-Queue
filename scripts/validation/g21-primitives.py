# Independent OpenSSL-backed cryptography HKDF/HMAC checks, never production code.
import sys,json,struct,hashlib
from pathlib import Path
from cryptography.hazmat.primitives import hashes,hmac
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
p=Path(sys.argv[1]);v=json.loads((p/'binding-vector.json').read_text());s=json.loads((p/'protocol-srp-vector.json').read_text());r=json.loads((p/'receipt-vector.json').read_text())
def E(*fields):
 return b''.join(struct.pack('>I',len(x))+x for x in (f if isinstance(f,bytes) else str(f).encode('ascii') for f in fields))
def derive(key,salt,label):return HKDF(algorithm=hashes.SHA256(),length=32,salt=salt,info=E('KQ-Pair-v1',label)).derive(key)
TH=bytes.fromhex(v['TH']);K=bytes.fromhex(s['K']);R=derive(K,TH,'recovery-root');assert R.hex()==v['R']
for label,key in [('bind-player','bindPlayer'),('bind-controller','bindController')]:assert derive(K,TH,label).hex()==v[key]
for label,key in [('commit-player','commitPlayer'),('commit-controller','commitController')]:assert derive(R,TH,label).hex()==v[key]
assert hashlib.sha256(bytes.fromhex(v['T'])).digest()==TH
for rec in r['receipts']:
 key=bytes.fromhex(v['commitPlayer' if rec['role']=='P' else 'commitController']);h=hmac.HMAC(key,hashes.SHA256());h.update(E('KQ-Pair-receipt','kq-pair/1',rec['type'],TH,bytes([8])*32,bytes([2])*32,'1','0','0',bytes([9])*32,bytes.fromhex(rec['prev'])));assert h.finalize().hex()==rec['tag']
print('PASS: Python cryptography 41.0.7 HKDF tree, transcript hash and five receipt MACs equal Node vectors')

rv=json.loads((p/'recovery-vector.json').read_text())
for kind,label in [('query','recovery-controller'),('answer','recovery-player')]:
 h=hmac.HMAC(derive(R,TH,label),hashes.SHA256());h.update(bytes.fromhex(rv[kind+'Bytes']));assert h.finalize().hex()==rv[kind]
print('PASS: recovery request/answer direction keys, nonce framing and MACs equal Node')
