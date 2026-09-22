import fs from 'node:fs';
export function acquireLock(file){
 if(fs.existsSync(file)){
  const previous=fs.readFileSync(file,'utf8'),pid=Number(previous);
  if(!Number.isSafeInteger(pid)||pid<2)throw Error('Invalid helper lock; inspect it before starting');
  try{process.kill(pid,0);throw Error('A helper process already owns this state directory');}
  catch(e){if(e.code!=='ESRCH')throw e;}
  if(fs.readFileSync(file,'utf8')!==previous)throw Error('Helper lock changed');
  fs.unlinkSync(file);
 }
 fs.writeFileSync(file,String(process.pid),{mode:0o600,flag:'wx'});
 return ()=>{try{if(fs.readFileSync(file,'utf8')===String(process.pid))fs.unlinkSync(file);}catch{}};
}
