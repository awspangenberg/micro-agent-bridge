'use strict';
// Uses the existing CodexMicroService complete-request queue; never opens a HID handle.
module.exports = async function installMicroTrial(service, root, options={}) {
  const fs=require('node:fs'), net=require('node:net'), crypto=require('node:crypto');
  const {execFile}=require('node:child_process');
  const {powerMonitor,app}=require('electron');
  const observeExistingReader=require('./reader.cjs');
  const tag=new Date().toISOString().replaceAll(':','-');
  const persistent=options.persistent===true;
  const claudeLayer=persistent&&options.claudeLayer===true;
  const banks=claudeLayer?[6,12]:[12];
  const socketPath=options.socketPath??require('node:path').join(root,'transport.sock');
  if(persistent)fs.mkdirSync(require('node:path').dirname(socketPath),{recursive:true,mode:0o700});
  const ownershipPath=root+'/profile-ownership.json';
  let lease=Date.now(),leaseExpired=false;
  const logfile=root+'/trial-'+tag+'.jsonl';
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const log=x=>fs.appendFileSync(logfile,JSON.stringify({at:new Date().toISOString(),...x})+'\n',{mode:0o600});
  const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
  const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const clearFrame=bank=>Array.from({length:6},(_,i)=>({id:i+bank,c:0,b:0,e:0,s:0,sk:0,sa:0}));
  let stopped=false,stopping=false,prepared=false,changed=false,suspended=false,handle=null,buffer='',generation=0;
  let desired=new Map(),restoreNeeded=false,baseline,trial,layerRecords=[],baselineNativeSettings,socketOwned=false;
  const banksOwned=new Set();
  let timer,expiry,startTimer,startPromise,inputOpen=true,inputChecked=0,checkingInput=false,chain=Promise.resolve(),lastWrite=0,firstFault=null;
  const clients=new Set(),stats={writes:0,rpcErrors:0,protocolErrors:0,inputs:0,maxMs:0,recoveries:0};
  const deadline=persistent?null:Date.now()+30*60*1000;
  if(app.getVersion()!==(options.expectedVersion??'26.915.31945')||service.lifecycleState!=='started'||!service.api?.api?.getRpcClient||!service.comm?.enqueue)throw Error('Unsupported native service');
  const serial=fn=>{const result=chain.then(fn);chain=result.catch(()=>{});return result};
  const checkInput=()=>new Promise((resolve,reject)=>execFile('/bin/ps',['-axo','comm='],{timeout:1500,maxBuffer:1024*1024},(err,out)=>{if(err){inputOpen=true;reject(Error('Cannot verify Input ownership'));return}inputOpen=out.split('\n').some(x=>x.trim()==='/Applications/input.app/Contents/MacOS/input');inputChecked=Date.now();resolve(!inputOpen)}));
  const connection=()=>{
    const state=service.getState(),comm=service.comm,api=service.api;
    if(state.status!=='connected'||state.transport!=='bluetooth'||state.controlPlaneStatus==='unavailable'||!comm?.isConnected()||api?.deviceComm!==comm||api.api.deviceComm!==comm)throw Error('Native Bluetooth connection unavailable');
    if(inputOpen||Date.now()-inputChecked>3500)throw Error('Input owns or may own a competing connection');
    return {comm,api};
  };
  async function rpc(method,params) {
    if(require('node:inspector').url())throw Error('Device I/O forbidden while inspector is open');
    await checkInput(); // Cleanup stops the periodic checker; refresh before every request.
    if(suspended)throw Error('Computer is asleep; device I/O suspended');
    const {comm,api}=connection(),before=performance.now();
    try {
      const response=await service.runDeviceRpc(()=>api.api.getRpcClient().sendRpcCall({method,params}));
      if(service.comm!==comm||service.api!==api)throw Error('Native connection changed during request');
      const ms=performance.now()-before;stats.maxMs=Math.max(stats.maxMs,ms);
      log({rpc:method,elapsed_ms:Math.round(ms),generation,...(method==='fs.writebin'?{offset:params.offset,bytes:Buffer.from(params.data,'base64').length,completed:params.completed}:{})});return response.result;
    } catch(e){stats.rpcErrors++;firstFault??=e.message;log({rpc_error:method,message:e.message,generation});throw e}
  }
  async function readProfile(){
    let offset=0,total,parts=[];
    do{const r=await rpc('fs.readbin',{file:'keymap.json',offset,len:3072});
      if(!Number.isInteger(r.total_size)||r.total_size<=0||r.total_size>100000||typeof r.data!=='string')throw Error('Invalid profile reply');
      if(total!==undefined&&total!==r.total_size)throw Error('Profile changed during read');total=r.total_size;
      const b=Buffer.from(r.data,'base64');if(!b.length)throw Error('Empty profile fragment');parts.push(b);offset+=b.length;
    }while(offset<total);
    if(offset!==total)throw Error('Profile size mismatch');return Buffer.concat(parts);
  }
  async function writeProfile(bytes,restoring=false){
    for(let offset=0;offset<bytes.length;offset+=128){if(!restoring&&(stopping||stopped))throw Error('Preparation canceled');const b=bytes.subarray(offset,offset+128);await rpc('fs.writebin',{file:'keymap.json',data:b.toString('base64'),append:true,offset,completed:offset+b.length===bytes.length});}
    const actual=await readProfile();if(!actual.equals(bytes))throw Error('Profile verification mismatch');
  }
  function validateFrame(value){
    if(!Array.isArray(value)||value.length!==6)throw Error('Expected six owned lighting slots');
    const bank=banks.find(start=>value.every(x=>x&&x.id>=start&&x.id<start+6));
    if(bank===undefined)throw Error('Invalid or unowned lighting bank');
    const ids=new Set();return value.map(x=>{
      if(!x||!Number.isInteger(x.id)||ids.has(x.id)||!Number.isInteger(x.c)||x.c<0||x.c>0xffffff||!Number.isFinite(x.b)||x.b<0||x.b>.65||!Number.isInteger(x.e)||![0,1,4,6].includes(x.e)||!Number.isFinite(x.s)||x.s<0||x.s>1)throw Error('Invalid or unowned lighting slot');
      ids.add(x.id);return {id:x.id,c:x.c,b:x.b,e:x.e,s:x.s,sk:0,sa:0};
    });
  }
  async function lights(frame,recovery=false){
    if(!prepared||stopped||stopping)throw Error('Trial not ready');
    const checked=validateFrame(frame),bank=Math.floor(checked[0].id/6)*6;desired.set(bank,checked);
    return serial(async()=>{if(stopped||stopping)throw Error('Trial stopped');await checkInput();banksOwned.add(bank);await rpc('v.oai.thstatus',checked);lastWrite=Date.now();stats.writes++;if(recovery)stats.recoveries++;log({lighting_sent:true,bank,frame:checked,recovery,stats:{...stats}});return {sent:true,stats:{...stats},generation}});
  }
  function broadcast(value){for(const c of clients)if(!c.destroyed)c.write(JSON.stringify(value)+'\n')}
  function invalidate(reason){for(const [bank,value]of desired)desired.set(bank,value.map(x=>({...x,c:x.b?0xff0000:0,e:x.b?1:0})));broadcast({event:'invalidate',reason,generation});}
  function onData(data){
    try {
      const o=data[0]===6?1:0;if(data[o]!==2||data[o+1]>61)return;
      buffer+=data.subarray(o+2,o+2+data[o+1]).toString('utf8');if(buffer.length>200000){buffer='';throw Error('HID buffer exceeded bound')}
      let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line)continue;
        const x=JSON.parse(line),method=x.method??x.m,p=x.params??x.p;
        if(x.error){stats.protocolErrors++;log({device_error:x.error,method,id:x.id??x.i})}
        if(method==='v.oai.hid'&&p){stats.inputs++;const event={key:p.k,act:p.act,agent:p.ag};log({input:event,generation,actions_forwarded:0});for(const c of clients)if(!c.destroyed)c.write(JSON.stringify({event:'input',...event,generation})+'\n')}
        if(method==='kb.radial'){log({radial:p,generation});broadcast({event:'layer',value:p,generation});}
      }
    }catch(e){stats.protocolErrors++;log({parse_error:e.message})}
  }
  function observeHandle(){
    const next=service.getState().status==='connected'?(service.comm?.connectedDevice??null):null;if(next===handle)return;
    if(handle)handle.removeListener('data',onData);handle=null;buffer='';
    if(next)observeExistingReader(next,onData);handle=next;generation++;restoreNeeded=desired.size>0;
    invalidate('connection-changed');log({connection_handle_changed:true,generation,connected:!!handle,state:service.getState()});
  }
  async function prepare(){
    if(prepared||stopped||stopping)throw Error('Already prepared or stopped');await checkInput();connection();observeHandle();
    const fresh=await readProfile(),source=JSON.parse(fresh),p=source.profiles?.find(x=>x.id===0);
    if(!p?.layers||source.linkedApps?.length)throw Error('Unexpected layer/profile or automatic app mapping');
    let existing=[],previousOwnership=null,pendingOwnership=false;
    if(persistent&&fs.existsSync(ownershipPath)){
      previousOwnership=fs.readFileSync(ownershipPath);const owned=JSON.parse(previousOwnership);pendingOwnership=owned.pending===true;
      existing=owned.version===2?owned.layers:[{id:2,originalLayer:owned.originalLayer,mappedLayer:owned.mappedLayer}];
    }
    if(existing.some(x=>![2,...(claudeLayer?[1]:[])].includes(x.id)))throw Error('Owned layer configuration mismatch');
    const restoredSource=JSON.parse(fresh),restoredProfile=restoredSource.profiles.find(x=>x.id===0);
    for(const id of claudeLayer?[2,1]:[2]){
      let index=p.layers.findIndex(x=>x.id===id);const created=index<0;
      if(created){
        const native=p.layers.find(x=>x.id===0);if(!native?.layout)throw Error('Native layout unavailable');
        const blank=structuredClone(native);blank.id=id;blank.name=id===1?'Claude':'Mixed';
        blank.layout.keymap=blank.layout.keymap.map(row=>row.map(()=>'KC_NONE'));
        blank.layout.encoders=[['KC_NONE','KC_NONE','KC_NONE']];blank.layout.joystick={type:'RADIAL',sectors:[]};
        p.layers.push(blank);index=p.layers.length-1;
      }
      const current=p.layers[index],owned=existing.find(x=>x.id===id);
      let originalLayer,mappedLayer;
      if(owned){
        if(!eq(current,owned.mappedLayer)&&!(pendingOwnership&&eq(current,owned.originalLayer)))throw Error('Layer '+(id+1)+' was edited; refusing to replace it');
        ({originalLayer,mappedLayer}=owned);
      }else{
        if(!created&&options.takeoverLayers&&!options.takeoverLayers.includes(id))throw Error('Layer '+(id+1)+' requires explicit ownership consent');
        originalLayer=created?null:structuredClone(current);mappedLayer=structuredClone(current);
        if(id===2){
          mappedLayer.name=persistent?'Mixed':'Mixed (shared trial)';
          mappedLayer.layout.keymap=[['KV_OAI_AG12','KV_OAI_AG13'],['KV_OAI_AG14','KV_OAI_AG15','KV_OAI_AG16','KV_OAI_AG17'],['KV_OAI_ACT13','KV_OAI_ACT14','KV_OAI_ACT15','KV_OAI_ACT16'],['KV_OAI_ACT17','KV_OAI_ACT18','KV_OAI_ACT19']];
          mappedLayer.layout.encoders=[['KV_OAI_ACT00','KV_OAI_ACT01','KV_OAI_ACT02']];
          mappedLayer.layout.joystick={type:'RADIAL',sectors:[{k:'KV_OAI_ACT04',a1:.875,a2:.125},{k:'KV_OAI_ACT05',a1:.125,a2:.375},{k:'KV_OAI_ACT20',a1:.375,a2:.625},{k:'KV_OAI_ACT03',a1:.625,a2:.875}]};
        }else{
          mappedLayer.name='Claude';
          mappedLayer.layout.keymap[0]=['KV_OAI_AG06','KV_OAI_AG07'];
          mappedLayer.layout.keymap[1]=['KV_OAI_AG08','KV_OAI_AG09','KV_OAI_AG10','KV_OAI_AG11'];
        }
      }
      layerRecords.push({id,originalLayer,mappedLayer});p.layers[index]=mappedLayer;
      const originalIndex=restoredProfile.layers.findIndex(x=>x.id===id);
      if(originalLayer&&originalIndex>=0)restoredProfile.layers[originalIndex]=originalLayer;
    }
    baseline=Buffer.from(JSON.stringify(restoredSource));trial=Buffer.from(JSON.stringify(source));
    // Fresh bytes include user edits and the already working Mixed layer.
    fs.writeFileSync(root+'/fresh-'+tag+'.json',fresh,{mode:0o600,flag:'wx'});
    fs.writeFileSync(root+'/baseline-'+tag+'.json',baseline,{mode:0o600,flag:'wx'});fs.writeFileSync(root+'/mapped-'+tag+'.json',trial,{mode:0o600,flag:'wx'});
    const home=require('node:os').homedir();baselineNativeSettings={};
    for(const path of [home+'/.codex/config.toml',home+'/.codex/.codex-global-state.json'])if(fs.existsSync(path))baselineNativeSettings[path]=sha(fs.readFileSync(path));
    if(!(await readProfile()).equals(fresh))throw Error('Profile changed since fresh backup');
    if(stopped||stopping)throw Error('Preparation canceled');
    const saveOwnership=pending=>{const temp=ownershipPath+'.tmp';fs.writeFileSync(temp,JSON.stringify({version:2,pending,baseline:baseline.toString('base64'),layers:layerRecords}),{mode:0o600});fs.renameSync(temp,ownershipPath);};
    if(!trial.equals(fresh)){
      if(persistent)saveOwnership(true);
      try{await writeProfile(trial);}
      catch(error){
        const partial=await readProfile();
        if(partial.equals(fresh)||partial.equals(trial)||partial.equals(trial.subarray(0,partial.length))){
          if(!partial.equals(fresh))await writeProfile(fresh,true);
          if(persistent){if(previousOwnership)fs.writeFileSync(ownershipPath,previousOwnership,{mode:0o600});else fs.unlinkSync(ownershipPath);}
        }
        throw error;
      }
    }
    if(persistent)saveOwnership(false);
    changed=true;prepared=true;log({profile_prepared:true,bytes:trial.length,owned_layers:layerRecords.map(x=>x.id+1),fresh_sha256:sha(fresh),native_settings_hashes:baselineNativeSettings});return {baseline_sha256:sha(baseline),trial_sha256:sha(trial)};
  }

  async function restore(){
    if(!changed)return {restored:true,changed:false};
    await checkInput();const current=await readProfile();let target;
    if(current.equals(baseline)){changed=false;return {restored:true,sha256:sha(current)}}
    if(current.equals(trial)||(current.length<trial.length&&current.equals(trial.subarray(0,current.length))))target=baseline;
    else {
      const p=JSON.parse(current),profile=p.profiles?.find(x=>x.id===0);
      for(const row of layerRecords){
        const i=profile?.layers?.findIndex(x=>x.id===row.id);
        if(i===undefined||i<0||!eq(profile.layers[i],row.mappedLayer))throw Error('Later layer-'+(row.id+1)+' edit detected; refusing overwrite');
        if(row.originalLayer===null)profile.layers.splice(i,1);else profile.layers[i]=row.originalLayer;
      }
      target=Buffer.from(JSON.stringify(p));
    }
    await writeProfile(target,true);changed=false;return {restored:true,sha256:sha(target),preserved_later_edits:!target.equals(baseline)};
  }
  const health=()=>({pid:process.pid,version:app.getVersion(),prepared,stopped,stopping,suspended,state:service.getState(),generation,inputOpen,inputChecked,stats:{...stats},firstFault,lastWrite,deadline,logfile,banks});
  const server=net.createServer(c=>{
    clients.add(c);let b='';c.on('error',()=>{});c.on('close',()=>clients.delete(c));
    c.on('data',async bytes=>{b+=bytes.toString('utf8');if(b.length>8192){c.destroy();return}let end;
      while((end=b.indexOf('\n'))>=0){const line=b.slice(0,end);b=b.slice(end+1);let q;try{q=JSON.parse(line);let result;
        if(q.method==='health'){lease=Date.now();leaseExpired=false;result=health();}
        else if(q.method==='lights')result=await lights(q.frame);
        else if(q.method==='status')result=await serial(async()=>{if(!prepared||stopped||stopping)throw Error('Trial not ready');await checkInput();return rpc('device.status',{})});
        else if(q.method==='stop')result=await stop(q.restore===true||!persistent);
        else throw Error('Method not allowed');
        if(!c.destroyed)c.write(JSON.stringify({id:q.id,result})+'\n');if(q.method==='stop')setTimeout(()=>{for(const s of clients)s.end()},100);
      }catch(e){if(!c.destroyed)c.write(JSON.stringify({id:q?.id,error:e.message})+'\n')}}
    });
  });
  const onSuspend=()=>{suspended=true;restoreNeeded=desired.size>0;invalidate('sleep');log({power:'suspend'})},onResume=()=>{suspended=false;restoreNeeded=desired.size>0;invalidate('wake');log({power:'resume'})};
  async function stop(restoreProfile=!persistent){
    if(stopped)return health();if(stopping)throw Error('Stop already in progress');stopping=true;clearInterval(timer);clearTimeout(expiry);clearTimeout(startTimer);
    powerMonitor.removeListener('suspend',onSuspend);powerMonitor.removeListener('resume',onResume);
    await startPromise?.catch(()=>{});await chain.catch(()=>{});let restoration,error;
    try{await checkInput();for(const bank of banksOwned)await rpc('v.oai.thstatus',clearFrame(bank));restoration=restoreProfile?await restore():{preserved_owned_layer:true};if(persistent&&restoreProfile&&restoration.restored)fs.unlinkSync(ownershipPath)}catch(e){error=e.message;log({cleanup_error:error})}
    if(handle)handle.removeListener('data',onData);handle=null;if(socketOwned){server.close();try{fs.unlinkSync(socketPath)}catch{}socketOwned=false;}
    stopped=true;stopping=false;delete globalThis.__microNativeTrial;delete globalThis.__microMixedTransport;log({stopped:true,restoration,error,stats:{...stats}});
    return {stopped:true,restoration,error,stats:{...stats}};
  }
  try {
    if(fs.existsSync(socketPath))throw Error('Trial socket already exists');
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{socketOwned=true;fs.chmodSync(socketPath,0o600);resolve()})});
    startTimer=setTimeout(()=>{
      if(stopping||stopped)return;startPromise=prepare();
      startPromise.then(()=>log({ready:true}),e=>{firstFault=e.message;log({prepare_error:e.message});setTimeout(()=>stop().catch(x=>log({cleanup_error:x.message})),0)});
    },1500);startTimer.unref();
    powerMonitor.on('suspend',onSuspend);powerMonitor.on('resume',onResume);
    timer=setInterval(()=>{
      if(persistent&&Date.now()-lease>8000&&!leaseExpired){leaseExpired=true;invalidate('helper-heartbeat-lost');restoreNeeded=desired.size>0;}
      try{observeHandle()}catch(e){firstFault??=e.message;log({observer_error:e.message});clearInterval(timer);setTimeout(()=>stop().catch(x=>log({cleanup_error:x.message})),0);return}
      if(!checkingInput&&Date.now()-inputChecked>1000){checkingInput=true;checkInput().catch(()=>{}).finally(()=>{checkingInput=false})}
      if(restoreNeeded&&desired.size&&!suspended&&!inputOpen&&!stopping&&!stopped&&service.getState().status==='connected'&&service.getState().controlPlaneStatus!=='unavailable'){
        restoreNeeded=false;for(const frame of desired.values())lights(frame,true).catch(e=>{firstFault??=e.message;log({recovery_error:e.message})});
      }
    },250);timer.unref();
    if(!persistent){expiry=setTimeout(()=>stop().catch(e=>log({expiry_cleanup_error:e.message})),30*60*1000);expiry.unref();}
    log({installed:true,socketPath,deadline,second_hid_handle:false,native_methods_patched:false});
    return {health,stop,socketPath};
  } catch(e){try{await stop()}catch{}throw e}
};
