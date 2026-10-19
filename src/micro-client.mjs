import net from 'node:net';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {codexIpcEndpoint,localEndpoint} from './ipc-endpoint.mjs';
import {PREFIX,PROTOCOL,EVENTS,banks as validateBanks,lightingFrame,deviceState,eventValue} from './micro-protocol.mjs';

const MAX_FRAME=1024*1024;
const unavailable=cause=>Object.assign(Error('Codex Micro host integration is unavailable. A Codex build registering the micro-agent-bridge service adapter is required.',{cause}),{code:'MICRO_UNAVAILABLE'});

export class MicroServiceClient extends EventEmitter {
  constructor({endpoint=codexIpcEndpoint(),timeout=3000}={}) {
    super();
    this.endpoint=localEndpoint(endpoint);
    if(!Number.isInteger(timeout)||timeout<1||timeout>30000)throw Error('Invalid IPC deadline');
    this.timeout=timeout;this.pending=new Map();this.socket=null;this.clientId=null;
    this.ready=false;this.capabilities=null;this.connecting=null;
  }

  connect({banks=[]}={}) {
    const requested=validateBanks(banks);
    if(this.connecting) {
      if(JSON.stringify(requested)!==JSON.stringify(this.requested))return Promise.reject(Error('Another bank negotiation is in progress'));
      return this.connecting;
    }
    if(this.ready) {
      if(JSON.stringify(requested)!==JSON.stringify(this.capabilities.banks))return Promise.reject(Error('Close the current session before changing banks'));
      return Promise.resolve(this.capabilities);
    }
    this.requested=requested;
    this.connecting=this.open(requested).finally(()=>{this.connecting=null;});
    return this.connecting;
  }

