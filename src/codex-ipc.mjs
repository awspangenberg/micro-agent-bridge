import net from 'node:net';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import os from 'node:os';
export class CodexStatus extends EventEmitter {
 constructor(){super();this.tasks=[];this.live=new Map();this.client=null;this.lastMessage=0;}
 update(tasks){const old=this.tasks;this.tasks=tasks;for(const t of old)if(!tasks.some(x=>x.nativeId===t.nativeId&&x.hostId===t.hostId))this.follow(t,false);for(const t of tasks)if(!old.some(x=>x.nativeId===t.nativeId&&x.hostId===t.hostId))this.follow(t,true);}
 send(x){if(!this.socket||this.socket.destroyed)return;const b=Buffer.from(JSON.stringify(x)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);this.socket.write(Buffer.concat([h,b]));}
 follow(t,following){if(this.client)this.send({type:'broadcast',sourceClientId:this.client,version:1,method:'thread-stream-following-changed',params:{hostId:t.hostId,conversationId:t.nativeId,following}});}
 refresh(){this.live.clear();for(const t of this.tasks){this.follow(t,false);this.follow(t,true);}}
 connect(){
  if(this.socket&&!this.socket.destroyed)return;
  this.client=null;let buffer=Buffer.alloc(0);const socket=this.socket=net.connect(os.homedir()+'/.codex/ipc/ipc.sock');
  socket.on('connect',()=>this.send({type:'request',requestId:crypto.randomUUID(),sourceClientId:'initializing-client',method:'initialize',version:0,params:{clientType:'micro-mixed'}}));
  socket.on('error',()=>{});socket.on('close',()=>{this.client=null;this.live.clear();this.emit('lost');});
  socket.on('data',data=>{buffer=Buffer.concat([buffer,data]);try{while(buffer.length>=4){const n=buffer.readUInt32LE();if(n>64*1024*1024)throw Error('Oversized IPC frame');if(buffer.length<n+4)break;const x=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4);this.message(x);}}catch{socket.destroy();}});
 }
 message(x){
  this.lastMessage=Date.now();
  if(x.type==='response'&&x.method==='initialize'&&x.resultType==='success'){this.client=x.result.clientId;for(const t of this.tasks)this.follow(t,true);return;}
  if(x.type==='client-discovery-request'){this.send({type:'client-discovery-response',requestId:x.requestId,response:{canHandle:false}});return;}
  if(x.type!=='broadcast'||x.method!=='thread-stream-state-changed')return;
  const p=x.params??{},t=this.tasks.find(t=>t.hostId===p.hostId&&t.nativeId===p.conversationId);if(!t)return;
  const key=`${t.host}:${t.nativeId}`,c=p.change??{};let live=this.live.get(key);
  if(c.type==='snapshot'){
   const v=c.conversationState??{};const entities=v.turnHistory?.history?.entitiesByKey??{};
   live={revision:c.revision,runtime:v.threadRuntimeStatus,title:v.title,requests:(v.requests??[]).length,completed:false,turnError:false,turnStates:Object.fromEntries(Object.entries(entities).map(([k,x])=>[k,x.status])),receivedAt:Date.now()};
  }else if(c.type==='patches'){
   if(!live||c.revision!==live.revision+1){this.live.delete(key);this.follow(t,false);this.follow(t,true);return;}
   live={...live,revision:c.revision,receivedAt:Date.now()};
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
  }else return;
  this.live.set(key,live);this.emit('state',t,this.state(t));
 }
 state(t){
  if(!this.client)return 'disconnected';const x=this.live.get(`${t.host}:${t.nativeId}`);if(!x)return 'unknown';
  const r=x.runtime;if(!r)return 'unknown';
  if(r.type==='systemError'||x.turnError)return 'error';if(r.type==='notLoaded')return 'unknown';
  if(x.requests>0||(r.activeFlags??[]).some(x=>/waitingOnApproval|waitingOnUserInput/.test(x)))return 'awaiting_input';
  if(r.type==='active')return 'working';if(r.type==='idle')return x.completed?'completed':'idle';return 'unknown';
 }
 close(){for(const t of this.tasks)this.follow(t,false);this.socket?.end();}
}
