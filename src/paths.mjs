import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
export const ROOT=path.dirname(fileURLToPath(import.meta.url));
export const HOME=os.homedir();
export const CONFIG=process.env.MAB_CONFIG??path.join(process.env.XDG_CONFIG_HOME??path.join(HOME,'.config'),'micro-agent-bridge','config.json');
export const STATE=process.env.MAB_STATE??(process.platform==='darwin'?path.join(HOME,'Library/Application Support/Micro Agent Bridge'):path.join(process.env.XDG_STATE_HOME??path.join(HOME,'.local/state'),'micro-agent-bridge'));
export const PY=process.env.MAB_PYTHON??(fs.existsSync(path.join(ROOT,'../runtime/python/bin/python3'))?path.join(ROOT,'../runtime/python/bin/python3'):'python3');
export function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}
export function validateConfig(c){
 if(c.version!==1||!['desktop','observer'].includes(c.role)||!Array.isArray(c.hosts))throw Error('Unsupported configuration');
 const ids=new Set(['local']),native=new Set(['local']),targets=new Set();
 for(const h of c.hosts){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(h.id)||ids.has(h.id))throw Error('Invalid or duplicate host id');ids.add(h.id);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,255}$/.test(h.sshAlias))throw Error('Use a configured SSH alias, not SSH options');
  if(!Array.isArray(h.codexHostIds)||!Array.isArray(h.claudeTargets))throw Error('Explicit native host mappings required');
  for(const id of h.codexHostIds){if(typeof id!=='string'||native.has(id))throw Error('Ambiguous Codex host mapping');native.add(id);}
  for(const id of h.claudeTargets){if(typeof id!=='string'||targets.has(id))throw Error('Ambiguous Claude host mapping');targets.add(id);}
 }
 if(c.ownedLayers&&!c.ownedLayers.every(x=>[1,2].includes(x)))throw Error('Only custom layers 2 and 3 may be owned');
 return c;
}
export function config(){return validateConfig(JSON.parse(fs.readFileSync(CONFIG)));}
export function env(){return {...process.env,MAB_STATE:STATE,MAB_CONFIG:CONFIG};}
export const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
