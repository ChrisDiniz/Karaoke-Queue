# Extract official RFC data only; no PAKE arithmetic or test-only cryptographic fork.
import json,re,sys
from pathlib import Path
root=Path(sys.argv[1]);text=(root/'rfc9807.txt').read_text();vectors=[]
for number in (1,2):
 part=text.split(f'\nC.1.{number}.  OPAQUE-3DH Real Test Vector {number}\n')[1].split(f'\nC.1.{number+1}.  ')[0]
 fields={};current=None
 for line in part.splitlines():
  match=re.match(r'^   ([A-Za-z_][A-Za-z_0-9]*): ([0-9a-f]+)$',line)
  if match:current=match[1];fields[current]=match[2]
  elif current and re.match(r'^   [0-9a-f]+$',line):fields[current]+=line.strip()
  else:current=None
 for field,size in [('oprf_seed',64),('server_private_key',32),('server_public_key',32),('registration_request',32),('registration_response',64)]:assert len(bytes.fromhex(fields[field]))==size
 vectors.append(fields)
(root/'rfc-vectors.json').write_text(json.dumps(vectors,indent=2)+'\n')
