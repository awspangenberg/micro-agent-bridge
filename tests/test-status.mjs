import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CodexStatus} from '../src/codex-ipc.mjs';
const t={provider:'codex',host:'server-a',nativeId:'one',hostId:'remote-ssh-discovered:server-a'};
function client(){const c=new CodexStatus();c.client='test';c.tasks=[t];return c;}
function change(c,body){c.message({type:'broadcast',method:'thread-stream-state-changed',params:{hostId:t.hostId,conversationId:t.nativeId,change:body}});}
function snapshot(c,runtime='active',status='inProgress'){
 change(c,{type:'snapshot',revision:1,conversationState:{threadRuntimeStatus:{type:runtime,activeFlags:[]},requests:[],turnHistory:{history:{entitiesByKey:{a:{status}}}}}});
}
test('green requires an observed completion of the actual active turn',()=>{
 const c=client();snapshot(c);
 change(c,{type:'patches',revision:2,patches:[{path:['turnHistory','history','entitiesByKey','a','hookRuns',0,'run','status'],value:'completed'},{path:['threadRuntimeStatus'],value:{type:'idle'}}]});
 assert.equal(c.state(t),'idle');
 change(c,{type:'patches',revision:3,patches:[{path:['turnHistory','history','entitiesByKey','a','status'],value:'completed'}]});
 assert.equal(c.state(t),'completed');
 snapshot(c,'idle','completed');assert.equal(c.state(t),'idle');
});
test('missed revisions and missing tasks are unknown; disconnect is red; errors never green',()=>{
 const c=client();assert.equal(c.state(t),'unknown');snapshot(c);
 change(c,{type:'patches',revision:2,patches:[{path:['turnHistory','history','entitiesByKey','a','status'],value:'failed'},{path:['threadRuntimeStatus'],value:{type:'idle'}}]});assert.equal(c.state(t),'error');
 change(c,{type:'patches',revision:4,patches:[]});assert.equal(c.state(t),'unknown');
 c.client=null;assert.equal(c.state(t),'disconnected');
});
test('approval and user-input flags override active working status',()=>{
 const c=client();snapshot(c);
 change(c,{type:'patches',revision:2,patches:[{path:['threadRuntimeStatus'],value:{type:'active',activeFlags:['waitingOnApproval']}}]});assert.equal(c.state(t),'awaiting_input');
});
