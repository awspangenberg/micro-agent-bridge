import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {ROOT,STATE,config as loadConfig} from './paths.mjs';
import {appInfo,compatibility} from './platform.mjs';
const config=loadConfig(), info=appInfo('codex',config);
if(!info)throw Error('Codex desktop is not installed');
const adapter=compatibility.adapters.find(a=>a.platform===process.platform&&a.arch===process.arch&&a.version===info.version&&(!a.build||a.build===info.build));
if(!adapter)throw Error('This Codex desktop build has no qualified HID adapter');
const APP=info.root,EXEC=info.exec,ASAR=info.asar,SHA=adapter.asarSHA256,MODULE=ASAR+'/'+adapter.module;
const root=STATE+'/transport';
const recoveryOptions={persistent:true,claudeLayer:true,expectedVersion:adapter.version,socketPath:STATE+'/transport.sock',takeoverLayers:config.ownedLayers??[]};
fs.mkdirSync(root,{recursive:true,mode:0o700});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=x=>{const s=JSON.stringify({at:new Date().toISOString(),...x})+'\n';fs.appendFileSync(root+'/install.jsonl',s,{mode:0o600});process.stdout.write(s)};
const occupied=()=>new Promise(resolve=>{const s=net.connect(9229,'127.0.0.1');s.setTimeout(500);s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));s.once('timeout',()=>{s.destroy();resolve(true)})});
class CDP {
 constructor(ws){this.ws=ws;this.n=0;this.pending=new Map();ws.addEventListener('message',ev=>{let m;try{m=JSON.parse(ev.data)}catch{return}const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)});}
 call(method,params={},ms=8000){return new Promise((resolve,reject)=>{const id=++this.n;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP deadline: '+method))},ms);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}))})}
 async eval(expression,ms=8000){const r=await this.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,timeout:ms-1500},ms);if(r.exceptionDetails)throw new Error('Runtime evaluation failed: '+(r.exceptionDetails.exception?.description?.split('\n')[0]??r.exceptionDetails.text));return r.result.value}
 close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('closed'))}this.pending.clear();this.ws.close()}
}
async function reclaimSocket(){
 const file=STATE+'/transport.sock';if(!fs.existsSync(file))return;
 const stat=fs.lstatSync(file);if(!stat.isSocket()||stat.uid!==process.getuid())throw Error('Unexpected transport path owner/type');
 const code=await new Promise(resolve=>{const socket=net.connect(file);socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve('active')});socket.once('error',e=>resolve(e.code));socket.once('timeout',()=>{socket.destroy();resolve('timeout')});});
 if(!['ECONNREFUSED','ENOENT'].includes(code))throw Error('Transport socket is active or ownership cannot be established');
 const current=fs.lstatSync(file);if(current.ino!==stat.ino||current.dev!==stat.dev)throw Error('Transport socket changed during recovery');fs.unlinkSync(file);
}
let c,opened=false;
try {
 await reclaimSocket();
 const hash=crypto.createHash('sha256').update(fs.readFileSync(ASAR)).digest('hex');if(hash!==SHA)throw new Error('Unsupported bundle hash');
 const version=info.version;
 if(process.platform==='darwin')execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',APP],{stdio:'pipe',timeout:15000});
 const pids=execFileSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'}).split('\n').map(l=>l.trim().match(/^(\d+)\s+(.+)$/)).filter(m=>m?.[2]===EXEC).map(m=>Number(m[1]));if(pids.length!==1)throw new Error('Expected one Codex process');
 if(await occupied())throw new Error('Inspector port occupied before trial; refusing to take ownership');
 log({preflight:{pid:pids[0],version,asar_sha256:hash,signature_verified:true,inspector_preexisting:false}});
 process.kill(pids[0],'SIGUSR1');opened=true;
 let target;for(let i=0;i<40;i++){try{const res=await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(400)});target=(await res.json()).find(x=>x.webSocketDebuggerUrl);if(target)break}catch{}await sleep(100)}if(!target)throw new Error('Inspector did not open');
 const ws=new WebSocket(target.webSocketDebuggerUrl);await Promise.race([new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',()=>j(new Error('Inspector socket failed')),{once:true})}),sleep(4000).then(()=>{throw new Error('Inspector connect deadline')})]);c=new CDP(ws);
 const identity=await c.eval('({pid:process.pid,execPath:process.execPath,node:process.versions.node,electron:process.versions.electron})');if(identity.pid!==pids[0]||identity.execPath!==EXEC)throw new Error('Inspector process identity mismatch');log({identity});
 const group='micro-shared-native-inspection';
 await c.call('Debugger.enable');
 const breaks=[];
 try {
  for(const name of ['getState','applyLighting','handleHidEvent','refreshBatteryStatus']){
   const fn=await c.call('Runtime.evaluate',{expression:`process.getBuiltinModule('module').createRequire(${JSON.stringify(MODULE)})(${JSON.stringify(MODULE)}).CodexMicroService.prototype[${JSON.stringify(name)}]`,objectGroup:group});
   if(fn.exceptionDetails||!fn.result.objectId)throw new Error('Native function unavailable: '+name);
   const b=await c.call('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId,condition:'(this && typeof this.getState === "function" && (globalThis.__microNativeTrialCandidate=this),false)'});breaks.push(b.breakpointId);
  }
  let found=false;for(let i=0;i<260;i++){found=await c.eval('!!globalThis.__microNativeTrialCandidate');if(found)break;await sleep(500)}
  if(!found)throw new Error('No natural native service call within capture deadline');
  const shape=await c.eval(`(()=>{const s=globalThis.__microNativeTrialCandidate;return {state:s.getState(),lifecycle:s.lifecycleState,connectionAttemptId:s.connectionAttemptId,serviceFields:Object.keys(s),serviceMethods:Object.getOwnPropertyNames(Object.getPrototypeOf(s)),apiFields:s.api?Object.keys(s.api):null,apiMethods:s.api?Object.getOwnPropertyNames(Object.getPrototypeOf(s.api)):null,commFields:s.comm?Object.keys(s.comm):null,commMethods:s.comm?Object.getOwnPropertyNames(Object.getPrototypeOf(s.comm)):null,rpcFields:s.api?.api?Object.keys(s.api.api):null,rpcMethods:s.api?.api?Object.getOwnPropertyNames(Object.getPrototypeOf(s.api.api)):null,code:{threads:s.api?.sendThreadsLighting.toString(),status:s.api?.getDeviceStatus.toString(),hid:s.api?.onHidReceived.toString(),send:s.comm?.sendJsonRpcRequest.toString(),process:s.comm?.process.toString(),enqueue:s.comm?.enqueue.toString(),fileRead:s.api?.api?.readFileChunked?.toString(),client:s.api?.api?.getRpcClient?.toString()}}})()`);
  log({native_connection:shape.state,queue_verified:shape.code.send.includes('this.enqueue'),native_hid_listener_present:!!shape.apiMethods?.includes('onHidReceived')});
  for(const breakpointId of breaks)await c.call('Debugger.removeBreakpoint',{breakpointId});breaks.length=0;await c.call('Debugger.disable');
  const installed=await c.eval(`(async()=>{if(globalThis.__microMixedTransport)throw Error('Trial already installed');const require=process.getBuiltinModule('module').createRequire(${JSON.stringify(MODULE)});const file=${JSON.stringify(ROOT+'/bridge.cjs')};for(const own of [file,file.replace('bridge.cjs','reader.cjs')])delete require.cache[require.resolve(own)];const factory=require(file);const bridge=await factory(globalThis.__microNativeTrialCandidate,${JSON.stringify(root)},${JSON.stringify(recoveryOptions)});globalThis.__microMixedTransport=bridge;return bridge.health()})()`,90000);
  log({installed});
 } finally {
  for(const breakpointId of breaks)await c.call('Debugger.removeBreakpoint',{breakpointId}).catch(()=>{});
  await c.call('Debugger.disable').catch(()=>{});
  await c.eval('delete globalThis.__microNativeTrialCandidate').catch(()=>{});
 }
 await c.call('Runtime.releaseObjectGroup',{objectGroup:group});
} catch(e){log({error:e.message});process.exitCode=1}
finally {
 if(c){try{await c.eval(`(()=>{setTimeout(()=>process.getBuiltinModule('inspector').close(),100);return true})()`)}catch(e){log({inspector_close_error:e.message})}c.close()}
 if(opened){for(let i=0;i<30&&await occupied();i++)await sleep(100);log({inspector_closed:!(await occupied())})}
}