  async open(requested) {
    const socket=this.socket=net.connect(this.endpoint);
    let buffer=Buffer.alloc(0);
    socket.on('error',error=>this.disconnect(error,socket));
    socket.on('close',()=>this.disconnect(Error('Codex IPC disconnected'),socket));
    socket.on('data',bytes=>{
      if(this.socket!==socket)return;
      try {
        buffer=Buffer.concat([buffer,bytes]);
        while(buffer.length>=4) {
          const n=buffer.readUInt32LE(0);
          if(n===0||n>MAX_FRAME)throw Error('Invalid or oversized IPC frame');
          if(buffer.length<n+4)break;
          const value=JSON.parse(buffer.subarray(4,n+4).toString('utf8'));
          buffer=buffer.subarray(n+4);this.message(value);
        }
      }catch(e){this.disconnect(e,socket);}
    });
    try {
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>finish(Error('Codex IPC connection deadline')),this.timeout);
        const finish=error=>{
          clearTimeout(timer);socket.off('connect',onConnect);socket.off('error',onError);socket.off('close',onClose);
          error?reject(error):resolve();
        };
        const onConnect=()=>finish(),onError=error=>finish(error),onClose=()=>finish(Error('Codex IPC closed'));
        socket.once('connect',onConnect);socket.once('error',onError);socket.once('close',onClose);
      });
      const initialized=await this.request('initialize',{clientType:'micro-agent-bridge'},0);
      if(typeof initialized?.clientId!=='string'||!initialized.clientId)throw Error('Invalid Codex IPC initialization');
      this.clientId=initialized.clientId;
      let hello;
      try{hello=await this.request(PREFIX+'initialize',{protocol:PROTOCOL,banks:requested});}
      catch(e){if(e.code==='IPC_DEADLINE'||/method.*(?:not found|unsupported|not allowed)|no.*handler|no-client-found/i.test(e.message))throw unavailable(e);throw e;}
      if(hello?.protocol!==PROTOCOL||!Array.isArray(hello.events)||hello.events.some(x=>!EVENTS.includes(x)))throw unavailable(Error('Unsupported host capabilities'));
      const granted=validateBanks(hello.banks);
      if(JSON.stringify(granted)!==JSON.stringify(requested))throw Error('Host granted unexpected lighting banks');
      this.capabilities={protocol:PROTOCOL,banks:granted,allowedBanks:validateBanks(hello.allowedBanks),events:[...hello.events],profileWrite:false};
      this.ready=true;return this.capabilities;
    }catch(e){this.disconnect(e,socket);throw e;}
  }

  request(method,params,version=1) {
    if(!this.socket||this.socket.destroyed)return Promise.reject(Error('Codex IPC is not connected'));
    if(this.pending.size>=8)return Promise.reject(Error('Too many outstanding Micro requests'));
    const requestId=crypto.randomUUID();
    const bytes=Buffer.from(JSON.stringify({type:'request',requestId,sourceClientId:this.clientId??'initializing-client',version,method,params}));
    if(bytes.length>MAX_FRAME)return Promise.reject(Error('Oversized IPC request'));
    const header=Buffer.alloc(4);header.writeUInt32LE(bytes.length);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        const error=Object.assign(Error('Codex IPC request deadline: '+method),{code:'IPC_DEADLINE'});
        // A timed-out lighting request may already be queued. Drop the entire
        // session; never retry a write or reuse an uncertain ownership lease.
        this.disconnect(error);
      },this.timeout);
      this.pending.set(requestId,{method,resolve,reject,timer});
      try{this.write(Buffer.concat([header,bytes]));}catch(e){this.disconnect(e);}
    });
  }

  write(bytes) {
    if(!this.socket||this.socket.destroyed)throw Error('Codex IPC disconnected');
    if(this.socket.writableLength>MAX_FRAME)throw Error('Codex IPC backpressure limit');
    this.socket.write(bytes);
  }

  message(value) {
    if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.type!=='string')throw Error('Invalid IPC message');
    if(value.type==='response') {
      const p=this.pending.get(value.requestId);if(!p)return;
      // Router errors (such as no-client-found) have no method field.
      if((value.resultType==='success'||value.method!==undefined)&&value.method!==p.method)throw Error('Mismatched IPC response');
      clearTimeout(p.timer);this.pending.delete(value.requestId);
      if(value.resultType==='success')p.resolve(value.result);
      else p.reject(Error(typeof value.error==='string'?value.error:typeof value.error?.message==='string'?value.error.message:'Codex IPC request rejected'));
      return;
    }
    if(value.type==='client-discovery-request') {
      const bytes=Buffer.from(JSON.stringify({type:'client-discovery-response',requestId:value.requestId,response:{canHandle:false}}));
      const header=Buffer.alloc(4);header.writeUInt32LE(bytes.length);this.write(Buffer.concat([header,bytes]));return;
    }
    if(!this.ready||value.type!=='broadcast'||value.method!==PREFIX+'event')return;
    const raw=value.params;
    let event;
    if(raw?.event==='input')event=eventValue('v.oai.hid',raw);
    else if(raw?.event==='layer')event=eventValue('kb.radial',raw);
    else if(raw?.event==='state')event={event:'state',...deviceState(raw,raw.layerIndex)};
    else if(raw?.event==='invalidate')event={event:'invalidate',reason:['connection-changed','consent-changed','suspend','resume','service-stop'].includes(raw.reason)?raw.reason:'connection-changed'};
    if(event)this.emit(event.event,event);
  }

  disconnect(error=Error('Micro client closed'),socket=this.socket) {
    if(socket!==this.socket||!socket)return;
    const wasReady=this.ready;
    this.socket=null;this.clientId=null;this.ready=false;this.capabilities=null;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    socket.destroy();if(wasReady)this.emit('lost',error);
  }

  async status() {
    if(!this.ready)throw Error('Micro client is not connected');
    const result=await this.request(PREFIX+'status',{});
    return deviceState(result,result?.layerIndex);
  }
  async lights(value) {
    if(!this.ready)throw Error('Micro client is not connected');
    return this.request(PREFIX+'lights',{frame:lightingFrame(value,this.capabilities.banks)});
  }
  async subscribe(events=EVENTS) {
    if(!this.ready)throw Error('Micro client is not connected');
    if(!Array.isArray(events)||events.length>EVENTS.length||events.some(x=>!EVENTS.includes(x)))throw Error('Invalid event subscription');
    return this.request(PREFIX+'subscribe',{events});
  }
  async close() {
    try{if(this.ready)await this.request(PREFIX+'release',{});}
    finally{this.disconnect();}
  }
}
