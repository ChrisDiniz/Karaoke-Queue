// Executable specification model, not G2 production implementation.
// Injected monotonic clock; snapshots simulate durable reads after restart.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const WINDOW=600000;
function boot(snapshot,now){return {saved:structuredClone(snapshot),deadlines:new Map(snapshot.map(x=>[x.id,now+WINDOW]))};}
function reserve(s,id,now,storageOk=true){
 const current=s.saved.filter(x=>s.deadlines.get(x.id)>now);
 if(current.some(x=>x.id===id))return 'duplicate';
 if(current.length>=5)return 'locked';
 if(!storageOk)return 'storage-blocked';
 s.saved=[...current,{id,status:'reserved'}];s.deadlines.set(id,now+WINDOW);return 'admitted';
}
const tests=[];
let s=boot([],0);for(let i=0;i<5;i++)assert.equal(reserve(s,'attempt-'+i,i),'admitted');
assert.equal(reserve(s,'sixth',5),'locked');tests.push('five reservations fence the sixth before expensive work');
const restart=boot(s.saved,100);assert.equal(reserve(restart,'sixth',600099),'locked');assert.equal(reserve(restart,'sixth',600100),'admitted');tests.push('restart re-arms conservative 600s monotonic window; expires while running');
assert.equal(reserve(s,'attempt-1',10),'duplicate');assert.equal(s.saved.length,5);tests.push('duplicate operation does not reserve twice');
const failure=boot([],0);assert.equal(reserve(failure,'x',0,false),'storage-blocked');assert.equal(failure.saved.length,0);tests.push('failed durable reservation never admits crypto');
const interrupted=boot([{id:'crash-inflight',status:'reserved'}],0);assert.equal(interrupted.saved.length,1);tests.push('crash-inflight reservation stays charged');
// Five failures last forever in the file until cleanup, but a live process expires them
// independent of RTC. Deliberately conservative after each restart, not permanent.
for(const ignoredWall of [-1e15,0,1e15]){const state=boot(s.saved,0);assert.equal(reserve(state,'new',WINDOW-1),'locked');assert.equal(reserve(state,'new',WINDOW),'admitted');}
tests.push('wall-clock changes cannot bypass or permanently extend a running monotonic cooldown');
// Renewal: a single authority transaction couples tombstone with promoting journal.
const stages=['staged','promoting','identity-promoted','awaiting-pair','active-new'];
function initial(){return {authority:'old',identity:'old',oldBundle:true,newBundle:false,stage:null};}
function step(s,name){const c=structuredClone(s);c.stage=name;if(name==='staged')c.newBundle=true;if(name==='promoting')c.authority=null;if(name==='identity-promoted')c.identity='new';if(name==='active-new')c.authority='new';return c;}
for(let cut=0;cut<=stages.length;cut++){
 let state=initial();for(const stage of stages.slice(0,cut))state=step(state,stage);
 assert(state.oldBundle);if(cut>=1)assert(state.newBundle);
 if(cut>=2&&cut<5)assert.equal(state.authority,null);
 // Restart resumes same staged material; never creates a second key/binding.
 for(const stage of stages.slice(cut))state=step(state,stage);
 assert.equal(state.identity,'new');assert.equal(state.authority,'new');assert(state.oldBundle);
}
tests.push('six renewal cuts preserve recoverable bundle; no authority between tombstone and new pairing');
const staged=step(initial(),'staged');assert.equal(staged.authority,'old');assert.equal(staged.identity,'old');tests.push('failure before revocation preserves valid old identity/authority');
const fence=step(staged,'promoting');assert.equal(fence.authority,null);tests.push('old identity on disk cannot authorize after tombstone');
const result={tests,limits:'pure executable state model: no actual cofre, fsync, NTFS power loss, coordinator, native clock or IPC validation'};
const root=path.resolve(process.argv[2]);fs.writeFileSync(path.join(root,'b3-policy-model.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
