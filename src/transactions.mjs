// Small journaled state migrations. Keep the prior generation until acceptance.
import fs from 'node:fs';
import path from 'node:path';
import {atomic} from './paths.mjs';
export function recover(target){
 const journal=target+'.transaction.json';if(!fs.existsSync(journal))return;
 const j=JSON.parse(fs.readFileSync(journal));
 if(j.target!==target||j.stage!==target+'.next'||j.backup!==target+'.previous')throw Error('Unexpected migration journal');
 if(fs.existsSync(target)){fs.rmSync(j.stage,{recursive:true,force:true});fs.unlinkSync(journal);return;}
 if(fs.existsSync(j.backup)){fs.renameSync(j.backup,target);fs.rmSync(j.stage,{recursive:true,force:true});fs.unlinkSync(journal);return;}
 // Initial installation interrupted before promotion: discard only our recorded stage.
 fs.rmSync(j.stage,{recursive:true,force:true});fs.unlinkSync(journal);
}
export function promoteState(target,write){
 recover(target);const stage=target+'.next',backup=target+'.previous';
 if(fs.existsSync(stage)||fs.existsSync(backup))throw Error('A prior generation exists; preserve it before retrying migration');
 fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.mkdirSync(stage,{mode:0o700});
 try{write(stage);atomic(target+'.transaction.json',{version:1,target,stage,backup});if(fs.existsSync(target))fs.renameSync(target,backup);fs.renameSync(stage,target);fs.unlinkSync(target+'.transaction.json');}
 catch(e){recover(target);if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true});throw e;}
}
export function rollbackState(target){
 recover(target);const backup=target+'.previous';if(!fs.existsSync(backup))throw Error('No previous state generation');
 const retired=target+'.before-rollback-'+Date.now();if(fs.existsSync(target))fs.renameSync(target,retired);
 try{fs.renameSync(backup,target);}catch(e){if(fs.existsSync(retired))fs.renameSync(retired,target);throw e;}
 return retired;
}
