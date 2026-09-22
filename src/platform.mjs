import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,HOME} from './paths.mjs';
const run=promisify(execFile);
export const compatibility=JSON.parse(fs.readFileSync(path.join(ROOT,'compatibility.json')));
export function discoverApps(){
 const mac=process.platform==='darwin';
 const first=items=>items.find(x=>fs.existsSync(x))??null;
 return {codex:first(mac?['/Applications/ChatGPT.app',HOME+'/Applications/ChatGPT.app','/Applications/Codex.app']:['/usr/lib/chatgpt','/opt/codex-desktop','/opt/chatgpt-desktop']),claude:first(mac?['/Applications/Claude.app',HOME+'/Applications/Claude.app']:['/opt/Claude','/opt/claude-desktop'])};
}
export function appInfo(provider,c){
 const root=c.apps?.[provider]??discoverApps()[provider];if(!root)return null;
 if(process.platform==='darwin'){
  const plist=root+'/Contents/Info.plist';const get=k=>execFileSync('/usr/libexec/PlistBuddy',['-c','Print :'+k,plist],{encoding:'utf8'}).trim();
  return {root,version:get('CFBundleShortVersionString'),build:get('CFBundleVersion'),exec:root+'/Contents/MacOS/'+get('CFBundleExecutable'),asar:root+'/Contents/Resources/app.asar'};
 }
 const asar=[root+'/resources/app.asar',root+'/content/resources/app.asar'].find(fs.existsSync);
 // Linux versions are supplied only by an explicitly qualified package manifest.
 let version=c.linuxPackages?.[provider]?.version;
 if(!version)try{version=execFileSync('dpkg-query',['-W','-f=${Version}',provider==='codex'?'chatgpt':'claude-desktop'],{encoding:'utf8'}).trim();}catch{}
 return {root,version:version??null,exec:c.linuxPackages?.[provider]?.executable??root+(provider==='codex'?(root==='/usr/lib/chatgpt'?'/ChatGPT':'/electron'):'/claude-desktop'),asar};
}
export async function presence(c){
 const {stdout}=await run('/bin/ps',['-axo','comm='],{timeout:3000});const lines=stdout.split('\n').map(x=>x.trim());
 return Object.fromEntries(['codex','claude'].map(p=>{try{return [p,lines.includes(appInfo(p,c)?.exec)]}catch{return [p,false]}}));
}
export function claudeSupported(c){try{const a=appInfo('claude',c);return compatibility.claude.some(x=>x.platform===process.platform&&x.version===a?.version)}catch{return false}}
export function openRoute(url){return run(process.platform==='darwin'?'/usr/bin/open':'xdg-open',[url],{timeout:4000});}
export function menuCommand(){return process.platform==='darwin'?[ROOT+'/MicroMixedMenu']:['/usr/bin/python3',ROOT+'/linux_ui.py'];}
