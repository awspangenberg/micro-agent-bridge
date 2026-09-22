import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
export class Remotes extends EventEmitter {
 constructor(hosts){super();this.rows=new Map(hosts.map(h=>[h.id,{host:h,child:null,at:0,seq:0,attempt:0,data:null}]));}
 fresh(id){const r=this.rows.get(id);return !!r&&Date.now()-r.at<6000;}
 tick(){for(const r of this.rows.values()){
  if(r.child){if(r.at&&Date.now()-r.at>8000)r.child.kill();continue;}
  if(Date.now()-r.attempt<4000)continue;r.attempt=Date.now();r.at=0;r.seq=0;let buffer='';
  const child=r.child=spawn('ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=5','-o','ServerAliveInterval=3','-o','ServerAliveCountMax=2',r.host.sshAlias,'micro-agent-bridge observe'],{stdio:['pipe','pipe','pipe']});
  child.stdout.on('data',b=>{buffer+=b;if(buffer.length>1048576){child.kill();return;}let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const d=JSON.parse(line);if(d.protocol!==1||!Number.isInteger(d.sequence)||d.sequence<=r.seq)continue;r.seq=d.sequence;r.at=Date.now();r.data={...d,codex:d.codex?.map(t=>({...t,host:r.host.id,hostId:r.host.codexHostIds[0]})),mappings:d.mappings?.map(t=>({...t,host:r.host.id}))};this.emit('update');}catch{}}});
  child.stdin.on('error',()=>{child.kill();});child.stderr.on('data',()=>{});child.on('error',()=>{});child.on('exit',()=>{if(r.child===child){r.child=null;r.at=0;this.emit('lost',r.host.id);}});
 }}
 send(items,codexIds,desktopIds){for(const r of this.rows.values())if(r.child?.stdin.writable)r.child.stdin.write(JSON.stringify({protocol:1,ids:items.filter(t=>t.host===r.host.id).map(t=>t.nativeId),codexIds,desktopIds})+'\n');}
 close(){for(const r of this.rows.values())r.child?.kill();}
}
