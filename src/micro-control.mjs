#!/usr/bin/env node
// Diagnostic client only. Starting this command does not install a host adapter.
import {MicroServiceClient} from './micro-client.mjs';

const [command='doctor',...args]=process.argv.slice(2);
const output=value=>console.log(JSON.stringify(value,null,command==='watch'?0:2));
if(command==='help'||command==='--help') {
  console.log('Micro service client (requires Codex host integration)\n\nnode src/micro-control.mjs doctor|status|watch\n\nUses the local Codex IPC endpoint. No app modification or HID attachment.\nLighting is available through MicroServiceClient after host-side bank consent.');
} else if(!['doctor','status','watch'].includes(command)||args.length) {
  console.error('Use doctor, status, watch, or help.');process.exitCode=1;
} else {
  const client=new MicroServiceClient();
  let stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;void client.close().catch(e=>{console.error(e.message);process.exitCode=1;});};
  try {
    const capabilities=await client.connect();
    if(command==='doctor')output({available:true,endpoint:client.endpoint,capabilities});
    else if(command==='status')output(await client.status());
    else {
      for(const event of ['input','layer','state','invalidate'])client.on(event,output);
      client.on('lost',error=>{if(!stopped){stopped=true;output({event:'lost',message:error.message});process.exitCode=1;}});
      process.once('SIGINT',stop);process.once('SIGTERM',stop);
      await client.subscribe();output({event:'state',...await client.status()});
    }
  }catch(e){output({available:false,endpoint:client.endpoint,code:e.code??'MICRO_ERROR',message:e.message});process.exitCode=1;}
  finally{if(command!=='watch'||!client.ready)await client.close().catch(()=>{});}
}
