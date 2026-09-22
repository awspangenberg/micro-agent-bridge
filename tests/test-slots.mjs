import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allocate,identity,frame,agentSlot,assignedClaude} from '../src/slots.mjs';
const t=(id,p='codex',host='server-a')=>({provider:p,host,nativeId:id,title:'Duplicate title'});
const inv=(tasks,p='codex',host='server-a',available=true)=>({provider:p,host,tasks,available});
test('sidebar seed, six most recent pins, stable survivors, unpin, repin and offline preservation',()=>{
 const a=[1,2,3,4].map(x=>t(String(x))),b=[1,2,3,4].map(x=>t(String(x),'claude'));
 let s=allocate(null,[inv(a),inv(b,'claude')]);
 assert.deepEqual(s.slots.map(identity),[a[0],b[0],a[1],b[1],a[2],b[2]].map(identity));
 assert.deepEqual(s.waiting.map(identity),[a[3],b[3]].map(identity));
 const newest=t('new','claude');
 s=allocate(s,[inv(a),inv([newest,...b],'claude')]);
 assert.deepEqual(s.slots.map(identity),[a[0],b[0],a[1],b[1],a[2],newest].map(identity));
 // Activity/title changes and restart do not reorder pin recency.
 s=allocate(JSON.parse(JSON.stringify(s)),[inv(a.map(x=>({...x,title:'Updated'}))),inv([newest,...b],'claude')]);
 assert.equal(identity(s.slots[5]),identity(newest));
 s=allocate(s,[inv([a[3],a[2],a[0]]),inv([], 'claude','server-a',false)]);
 assert.deepEqual(s.slots.map(identity),[a[0],b[0],b[2],b[1],a[2],newest].map(identity));
 s=allocate(s,[inv(a),inv([newest,...b],'claude')]);
 assert.ok(s.slots.some(x=>identity(x)===identity(a[1])));
 assert.ok(!s.slots.some(x=>identity(x)===identity(b[2])));
 s=allocate(s,[inv([]),inv([],'claude')]);assert.deepEqual(s.slots,Array(6).fill(null));
});
test('inactive pins are eligible and a native session replacement retains pin age and slot',()=>{
 const tasks=Array.from({length:8},(_,i)=>({...t(String(i),i%2?'claude':'codex'),navId:'desktop-'+i,state:'unknown'}));
 let s=allocate(null,[inv(tasks.filter(t=>t.provider==='codex')),inv(tasks.filter(t=>t.provider==='claude'),'claude')]);
 assert.equal(s.slots.filter(Boolean).length,6);assert.equal(s.waiting.length,2);
 const before=JSON.parse(JSON.stringify(s));tasks[1]={...tasks[1],nativeId:'replacement'};
 s=allocate(s,[inv(tasks.filter(t=>t.provider==='codex')),inv(tasks.filter(t=>t.provider==='claude'),'claude')]);
 assert.equal(s.slots[1].nativeId,'replacement');assert.deepEqual(s.pinRanks,before.pinRanks);
});
test('new pinned Code task appears before its native process starts and unpin removes it',()=>{
 const draft={...t(null,'claude','local'),navId:'local_draft'};
 let s=allocate(null,[inv([draft],'claude','local')]);
 assert.equal(s.slots[0].navId,'local_draft');assert.equal(s.slots[0].nativeId,null);
 const ranks=s.pinRanks;
 s=allocate(s,[inv([{...draft,nativeId:'started'}],'claude','local')]);
 assert.equal(s.slots[0].nativeId,'started');assert.deepEqual(s.pinRanks,ranks);
 s=allocate(s,[inv([],'claude','local')]);assert.deepEqual(s.slots,Array(6).fill(null));
});
test('native IDs distinguish hosts and providers; archived pins excluded; empty lights off',()=>{
 const s=allocate(null,[inv([t('one')]),inv([t('one','claude')],'claude'),inv([t('one','codex','local')],'codex','local'),inv([{...t('old','claude','local'),archived:true}],'claude','local')]);
 assert.equal(new Set(s.slots.filter(Boolean).map(identity)).size,3);
 assert.deepEqual(frame(['empty'])[0],{id:12,c:0,b:0,e:0,s:.3,sk:0,sa:0});
});
test('Claude layer includes six Claude pins even when Mixed is full of newer Codex pins',()=>{
 const claude=Array.from({length:7},(_,i)=>({...t('claude-'+i,'claude',i%2?'local':'server-a'),navId:'nav-'+i}));
 const sources=[inv(claude.filter(t=>t.host==='local'),'claude','local'),inv(claude.filter(t=>t.host==='server-a'),'claude','server-a')];
 let mixed=allocate(null,sources),only=allocate(null,sources);
 mixed=allocate(mixed,[...sources,inv(Array.from({length:6},(_,i)=>t('codex-'+i)))]);
 assert.ok(mixed.slots.every(t=>t.provider==='codex'));assert.ok(only.slots.every(t=>t.provider==='claude'));
 assert.equal(assignedClaude(mixed,only).length,6);
 const removed=only.slots[0];only=allocate(only,sources.map(s=>({...s,tasks:s.tasks.filter(t=>t.nativeId!==removed.nativeId)})));
 assert.equal(only.slots.filter(Boolean).length,6);assert.ok(!only.slots.some(t=>t.nativeId===removed.nativeId));
 only=allocate(only,sources);assert.ok(only.slots.some(t=>t.nativeId===removed.nativeId));
 const both=allocate(null,sources);assert.equal(assignedClaude(both,both).length,6);
 assert.deepEqual(frame(Array(6).fill('working'),6).map(x=>x.id),[6,7,8,9,10,11]);
 assert.deepEqual(frame(Array(6).fill('working'),12).map(x=>x.id),[12,13,14,15,16,17]);
 assert.throws(()=>frame(['working'],0));
 for(let i=0;i<6;i++){assert.deepEqual(agentSlot('AG'+String(6+i).padStart(2,'0')),{layer:2,index:i});assert.deepEqual(agentSlot('AG'+(12+i)),{layer:3,index:i});}
 assert.equal(agentSlot('AG00'),null);assert.equal(agentSlot('ACT06'),null);
});
