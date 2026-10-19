import net from 'node:net';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {codexIpcEndpoint} from './ipc-endpoint.mjs';
export class CodexStatus extends EventEmitter {
 constructor({endpoint=codexIpcEndpoint(),now=Date.now,refreshMs=5000,initializeTimeout=5000}={}){
  super();Object.assign(this,{endpoint,now,refreshMs,initializeTimeout});
  this.tasks=[];this.live=new Map();this.followedAt=new Map();this.client=null;this.lastMessage=0;
 }
 key(t){return `${t.host}:${t.nativeId}`;}
 update(tasks){
  const old=this.tasks;this.tasks=tasks;
  for(const t of old)if(!tasks.some(x=>x.nativeId===t.nativeId&&x.hostId===t.hostId)){
   this.follow(t,false);this.live.delete(this.key(t));this.followedAt.delete(this.key(t));
  }
  for(const t of tasks)if(!old.some(x=>x.nativeId===t.nativeId&&x.hostId===t.hostId))this.follow(t,true);
 }
 send(x){if(!this.socket||this.socket.destroyed)return;const b=Buffer.from(JSON.stringify(x)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);this.socket.write(Buffer.concat([h,b]));}
 follow(t,following){
  if(!this.client)return;
  if(following)this.followedAt.set(this.key(t),this.now());
  this.send({type:'broadcast',sourceClientId:this.client,version:1,method:'thread-stream-following-changed',params:{hostId:t.hostId,conversationId:t.nativeId,following}});
 }
 refresh(){this.live.clear();for(const t of this.tasks){this.follow(t,false);this.follow(t,true);}}
 retryMissing(){
  if(!this.client)return;
  for(const t of this.tasks){
   const runtime=this.live.get(this.key(t))?.runtime;
   // The host usually starts before Codex. Its first follow can precede the
   // renderer owning this chat, without closing the otherwise healthy pipe.
   if((!runtime||runtime.type==='notLoaded')&&this.now()-(this.followedAt.get(this.key(t))??-Infinity)>=this.refreshMs){
    this.follow(t,false);this.follow(t,true);
   }
  }
 }
 connect(){
  if(this.socket&&!this.socket.destroyed){this.retryMissing();return;}
  this.client=null;this.live.clear();this.followedAt.clear();let buffer=Buffer.alloc(0);
  const socket=this.socket=net.connect(this.endpoint),requestId=crypto.randomUUID();
  this.initializeRequestId=requestId;
  clearTimeout(this.initializeTimer);
  this.initializeTimer=setTimeout(()=>{if(this.socket===socket&&!this.client)socket.destroy();},this.initializeTimeout);
  this.initializeTimer.unref?.();
  socket.on('connect',()=>{if(this.socket===socket)this.send({type:'request',requestId,sourceClientId:'initializing-client',method:'initialize',version:0,params:{clientType:'micro-mixed'}});});
  socket.on('error',()=>{});
  socket.on('close',()=>{
   if(this.socket!==socket)return;
   clearTimeout(this.initializeTimer);this.initializeRequestId=null;this.client=null;this.live.clear();this.followedAt.clear();this.emit('lost');
  });
  socket.on('data',data=>{
   if(this.socket!==socket)return;
   buffer=Buffer.concat([buffer,data]);
   try{while(buffer.length>=4){const n=buffer.readUInt32LE();if(n>64*1024*1024)throw Error('Oversized IPC frame');if(buffer.length<n+4)break;const x=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4);this.message(x);}}catch{socket.destroy();}
  });
 }
 message(x){
  this.lastMessage=this.now();
  if(x.type==='response'&&this.initializeRequestId&&x.requestId===this.initializeRequestId){
   clearTimeout(this.initializeTimer);this.initializeRequestId=null;
   if(x.resultType!=='success'||typeof x.result?.clientId!=='string'||!x.result.clientId){this.socket?.destroy();return false;}
   this.client=x.result.clientId;for(const t of this.tasks)this.follow(t,true);return false;
  }
  if(x.type==='client-discovery-request'){this.send({type:'client-discovery-response',requestId:x.requestId,response:{canHandle:false}});return false;}
  if(x.type!=='broadcast'||!this.client)return false;
  const p=x.params??{};
  // Owners request followers again when a renderer opens or changes ownership.
  // Reannounce on discovery too, so opening Codex after the host recovers at once.
  if(x.method==='client-status-changed'){
   if(p.status==='connected'){for(const t of this.tasks)this.follow(t,true);}
   else if(p.status==='disconnected'&&p.clientId){
    for(const t of this.tasks)if(this.live.get(this.key(t))?.ownerClientId===p.clientId){this.live.delete(this.key(t));this.follow(t,true);}
   }
   return false;
  }
  if(x.method==='ipc-connection-reset'){this.refresh();return false;}
  const t=this.tasks.find(t=>t.hostId===p.hostId&&t.nativeId===p.conversationId);if(!t)return false;
  if(x.method==='thread-stream-following-status-requested'){this.follow(t,true);return false;}
  if(x.method!=='thread-stream-state-changed')return false;
  const key=`${t.host}:${t.nativeId}`,c=p.change??{};let live=this.live.get(key);
  if(c.type==='snapshot'){
   const v=c.conversationState??{};const entities=v.turnHistory?.history?.entitiesByKey??{};
   live={revision:c.revision,ownerClientId:x.sourceClientId,runtime:v.threadRuntimeStatus,title:v.title,requests:(v.requests??[]).length,completed:false,turnError:false,turnStates:Object.fromEntries(Object.entries(entities).map(([k,x])=>[k,x.status])),receivedAt:this.now()};
  }else if(c.type==='patches'){
   if(live?.ownerClientId&&x.sourceClientId!==live.ownerClientId)return false;
   // Current Codex batches carry their base revision. Retain compatibility with
   // older publishers that only sent consecutive revision numbers.
   if(!live||(c.baseRevision===undefined?c.revision!==live.revision+1:c.baseRevision!==live.revision)){
    this.live.delete(key);this.follow(t,false);this.follow(t,true);return false;
   }
   live={...live,revision:c.revision,receivedAt:this.now()};
   for(const patch of c.patches??[]){const path=patch.path??[];
    if(path.length===1&&path[0]==='title')live.title=patch.value;
    if(path[0]==='threadRuntimeStatus'){
     if(path.length===1)live.runtime=patch.value;
     else if(path.length===2)live.runtime={...live.runtime,[path[1]]:patch.value};
     if(live.runtime?.type==='active'&&this.live.get(key)?.runtime?.type!=='active'){live.completed=false;live.turnError=false;}
    }
    if(path[0]==='requests'){if(path.length===1)live.requests=(patch.value??[]).length;else if(patch.op==='add')live.requests++;else if(patch.op==='remove')live.requests=Math.max(0,live.requests-1);}
    // Ignore item/hook completion and loaded historical turns. Observe the turn itself.
    if(path[0]==='turnHistory'&&path[1]==='history'&&path[2]==='entitiesByKey'&&((path.length===5&&path[4]==='status')||path.length===4)){
     const id=path[3],status=path.length===5?patch.value:patch.value?.status,old=live.turnStates[id];
     if(status==='inProgress'){live.completed=false;live.turnError=false;}
     if(old==='inProgress'&&status==='completed')live.completed=true;
     if(status==='failed'){live.completed=false;live.turnError=true;}
     if(status==='interrupted'){live.completed=false;live.turnError=false;}
     if(typeof status==='string')live.turnStates={...live.turnStates,[id]:status};
    }
   }
  }else return false;
  this.live.set(key,live);this.emit('state',t,this.state(t));return true;
 }
 state(t){
  if(!this.client)return 'disconnected';const x=this.live.get(`${t.host}:${t.nativeId}`);if(!x)return 'unknown';
  const r=x.runtime;if(!r)return 'unknown';
  if(r.type==='systemError'||x.turnError)return 'error';if(r.type==='notLoaded')return 'unknown';
  if(x.requests>0||(r.activeFlags??[]).some(x=>/waitingOnApproval|waitingOnUserInput/.test(x)))return 'awaiting_input';
  if(r.type==='active')return 'working';if(r.type==='idle')return x.completed?'completed':'idle';return 'unknown';
 }
 close(){clearTimeout(this.initializeTimer);this.initializeRequestId=null;for(const t of this.tasks)this.follow(t,false);this.client=null;this.live.clear();this.followedAt.clear();this.socket?.end();}
}
