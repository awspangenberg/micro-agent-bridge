const fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),vm=require('vm'),assert=require('assert/strict'),{EventEmitter}=require('events');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'micro-native-check-'));
fs.mkdirSync(dir+'/.codex/tmp/micro-native-20260921',{recursive:true});
const baseline=Buffer.from(JSON.stringify({linkedApps:[],profiles:[{id:0,layers:[0,1,2].map(id=>({id,name:'Layer '+(id+1),layout:{keymap:[['KC_NONE','KC_NONE'],Array(4).fill('KC_NONE'),Array(4).fill('KC_NONE'),Array(3).fill('KC_NONE')],encoders:[['KC_NONE','KC_NONE','KC_NONE']],joystick:{type:'RADIAL',sectors:[]}}}))}]}));
let profile=Buffer.from(baseline),working=Buffer.alloc(0),inputRunning=false,inspectorOpen=false,writeDelay=0;const calls=[];
class HIDAsync extends EventEmitter {
 constructor(){super();this.readStarts=0;this.reading=false;this.on('newListener',event=>{if(event==='data')process.nextTick(()=>this.resume())});this.on('removeListener',event=>{if(event==='data'&&this.listenerCount('data')===0)this.reading=false})}
 resume(){if(this.listenerCount('data')>0){if(this.reading)throw Error('read is already running');this.reading=true;this.readStarts++}}
}
let nativeInputs=0;const handle=new HIDAsync(),power=new EventEmitter(),nativeHandler=()=>{nativeInputs++};handle.on('data',nativeHandler);
const comm={connectedDevice:handle,enqueue:()=>{},isConnected:()=>true};
const rpc={deviceComm:comm,getRpcClient:()=>({sendRpcCall:async({method,params})=>{
  calls.push({method,params});
  if(method==='fs.writebin'&&writeDelay)await new Promise(r=>setTimeout(r,writeDelay));
  if(method==='fs.readbin')return {result:{total_size:profile.length,data:profile.subarray(params.offset,params.offset+params.len).toString('base64')}};
  if(method==='fs.writebin'){if(params.offset===0)working=Buffer.alloc(0);assert.equal(params.offset,working.length);working=Buffer.concat([working,Buffer.from(params.data,'base64')]);if(params.completed)profile=working;return {result:{ok:1}};}
  if(method==='v.oai.thstatus')return {result:{ok:1}};
  throw Error('Unexpected RPC');
}})};
const service={lifecycleState:'started',comm,api:{deviceComm:comm,api:rpc},getState:()=>({status:'connected',transport:'bluetooth'}),runDeviceRpc:fn=>fn()};
const fakeRequire=x=>x==='electron'?{powerMonitor:power,app:{getVersion:()=> '26.915.31945'}}:x==='node:os'?{homedir:()=>dir}:x==='node:child_process'?{execFile:(a,b,c,cb)=>cb(null,inputRunning?'/Applications/input.app/Contents/MacOS/input\n':'')}:x==='node:inspector'?{url:()=>inspectorOpen?'ws://127.0.0.1:9229/test':undefined}:require(x==='./reader.cjs'?'../src/reader.cjs':x);
const box={require:fakeRequire,module:{exports:{}},Buffer,process,performance,setTimeout,clearTimeout,setInterval,clearInterval,structuredClone};vm.runInNewContext(fs.readFileSync(__dirname+'/../src/bridge.cjs','utf8'),box);
let bridge,c,sockets=[];
async function request(method,extra={}){const socket=net.connect(bridge.socketPath);sockets.push(socket);await new Promise((r,j)=>{socket.once('connect',r);socket.once('error',j)});return new Promise((r,j)=>{let b='';socket.on('error',j);socket.on('data',x=>{b+=x;let end=b.indexOf('\n');if(end>=0){const result=JSON.parse(b.slice(0,end));socket.end();r(result)}});socket.write(JSON.stringify({id:1,method,...extra})+'\n')})}
(async()=>{
 try {
  const recover=false,claudeLayer=process.argv.includes('--claude'),persistent=claudeLayer||process.argv.includes('--persistent');
  bridge=await box.module.exports(service,dir+'/evidence',recover?{recoverStoppedTrial:true}:{persistent});
  for(let i=0;i<50&&!bridge.health().prepared;i++)await new Promise(r=>setTimeout(r,100));assert.equal(bridge.health().prepared,true);
  const saved=JSON.parse(baseline),mapped=JSON.parse(profile);assert.deepEqual(mapped.profiles[0].layers.slice(0,2),saved.profiles[0].layers.slice(0,2));assert.equal(mapped.profiles[0].layers[2].layout.keymap[0][0],'KV_OAI_AG12');
  if(claudeLayer){
    const mixedBefore=JSON.parse(profile).profiles[0].layers[2];await request('stop');
    // Upgrade the exact legacy one-layer ownership file used by the installed helper.
    const ownership=dir+'/evidence/profile-ownership.json',owned=JSON.parse(fs.readFileSync(ownership));
    fs.writeFileSync(ownership,JSON.stringify({baseline:owned.baseline,...owned.layers[0]}));
    bridge=await box.module.exports(service,dir+'/evidence',{persistent:true,claudeLayer:true});
    for(let i=0;i<50&&!bridge.health().prepared;i++)await new Promise(r=>setTimeout(r,100));
    assert.equal(bridge.health().prepared,true);
    const upgrade=JSON.parse(profile).profiles[0].layers;
    assert.deepEqual(upgrade[0],saved.profiles[0].layers[0]);assert.deepEqual(upgrade[2],mixedBefore);
    assert.deepEqual(upgrade[1].layout.keymap.slice(2),saved.profiles[0].layers[1].layout.keymap.slice(2));
    assert.deepEqual(upgrade[1].layout.encoders,saved.profiles[0].layers[1].layout.encoders);
    assert.deepEqual(upgrade[1].layout.joystick,saved.profiles[0].layers[1].layout.joystick);
    assert.equal(upgrade[1].layout.keymap[0][0],'KV_OAI_AG06');
    assert.equal(JSON.parse(fs.readFileSync(ownership)).layers.length,2);
  }
  assert.equal(handle.readStarts,1);
  const payload=Buffer.from(JSON.stringify({m:'v.oai.hid',p:{k:'AG12',act:1}})+'\n'),report=Buffer.alloc(64);report[0]=6;report[1]=2;report[2]=payload.length;payload.copy(report,3);handle.emit('data',report);
  assert.equal(nativeInputs,1);assert.equal(bridge.health().stats.inputs,1);
  const frame=Array.from({length:6},(_,i)=>({id:i+12,c:0xff0000,b:.5,e:1,s:.3}));
  const count=calls.length;const bad=await request('lights',{frame:frame.map((x,i)=>i?x:{...x,id:0})});assert.match(bad.error,/unowned/);assert.equal(calls.length,count);
  const denied=await request('fs.writebin',{params:{file:'other'}});assert.match(denied.error,/not allowed/);assert.equal(calls.length,count);
  const good=await request('lights',{frame});assert.equal(good.result.sent,true);assert.equal(calls.at(-1).method,'v.oai.thstatus');assert.deepEqual(Array.from(calls.at(-1).params,x=>x.id),[12,13,14,15,16,17]);
  if(claudeLayer){
    const claudeFrame=frame.map(x=>({...x,id:x.id-6,c:0x00ff00}));
    const wrote=await request('lights',{frame:claudeFrame});assert.equal(wrote.result.sent,true);
    assert.deepEqual(Array.from(calls.at(-1).params,x=>x.id),[6,7,8,9,10,11]);
    const mixedBank=await request('lights',{frame:frame.map((x,i)=>i?x:{...x,id:6})});assert.match(mixedBank.error,/unowned/);
  }
  const beforeGuards=calls.length;
  inputRunning=true;const competing=await request('lights',{frame});assert.match(competing.error,/Input owns/);assert.equal(calls.length,beforeGuards);inputRunning=false;
  inspectorOpen=true;const inspecting=await request('lights',{frame});assert.match(inspecting.error,/inspector is open/);assert.equal(calls.length,beforeGuards);inspectorOpen=false;
  const beforeSuspend=calls.length;power.emit('suspend');await new Promise(r=>setTimeout(r,400));
  assert.equal(calls.length,beforeSuspend,'Sleep transition must not restore lights while native state still says connected');
  const asleep=await request('lights',{frame});assert.match(asleep.error,/asleep/);assert.equal(calls.length,beforeSuspend);
  power.emit('resume');for(let i=0;i<30&&bridge.health().stats.recoveries===0;i++)await new Promise(r=>setTimeout(r,100));
  assert.equal(bridge.health().stats.recoveries,claudeLayer?2:1);const beforeReplacement=bridge.health().stats.recoveries;
  const newHandle=new HIDAsync(),newNativeHandler=()=>{};newHandle.on('data',newNativeHandler);comm.connectedDevice=newHandle;
  for(let i=0;i<30&&bridge.health().stats.recoveries===beforeReplacement;i++)await new Promise(r=>setTimeout(r,100));
  assert.equal(bridge.health().stats.recoveries,beforeReplacement+(claudeLayer?2:1));assert.deepEqual(handle.listeners('data'),[nativeHandler]);assert.equal(newHandle.listenerCount('data'),2);assert.deepEqual(Array.from(calls.at(-1).params,x=>x.id),claudeLayer?[6,7,8,9,10,11]:[12,13,14,15,16,17]);
  assert.equal(newHandle.readStarts,1);
  const later=JSON.parse(profile);if(claudeLayer)later.profiles[0].layers[0].color=12345;else later.profiles[0].layers[1].name='User changed layer 2';profile=Buffer.from(JSON.stringify(later));
  writeDelay=400; // Restoration exceeds the ownership cache lifetime after timers stop.
  if(persistent){
    await request('stop');
    const afterStop=JSON.parse(profile);assert.equal(afterStop.profiles[0].layers[2].name,'Mixed');
    afterStop.profiles[0].layers[0].name='Later native layer rename';profile=Buffer.from(JSON.stringify(afterStop));
    writeDelay=0;bridge=await box.module.exports(service,dir+'/evidence',{persistent:true,claudeLayer});
    for(let i=0;i<50&&!bridge.health().prepared;i++)await new Promise(r=>setTimeout(r,100));
    assert.equal(bridge.health().prepared,true);writeDelay=400;
  }
  const stopped=await request('stop',{restore:true});assert.equal(stopped.result.restoration.restored,true);const restored=JSON.parse(profile);if(persistent)assert.equal(restored.profiles[0].layers[0].name,'Later native layer rename');if(claudeLayer){assert.deepEqual(restored.profiles[0].layers[1],saved.profiles[0].layers[1]);assert.equal(restored.profiles[0].layers[0].color,12345)}else assert.equal(restored.profiles[0].layers[1].name,'User changed layer 2');assert.deepEqual(restored.profiles[0].layers[2],saved.profiles[0].layers[2]);assert.deepEqual(handle.listeners('data'),[nativeHandler]);assert.deepEqual(newHandle.listeners('data'),[newNativeHandler]);assert.equal(power.listenerCount('resume'),0);assert.equal(power.listenerCount('suspend'),0);
  if(claudeLayer){
    writeDelay=0;bridge=await box.module.exports(service,dir+'/evidence',{persistent:true,claudeLayer:true});
    for(let i=0;i<50&&!bridge.health().prepared;i++)await new Promise(r=>setTimeout(r,100));
    assert.equal(bridge.health().prepared,true);
    const edited=JSON.parse(profile);edited.profiles[0].layers[1].name='User later edited Claude';profile=Buffer.from(JSON.stringify(edited));
    const refused=await request('stop',{restore:true});assert.match(refused.result.error,/Later layer-2 edit/);
    assert.deepEqual(JSON.parse(profile),edited,'An edited owned layer must not cause partial restoration of any layer');
    assert.ok(fs.existsSync(dir+'/evidence/profile-ownership.json'));
  }
  console.log(JSON.stringify({claude_layer_upgrade:claudeLayer,native_layers_preserved:true,native_bank_rejected:true,generic_rpc_rejected:true,owned_frame_only:true,input_ownership_guard:true,inspector_io_guard:true,sleep_io_guard:true,resume_replays_owned_bank:true,new_handle_rebound:true,only_owned_bank_replayed:true,later_edits_preserved:true,native_listener_preserved:true,owned_listeners_removed:true}));
 }finally{for(const s of sockets)s.destroy();if(bridge&&!bridge.health().stopped)await bridge.stop();fs.rmSync(dir,{recursive:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
