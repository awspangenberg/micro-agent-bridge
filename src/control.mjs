#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {ROOT,STATE,CONFIG,PY,config,validateConfig,atomic,env,quote} from './paths.mjs';
import {promoteState,recover,rollbackState} from './transactions.mjs';
import {appInfo,discoverApps,compatibility} from './platform.mjs';
const [command='status',...args]=process.argv.slice(2);
const label='org.microagentbridge.helper';
const plist=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');
const unit=path.join(process.env.XDG_CONFIG_HOME??path.join(os.homedir(),'.config'),'systemd/user/micro-agent-bridge.service');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const run=(file,a,options={})=>execFileSync(file,a,{encoding:'utf8',timeout:30000,env:env(),...options});
const option=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
function pid(){try{const n=Number(fs.readFileSync(STATE+'/daemon.pid'));if(!Number.isSafeInteger(n)||n<2)return null;const line=run('/bin/ps',['-p',String(n),'-o','command=']);return line.includes(ROOT+'/daemon.mjs')?n:null;}catch{return null;}}
function doctor(){
 const checks=[];let c;
 try{c=config();checks.push({name:'configuration',ok:true});}catch(e){return [{name:'configuration',ok:false,reason:e.code==='ENOENT'?'Not configured. Choose Configure or run setup.':e.message}];}
 const observer=c.role==='observer';
 checks.push({name:'architecture',ok:process.platform==='darwin'?process.arch==='arm64':process.platform==='linux'&&process.arch==='x64'});
 try{run(PY,['-c','import sqlite3,fcntl']);checks.push({name:'python',ok:true});}catch{checks.push({name:'python',ok:false});}
 if(observer)return checks;
 if(process.platform==='linux')checks.push({name:'Linux desktop qualification',ok:compatibility.linuxDesktop.qualified,reason:compatibility.linuxDesktop.reason});
 for(const provider of ['codex','claude'])try{
  const a=appInfo(provider,c);if(!a)throw Error('Not installed');
  if(provider==='codex'){
   const match=compatibility.adapters.find(x=>x.platform===process.platform&&x.arch===process.arch&&x.version===a.version);
   if(!match)throw Error('No adapter for this app version');
   if(crypto.createHash('sha256').update(fs.readFileSync(a.asar)).digest('hex')!==match.asarSHA256)throw Error('App bundle differs from supported build');
   if(process.platform==='darwin')run('/usr/bin/codesign',['--verify','--deep','--strict',a.root]);
  }else if(!compatibility.claude.some(x=>x.platform===process.platform&&x.version===a.version))throw Error('Unsupported Claude build');
  checks.push({name:provider,ok:true,version:a.version});
 }catch(e){checks.push({name:provider,ok:false,reason:e.message});}
 try{const p=run('/bin/ps',['-axo','comm=']);checks.push({name:'Input closed',ok:!p.split('\n').some(x=>/\/input\.app\/Contents\/MacOS\/input$/.test(x.trim()))});}catch{checks.push({name:'Input closed',ok:false});}
 return checks;
}
async function stop(restore=false){
 if(restore)atomic(STATE+'/restore-on-stop',true);
 const n=pid();if(n){process.kill(n,'SIGTERM');for(let i=0;i<120&&pid();i++)await delay(250);if(pid())throw Error('Helper did not stop; installation preserved');}
 if(restore&&fs.existsSync(STATE+'/transport/profile-ownership.json'))throw Error('Restoration requires a running helper and connected keyboard; no files removed. Start, reconnect, then retry, or uninstall --keep-profile.');
 if(restore)fs.rmSync(STATE+'/restore-on-stop',{force:true});
}
function start(){
 if(pid())return;
 const checks=doctor().filter(x=>!(args.includes('--qualification')&&x.name==='Linux desktop qualification'));if(checks.some(x=>!x.ok))throw Error('Preflight failed: '+JSON.stringify(checks.filter(x=>!x.ok)));
 if(config().role!=='desktop')throw Error('Observer runs through SSH: use observe');
 const legacy=os.homedir()+'/.local/share/micro-mixed/runtime/daemon.pid';
 if(fs.existsSync(legacy)){const old=Number(fs.readFileSync(legacy));try{process.kill(old,0);throw Error('Legacy helper is running. Stop it before migration/start.')}catch(e){if(e.code!=='ESRCH')throw e;}}
 run(PY,[ROOT+'/claude_hooks.py','--install']);
 fs.mkdirSync(STATE,{recursive:true,mode:0o700});const fd=fs.openSync(STATE+'/supervisor.log','a',0o600);
 const child=spawn(process.execPath,[ROOT+'/daemon.mjs'],{detached:true,stdio:['ignore',fd,fd],env:env()});child.unref();fs.closeSync(fd);
 console.log('Helper started; inspect status for connection and layer readiness.');
}
async function setup(){
 if(fs.existsSync(CONFIG)){if(args.includes('--take-over-layers'))atomic(CONFIG,{...config(),ownedLayers:[1,2]});console.log('Existing configuration preserved; explicit layer ownership consent applied when requested. Use doctor or hosts.');return;}
 let role=option('--role')??'desktop',ownedLayers=[];
 if(!args.includes('--defaults')&&process.stdin.isTTY){const rl=createInterface({input:process.stdin,output:process.stdout});try{
  const answer=await rl.question('Install desktop helper or SSH observer? [desktop/observer] ');if(answer.trim())role=answer.trim();
  if(role==='desktop'&&(await rl.question('Allow this helper to configure existing layers 2 and 3 after backing them up? [y/N] ')).toLowerCase()==='y')ownedLayers=[1,2];
 }finally{rl.close();}}
 if(args.includes('--take-over-layers'))ownedLayers=[1,2];
 atomic(CONFIG,validateConfig({version:1,role,apps:role==='desktop'?discoverApps():{},hosts:[],ownedLayers}));
 console.log('Configuration saved. Native layer 1 and keyboard profile are unchanged until start.');
 if(role==='observer')run(PY,[ROOT+'/claude_hooks.py','--install'],{stdio:'inherit'});
}
function xml(s){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');}
async function startup(enable){
 if(enable){
  const acceptance=JSON.parse(fs.readFileSync(STATE+'/acceptance.json'));
  const digest=crypto.createHash('sha256').update(fs.readFileSync(ROOT+'/compatibility.json')).digest('hex');
  if(acceptance.passed!==true||acceptance.compatibilitySHA256!==digest)throw Error('Current compatibility set has not passed acceptance');
  if(doctor().some(x=>!x.ok))throw Error('Preflight failed');
 }
 await stop();
 if(process.platform==='darwin'){
  if(fs.existsSync(plist)){try{run('launchctl',['bootout','gui/'+process.getuid()+'/'+label]);}catch{}fs.unlinkSync(plist);}
  if(enable){fs.mkdirSync(path.dirname(plist),{recursive:true});fs.writeFileSync(plist,`<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(ROOT+'/daemon.mjs')}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>EnvironmentVariables</key><dict><key>MAB_CONFIG</key><string>${xml(CONFIG)}</string><key>MAB_STATE</key><string>${xml(STATE)}</string></dict><key>ThrottleInterval</key><integer>10</integer></dict></plist>`,{mode:0o600});run('launchctl',['bootstrap','gui/'+process.getuid(),plist]);}
 }else{
  if(fs.existsSync(unit)){run('systemctl',['--user','disable','--now','micro-agent-bridge.service']);fs.unlinkSync(unit);}
  if(enable){fs.mkdirSync(path.dirname(unit),{recursive:true});fs.writeFileSync(unit,`[Unit]\nDescription=Micro Agent Bridge\nPartOf=graphical-session.target\nAfter=graphical-session.target\n[Service]\nType=simple\nExecStart="${process.execPath}" "${ROOT}/daemon.mjs"\nEnvironment="MAB_CONFIG=${CONFIG}" "MAB_STATE=${STATE}"\nRestart=on-failure\nRestartSec=10\n[Install]\nWantedBy=graphical-session.target\n`,{mode:0o600});}
  run('systemctl',['--user','daemon-reload']);if(enable)run('systemctl',['--user','enable','--now','micro-agent-bridge.service']);
 }
 if(enable)atomic(STATE+'/startup-enabled.json',{enabled:true});else fs.rmSync(STATE+'/startup-enabled.json',{force:true});
}
async function migrate(){
 const old=path.join(os.homedir(),'.local/share/micro-mixed');
 if(pid())throw Error('Stop the new helper before migration');
 const legacyPid=old+'/runtime/daemon.pid';if(fs.existsSync(legacyPid)){try{process.kill(Number(fs.readFileSync(legacyPid)),0);throw Error('Stop the legacy helper before migration');}catch(e){if(e.code!=='ESRCH')throw e;}}
 if(fs.existsSync(STATE))throw Error('Destination state exists; migration will not merge or overwrite it');
 const c=config(),remote=option('--legacy-host')?c.hosts.find(h=>h.id===option('--legacy-host')):c.hosts.length===1?c.hosts[0]:null;
 promoteState(STATE,stage=>{
  for(const file of ['assignments.json','claude-assignments.json','transport/profile-ownership.json']){
   const source=path.join(old,'runtime',file);if(!fs.existsSync(source))continue;let d=JSON.parse(fs.readFileSync(source));
   if(file.includes('assignments')){
    const convert=t=>{if(!t)return t;if(t.host==='mac')return {...t,host:'local'};if(!remote)throw Error('Configure the legacy SSH host before migrating remote assignments');return {...t,host:remote.id};};
    d.slots=d.slots.map(convert);d.waiting=d.waiting.map(convert);const ranks={};for(const [key,value]of Object.entries(d.pinRanks??{})){const [provider,host,...rest]=key.split(':');ranks[[provider,host==='mac'?'local':remote?.id,...rest].join(':')]=value;}d.pinRanks=ranks;
   }
   atomic(path.join(stage,file),d);
  }
 });
  console.log('Assignment and profile ownership copied. Legacy files preserved. Remove legacy hooks using its control command before starting the new helper.');
}

try{
 if(command==='setup')await setup();
 else if(command==='doctor'){const checks=doctor();console.log(JSON.stringify(checks,null,2));if(checks.some(x=>!x.ok))process.exitCode=1;}
 else if(command==='status'){let s={};try{s=JSON.parse(fs.readFileSync(STATE+'/state.json'));}catch{}console.log(JSON.stringify({...s,running:!!pid(),fresh:Date.now()-Date.parse(s.updatedAt)<5000},null,2));}
 else if(command==='start')start();
 else if(command==='stop')await stop();
 else if(command==='restart'){await stop();start();}
 else if(command==='restore')await stop(true);
 else if(command==='enable-login'||command==='disable-login')await startup(command==='enable-login');
 else if(command==='observe'){const child=spawn(PY,[ROOT+'/remote.py'],{stdio:'inherit',env:env()});child.on('exit',code=>process.exitCode=code??1);}
 else if(command==='hooks')run(PY,[ROOT+'/claude_hooks.py',args[0]==='remove'?'--remove':'--install'],{stdio:'inherit'});
 else if(command==='acceptance'){const {gates,recordAcceptance}=await import('./acceptance.mjs');if(args[0]==='record'){const report=JSON.parse(fs.readFileSync(args[1]));console.log(JSON.stringify(recordAcceptance(report),null,2));}else console.log(JSON.stringify({version:1,checks:Object.fromEntries(gates.map(g=>[g,false]))},null,2));}
 else if(command==='migrate')await migrate();
 else if(command==='rollback-state'){if(pid())throw Error('Stop before rollback');console.log(rollbackState(STATE));}
 else if(command==='hosts'){
  const c=config(),sub=args[0]??'list';
  if(sub==='list')console.log(JSON.stringify(c.hosts,null,2));
  else if(sub==='add'){const h={id:args[1],sshAlias:args[2],codexHostIds:(option('--codex-host')??'').split(',').filter(Boolean),claudeTargets:(option('--claude-target')??'').split(',').filter(Boolean)};atomic(CONFIG,validateConfig({...c,hosts:[...c.hosts,h]}));}
  else if(sub==='remove')atomic(CONFIG,validateConfig({...c,hosts:c.hosts.filter(h=>h.id!==args[1])}));
  else if(sub==='check'){const h=c.hosts.find(h=>h.id===args[1]);if(!h)throw Error('Unknown host');console.log(run('ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=8',h.sshAlias,'micro-agent-bridge doctor']));}
  else throw Error('Use hosts list/add/remove/check');
 }
 else if(command==='install-app'){const {installApp}=await import('./install-app.mjs');await installApp(args[0],args.includes('--confirm'));}
 else if(command==='uninstall'){
  const c=config();await stop(!args.includes('--keep-profile'));if(fs.existsSync(STATE+'/startup-enabled.json'))await startup(false);
  run(PY,[ROOT+'/claude_hooks.py','--remove'],{stdio:'inherit'});
  const archive=STATE+'-uninstalled-'+Date.now();if(fs.existsSync(STATE))fs.renameSync(STATE,archive);
  if(fs.existsSync(CONFIG))fs.renameSync(CONFIG,CONFIG+'.uninstalled-'+Date.now());
  console.log('Owned local hooks/startup removed; state archived. Remove the application/package with your OS. Remote hosts are independent installations; run uninstall there when no clients use them.');
 }
 else if(command==='help'||command==='--help')console.log('Micro Agent Bridge\nsetup [--role desktop|observer] [--defaults] [--take-over-layers]\ndoctor | status | start | stop | restart | restore\nenable-login | disable-login | acceptance [record REPORT.json] | migrate | rollback-state\nhosts list|add ID SSH_ALIAS --codex-host NATIVE_ID --claude-target NATIVE_TARGET|remove ID|check ID\ninstall-app codex|claude [--confirm]\nhooks install|remove | observe | uninstall [--keep-profile]');
 else throw Error('Unknown command; use help');
}catch(e){console.error(e.message);process.exitCode=1;}
