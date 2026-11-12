# External implementations are loaded unmodified from /tmp. No SRP arithmetic here.
import sys,json,hashlib,types,importlib.util
from pathlib import Path
root=Path(sys.argv[1]);v=json.loads((root/'srp-vector.json').read_text())
b=lambda k:bytes.fromhex(v[k])
# HAP-python util has unrelated optional dependencies; expose only its exact int conversion.
pkg=types.ModuleType('pyhap');pkg.__path__=[str(root)];sys.modules['pyhap']=pkg
util=types.ModuleType('pyhap.util')
util.long_to_bytes=lambda n:n.to_bytes((n.bit_length()+7)>>3,'big')
sys.modules['pyhap.util']=util
spec=importlib.util.spec_from_file_location('pyhap.hsrp',root/'hsrp-pinned.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s=m.Server({'hashfunc':hashlib.sha512,'N':int(v['N'],16),'g':5,'N_len':3072,'salt_len':32,'secret_len':32},b('I'),b('P'),s=b('s'),b=int(v['b'],16))
s.set_A(b('A'))
for key,value in [('B',s.Bb),('S',s.Sb),('K',s.Kb),('M1',s.M),('M2',s.HAMK)]:assert value==b(key),key
spec=importlib.util.spec_from_file_location('pysrp',root/'pysrp.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
p.rfc5054_enable()
u=p.User(b('I'),b('P'),hash_alg=p.SHA512,ng_type=p.NG_CUSTOM,n_hex=v['N'],g_hex='05',bytes_a=b('a').rjust(256,b'\0'))
u.process_challenge(b('s'),b('B'))
assert u.S.to_bytes(384,'big')==b('S');assert u.K==b('K')
print('Independent HAP-python B/S/K/M1/M2 + pysrp S/K PASS (one fixed vector; padding edge interop not claimed)')
