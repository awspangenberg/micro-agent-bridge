import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {discoverApps} from './platform.mjs';
const sources={
 darwin:{codex:{url:'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg',team:'2DC432GLL2',bundle:'com.openai.codex',name:'ChatGPT.app'},claude:{url:'https://downloads.claude.ai/releases/darwin/universal/latest',team:'Q6L2SF6YDW',bundle:'com.anthropic.claudefordesktop',name:'Claude.app'}}
};
export async function installApp(provider,confirm=false){
 if(!['codex','claude'].includes(provider))throw Error('Choose codex or claude');
 if(discoverApps()[provider])throw Error('An existing app was found; it will not be replaced');
 if(!confirm)throw Error('This installs a separate vendor app. Re-run with --confirm after reviewing docs/installation.md.');
 const run=(p,a)=>execFileSync(p,a,{stdio:'inherit',timeout:600000});
 if(process.platform==='linux'){
  // APT verifies repository signatures. Do not execute curl|shell or bypass signature checks.
  const repositories={claude:{key:'https://downloads.claude.ai/claude-desktop/key.asc',fingerprint:'31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE',url:'https://downloads.claude.ai/claude-desktop/apt/stable',package:'claude-desktop'}};
  const source=repositories[provider];
  if(provider==='codex'){
   const candidate={url:'https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt/chatgpt_26.915.31945_amd64.deb',sha256:'d27a9c02919cfe484dcc5f34584b9ea9fd0d7a65c69dcc872b5bdcfa0efb5983',qualified:false};
   if(!candidate.qualified&&!process.argv.includes('--qualification'))throw Error('Linux Codex requires physical qualification; developer testing can explicitly use --qualification.');
   const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'micro-codex-'));
   try{
    const file=tmp+'/chatgpt.deb';run('curl',['--fail','--location','--proto','=https','--proto-redir','=https',candidate.url,'--output',file]);
    if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==candidate.sha256)throw Error('Vendor package checksum mismatch');
    run('sudo',['apt-get','install',file]);
   }finally{fs.rmSync(tmp,{recursive:true,force:true});}
   return;
  }
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'micro-agent-app-'));
  try{
   const response=await fetch(source.key);if(!response.ok)throw Error('Signing key download failed');fs.writeFileSync(tmp+'/key.asc',Buffer.from(await response.arrayBuffer()));
   const keys=execFileSync('gpg',['--batch','--with-colons','--show-keys',tmp+'/key.asc'],{encoding:'utf8'});
   if(!keys.split('\n').some(x=>x.startsWith('fpr:')&&x.split(':')[9]===source.fingerprint))throw Error('Unexpected vendor signing key');
   const key='/usr/share/keyrings/micro-agent-'+provider+'.asc',list='/etc/apt/sources.list.d/micro-agent-'+provider+'.list';
   if(fs.existsSync(key)||fs.existsSync(list))throw Error('Repository files already exist; review them with your package manager');
   fs.writeFileSync(tmp+'/source.list',`deb [arch=amd64 signed-by=${key}] ${source.url} stable main\n`);
   run('sudo',['install','-m','644',tmp+'/key.asc',key]);run('sudo',['install','-m','644',tmp+'/source.list',list]);
   run('sudo',['apt-get','update']);run('sudo',['apt-get','install','--no-install-recommends',source.package]);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
  return;
 }
 const source=sources.darwin[provider],tmp=fs.mkdtempSync(path.join(os.tmpdir(),'micro-agent-app-')),mount=tmp+'/mounted';
 try{
  run('/usr/bin/curl',['--fail','--location','--proto','=https','--proto-redir','=https',source.url,'--output',tmp+'/app.dmg']);
  fs.mkdirSync(mount);run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,tmp+'/app.dmg']);
  const app=mount+'/'+source.name;if(!fs.existsSync(app))throw Error('Vendor disk image layout changed');
  run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  // codesign writes its display information to stderr.
  const {spawnSync}=await import('node:child_process');const details=spawnSync('/usr/bin/codesign',['-dv',app],{encoding:'utf8'}).stderr;
  if(!details.includes('TeamIdentifier='+source.team)||!details.includes('Identifier='+source.bundle))throw Error('Unexpected app signer');
  run('/usr/sbin/spctl',['--assess','--type','execute',app]);
  const destination=path.join(os.homedir(),'Applications',source.name);fs.mkdirSync(path.dirname(destination),{recursive:true});if(fs.existsSync(destination))throw Error('Destination already exists');
  run('/usr/bin/ditto',[app,destination]);console.log('Installed '+source.name+'. Sign in using the app, then run setup/doctor.');
 }finally{try{run('/usr/bin/hdiutil',['detach',mount]);}catch{}fs.rmSync(tmp,{recursive:true,force:true});}
}
