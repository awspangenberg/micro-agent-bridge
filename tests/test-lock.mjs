import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {acquireLock} from '../src/lock.mjs';
test('only one supervisor owns the state directory; release preserves a changed owner',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'micro-lock-')),file=dir+'/daemon.pid';
 try{const release=acquireLock(file);assert.throws(()=>acquireLock(file),/already owns/);release();assert.equal(fs.existsSync(file),false);
 const second=acquireLock(file);fs.writeFileSync(file,'2');second();assert.equal(fs.readFileSync(file,'utf8'),'2');
 }finally{fs.rmSync(dir,{recursive:true});}
});
