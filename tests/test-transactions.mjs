import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promoteState,recover,rollbackState} from '../src/transactions.mjs';
test('failed migration retains current state; successful migration retains rollback',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'micro-transaction-')),target=path.join(temp,'state');
 try{fs.mkdirSync(target);fs.writeFileSync(target+'/value','old');
 assert.throws(()=>promoteState(target,s=>{fs.writeFileSync(s+'/value','bad');throw Error('interrupted')}));
 assert.equal(fs.readFileSync(target+'/value','utf8'),'old');
 promoteState(target,s=>fs.writeFileSync(s+'/value','new'));assert.equal(fs.readFileSync(target+'/value','utf8'),'new');
 rollbackState(target);assert.equal(fs.readFileSync(target+'/value','utf8'),'old');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('recovery restores previous generation after interruption between renames',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'micro-recovery-')),target=path.join(temp,'state');
 try{fs.mkdirSync(target+'.previous');fs.writeFileSync(target+'.previous/value','safe');fs.mkdirSync(target+'.next');fs.writeFileSync(target+'.transaction.json',JSON.stringify({target,stage:target+'.next',backup:target+'.previous'}));recover(target);assert.equal(fs.readFileSync(target+'/value','utf8'),'safe');assert.ok(!fs.existsSync(target+'.next'));}finally{fs.rmSync(temp,{recursive:true,force:true});}
});
