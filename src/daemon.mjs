import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {allocate,identity,frame,agentSlot,assignedClaude} from './slots.mjs';
import {CodexStatus} from './codex-ipc.mjs';
import {ROOT,STATE,PY,config as loadConfig,atomic,env} from './paths.mjs';
import {presence,claudeSupported as supportsClaude,openRoute,menuCommand} from './platform.mjs';
import {Remotes} from './remotes.mjs';
import {acquireLock} from './lock.mjs';
fs.mkdirSync(STATE,{recursive:true,mode:0o700});
const config=loadConfig(), remotes=new Remotes(config.hosts);
const releaseLock=acquireLock(STATE+'/daemon.pid');
const log=x=>fs.appendFileSync(STATE+'/events.jsonl',JSON.stringify({at:new Date().toISOString(),...x})+'\n',{mode:0o600});
const run=(file,args,timeout=4000)=>new Promise((resolve,reject)=>execFile(file,args,{timeout,maxBuffer:1024*1024,env:env()},(e,out)=>e?reject(e):resolve(out)));
let saved;try{saved=JSON.parse(fs.readFileSync(STATE+'/assignments.json'))}catch{}
let claudeAssignment;try{claudeAssignment=JSON.parse(fs.readFileSync(STATE+'/claude-assignments.json'))}catch{}
claudeAssignment??={slots:Array(6).fill(null),waiting:[]};
let assignment=saved??{slots:Array(6).fill(null),waiting:[]},local=null,remote=null,remoteAt=0,remoteChild=null,remoteSeq=0,remoteGeneration=0,remoteAttempt=0,localAt=0;
let connection=null,transport=null,transportBuffer='',requestId=0,transportReady=false,currentLayer=null,selected=null,ui=null,uiBuffer='',uiReady=false,uiState={},stopping=false,painting=false,lastFrame='',lastPoll=0,lastHealth=0,lastRemoteSend=0,inventoryBusy=false,lastInventory=0,lastUiStart=0,versionChecked=0,claudeSupported=false,appPresence={codex:false,claude:false};
const pending=new Map(),codex=new CodexStatus();
let attaching=false,lastAttach=0,attachError=null;
const invalid=reason=>{const changed=selected||uiState.reason!==reason;selected=null;uiState={armed:false,reason};sendUI({command:'invalidate',reason});if(changed){log({authorization_cleared:reason});if(/sleep|suspend|resume|disconnected/.test(reason))codex.refresh();}};
function sendUI(message){if(ui?.stdin.writable)ui.stdin.write(JSON.stringify(message)+'\n');}
function startUI(){
 if(ui||Date.now()-lastUiStart<5000)return;lastUiStart=Date.now();
 const [program,...args]=menuCommand();
 ui=spawn(program,[...args,STATE],{stdio:['pipe','pipe','pipe']});ui.stdout.on('data',b=>{uiBuffer+=b;let i;while((i=uiBuffer.indexOf('\n'))>=0){const line=uiBuffer.slice(0,i);uiBuffer=uiBuffer.slice(i+1);try{const x=JSON.parse(line);if(x.event==='ready')uiReady=true;if(x.event==='selection')uiState=x;if(x.event==='action')log(x);if(x.event==='selectSlot')selectSlot(x.slot,x.layer??3);if(x.event==='stop')stop();if(x.event==='revoked')invalid(x.reason);}catch{}}});
 ui.stdin.on('error',()=>{selected=null;uiReady=false;});ui.stderr.on('data',()=>{});ui.on('error',e=>log({menu_error:e.code}));ui.on('exit',()=>{ui=null;uiReady=false;selected=null;});
}
function transportCall(method,extra={},timeout=10000){
 return new Promise((resolve,reject)=>{if(!transport||transport.destroyed)return reject(Error('Transport unavailable'));const id=++requestId;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Transport deadline'))},timeout);pending.set(id,{resolve,reject,timer});transport.write(JSON.stringify({id,method,...extra})+'\n');});
}
function connectTransport(){
 if(transport&&!transport.destroyed)return;transportBuffer='';
 const s=transport=net.connect(STATE+'/transport.sock');s.on('error',()=>{});
 s.on('close',()=>{transportReady=false;connection=null;currentLayer=null;lastFrame='';invalid('transport-disconnected');for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Transport disconnected'));}pending.clear();});
 s.on('data',b=>{transportBuffer+=b;if(transportBuffer.length>1048576){s.destroy();return;}let i;while((i=transportBuffer.indexOf('\n'))>=0){const line=transportBuffer.slice(0,i);transportBuffer=transportBuffer.slice(i+1);let x;try{x=JSON.parse(line)}catch{continue;}
  if(x.id!=null){const p=pending.get(x.id);if(p){pending.delete(x.id);clearTimeout(p.timer);x.error?p.reject(Error(x.error)):p.resolve(x.result);}continue;}
  if(x.event==='invalidate'){lastFrame='';currentLayer=null;invalid(x.reason);}
  if(x.event==='layer'){const v=x.value?.layer_index??x.value?.layerIndex;if(Number.isInteger(v))invalid('layer-changed');}
  if(x.event==='input')onInput(x);
 }});
}
async function ensureTransport(){
 if(attaching||transportReady||connection||transport?.readyState==='open'||!appPresence.codex||Date.now()-lastAttach<20000)return;
 attaching=true;lastAttach=Date.now();
 try{await run(process.execPath,[ROOT+'/install.mjs'],150000);attachError=null;}
 catch(e){attachError='Transport attachment failed; inspect runtime/transport/install.jsonl';log({attach_error:e.message});}
 finally{attaching=false;lastAttach=Date.now();}
}
function onInput(x){
 if(!transportReady||connection?.status!=='connected')return;
 if(/^AG0[0-5]$/.test(x.key)){invalid('native-layer-key');return;}
 const slot=agentSlot(x.key);if(x.act===1&&slot){selectSlot(slot.index,slot.layer);return;}
 if(/^ACT/.test(x.key)){
  if(!selected||!uiReady)return;
  // Native actions are routed by the menu process only with a live AX binding.
  sendUI({command:'action',key:x.key,act:x.act,task:selected,layer:currentLayer});
 }
}
function selectSlot(index,layer=3){
 if(![2,3].includes(layer))return;const view=layer===2?claudeAssignment:assignment;
 let t=view.slots[index];if(!t||!transportReady||!appPresence[t.provider]||(t.provider==='claude'&&!claudeSupported))return;
 const hosts=['local',...config.hosts.map(h=>h.id)].filter(h=>(h==='local'?local?.codexPresence:remotes.rows.get(h)?.data?.codexPresence)?.includes(t.nativeId));
 t={...t,keyboardLayer:layer,hostVerified:t.provider==='claude'||(local?.knownHostsComplete&&Date.now()-localAt<6000&&config.hosts.every(h=>remotes.fresh(h.id))&&hosts.length===1&&hosts[0]===t.host)};
 invalid('agent-key');selected=t;log({selected:identity(t),slot:index+1,layer});
 if(uiReady)sendUI({command:'select',task:t,allTasks:assignment.slots.filter(Boolean)});
 else {
  const url=t.provider==='codex'?`codex://threads/${encodeURIComponent(t.nativeId)}?hostId=${encodeURIComponent(t.hostId)}`:t.navId.startsWith('local_')?`claude://code/continue?session=${encodeURIComponent(t.navId)}`:`claude://code/${encodeURIComponent(t.navId)}`;
  openRoute(url).catch(e=>log({selection_error:e.code}));uiState={armed:false,reason:'Menu accessibility helper unavailable'};
 }
}
function sendAllowlist(){
 const items=assignedClaude(assignment,claudeAssignment);
 atomic(STATE+'/claude-allowlist.json',{timestamp:Date.now()/1000,ids:items.filter(t=>t.host==='local').map(t=>t.nativeId)});
 remotes.send(items,assignment.slots.filter(t=>t?.provider==='codex').map(t=>t.nativeId),local?.claudePins??[]);lastRemoteSend=Date.now();
}
remotes.on('update',()=>reconcile());remotes.on('lost',()=>invalid('ssh-disconnected'));
function reconcile(){
 if(!local)return;
 const meta=[...local.claude,...[...assignment.slots,...assignment.waiting,...claudeAssignment.slots,...claudeAssignment.waiting].filter(t=>t?.provider==='claude')];const claude=[],unresolved=[];
 for(const pin of local.claudePins){let t=meta.find(t=>t.navId===pin||(t.bridgeIds??[]).includes(pin));
  const matches=[...(local.claudeMappings??[]),...[...remotes.rows.values()].filter(r=>remotes.fresh(r.host.id)).flatMap(r=>r.data?.mappings??[])].filter(x=>x.navId===pin);
  if(matches.length===1){t={...t,...matches[0]};}
  else if(matches.length>1){unresolved.push(pin);continue;}
  if(!t){unresolved.push(pin);continue;}if(!t.archived)claude.push({...t,navId:pin});
 }
 const inventories=[
 {provider:'codex',host:'local',available:!!appPresence.codex&&!local.errors?.codex,tasks:local.codex},
 ...config.hosts.map(h=>({provider:'codex',host:h.id,available:h.codexHostIds.length>0&&remotes.fresh(h.id)&&Array.isArray(remotes.rows.get(h.id)?.data?.codex)&&!!appPresence.codex,tasks:h.codexHostIds.length?(remotes.rows.get(h.id)?.data?.codex??[]):[]})),
 ...['local',...config.hosts.map(h=>h.id)].map(host=>({provider:'claude',host,available:!!appPresence.claude&&claudeSupported&&!local.errors?.claude,tasks:claude.filter(t=>t.host===host)}))];
 // An offline host retains old assignments without blocking local-only discovery.
 const known=new Set(['local',...config.hosts.map(h=>h.id)]);
 const supported=v=>({...v,slots:v.slots.map(t=>t&&known.has(t.host)?t:null),waiting:v.waiting.filter(t=>known.has(t.host))});
 const next=allocate(supported(assignment),inventories),nextClaude=allocate(supported(claudeAssignment),inventories.filter(x=>x.provider==='claude'));
 const mixedChanged=JSON.stringify(next)!==JSON.stringify(assignment),claudeChanged=JSON.stringify(nextClaude)!==JSON.stringify(claudeAssignment);
 if(mixedChanged){assignment=next;saved=next;atomic(STATE+'/assignments.json',next);codex.update(next.slots.filter(t=>t?.provider==='codex'));log({assignments:next.slots.map(t=>t?identity(t):null),waiting:next.waiting.length,layer:3});}
 if(claudeChanged){claudeAssignment=nextClaude;atomic(STATE+'/claude-assignments.json',nextClaude);log({assignments:nextClaude.slots.map(t=>t?identity(t):null),waiting:nextClaude.waiting.length,layer:2});}
 if(mixedChanged||claudeChanged){sendAllowlist();const view=selected?.keyboardLayer===2?claudeAssignment:assignment;if(selected&&!view.slots.some(t=>t&&identity(t)===identity(selected)))invalid('task-unpinned');}
 uiState.unresolvedPins=unresolved;
}
async function inventory(){
 if(inventoryBusy)return;inventoryBusy=true;lastInventory=Date.now();
 try{
  appPresence=await presence(config);
  if(Date.now()-versionChecked>15000){claudeSupported=supportsClaude(config);versionChecked=Date.now();}
  const data=JSON.parse(await run(PY,[ROOT+'/pins.py',JSON.stringify(assignment.slots.filter(t=>t?.provider==='codex').map(t=>t.nativeId))]));if(data.error)throw Error(data.error);local=data;localAt=Date.now();reconcile();
 }catch(e){log({pin_reader_error:e.message});}finally{inventoryBusy=false;}
}
let localClaude=[],localHookBusy=false;
async function localHooks(){if(localHookBusy)return;localHookBusy=true;try{const out=await run(PY,[ROOT+'/local_status.py']);localClaude=JSON.parse(out);}catch{localClaude=[];}finally{localHookBusy=false;}}
function taskState(t){
 if(!t)return 'empty';if(!appPresence[t.provider])return 'disconnected';
 if(t.host!=='local'&&!remotes.fresh(t.host))return 'disconnected';
 if(t.provider==='codex')return codex.state(t);
 if(!t.nativeId)return 'unknown';
 if(!claudeSupported)return 'unknown';
 const rows=t.host!=='local'?remotes.rows.get(t.host)?.data?.sessions:localClaude;return rows?.find(r=>r.session_id===t.nativeId)?.state??'unknown';
}
async function paint(){
 if(painting||!transportReady||connection?.status!=='connected')return;
 const states=assignment.slots.map(taskState),claudeStates=claudeAssignment.slots.map(taskState),values=[frame(claudeStates,6),frame(states,12)],key=JSON.stringify(values);if(key===lastFrame)return;
 const previous=lastFrame?JSON.parse(lastFrame):[];
 painting=true;try{for(let i=0;i<values.length;i++)if(JSON.stringify(previous[i])!==JSON.stringify(values[i]))await transportCall('lights',{frame:values[i]});lastFrame=key;log({states,claudeStates});}catch(e){log({lighting_error:e.message});}finally{painting=false;}
}
function publish(){
 const state={updatedAt:new Date().toISOString(),pinPolicy:'six-most-recent-pins',pinRecency:'Observed pin additions; existing pins seeded from sidebar order',connection,layer:currentLayer,sshConnected:config.hosts.every(h=>remotes.fresh(h.id)),hosts:config.hosts.map(h=>({id:h.id,connected:remotes.fresh(h.id)})),codexConnected:!!codex.client,claudeSupported,pinReaderFresh:Date.now()-localAt<6000,attachError,attaching,slots:assignment.slots.map(t=>t?{...t,title:t.provider==='codex'?(codex.live.get(`${t.host}:${t.nativeId}`)?.title??t.title):t.title,state:taskState(t)}:null),waiting:assignment.waiting,claudeSlots:claudeAssignment.slots.map(t=>t?{...t,state:taskState(t)}:null),claudeWaiting:claudeAssignment.waiting,selection:uiState,actionsAvailable:uiState.controls??[],unavailableControls:uiState.unavailable??['FAST','Approve','Reject','SPLIT','Microphone','NEW','Dial','Joystick'],loginEnabled:fs.existsSync(STATE+'/startup-enabled.json')};atomic(STATE+'/state.json',state);
}
let healthBusy=false,statusBusy=false;
const timer=setInterval(()=>{
 if(stopping)return;const now=Date.now();connectTransport();codex.connect();remotes.tick();startUI();ensureTransport();
 if(now-lastInventory>2000)inventory();if(now-lastRemoteSend>2000){sendAllowlist();localHooks();}
 if(!healthBusy&&now-lastHealth>1000){healthBusy=true;lastHealth=now;transportCall('health',{},2500).then(h=>{connection=h.state;transportReady=h.prepared&&!h.suspended&&!h.inputOpen;if(h.prepared)attachError=null;}).catch(()=>{transportReady=false;}).finally(()=>healthBusy=false);}
 if(!statusBusy&&transportReady&&now-lastPoll>2000){statusBusy=true;lastPoll=now;transportCall('status').then(s=>{const layer=s.layer_index;if(currentLayer!==null&&layer!==currentLayer)invalid('layer-changed');currentLayer=layer;}).catch(()=>{}).finally(()=>statusBusy=false);}
 paint();publish();
},250);
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);invalid('helper-stop');codex.close();remotes.close();ui?.stdin.end();atomic(STATE+'/claude-allowlist.json',{timestamp:0,ids:[]});const restore=fs.existsSync(STATE+'/restore-on-stop');try{const result=await transportCall('stop',{restore},25000);log({stopped:true,result});if(restore&&result.restoration?.restored)fs.unlinkSync(STATE+'/restore-on-stop');}catch(e){log({stop_error:e.message});}transport?.destroy();releaseLock();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('uncaughtException',e=>{log({fatal:e.message});stop();});
codex.update(assignment.slots.filter(t=>t?.provider==='codex'));log({started:true,pid:process.pid});
