import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {once} from 'node:events';
import {MicroServiceClient} from '../src/micro-client.mjs';
import {codexIpcEndpoint} from '../src/ipc-endpoint.mjs';
import {createMicroBridge} from '../src/micro-service.mjs';
import {frame} from '../src/slots.mjs';

function packet(value) {
  const bytes=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);return Buffer.concat([header,bytes]);
}
async function host(t,{unsupported=false,silent=false,fragment=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mab-'));
  const endpoint=process.platform==='win32'?String.raw`\\.\pipe\mab-test-${crypto.randomUUID()}`:path.join(dir,'ipc.sock');
  const calls=[],sockets=new Set();
  const bridge=createMicroBridge({getState:()=>({status:'connected',transport:'bluetooth'}),
    getAllowedBanks:()=>[6,12],request:async(method,params)=>{
      calls.push({method,params});return method==='device.status'?{layer_index:2}:{ok:true};
    }});
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});
    const send=value=>{
      const bytes=packet(value);
      if(fragment){socket.write(bytes.subarray(0,2));socket.write(bytes.subarray(2,7));socket.write(bytes.subarray(7));}
      else socket.write(bytes);
    };
    const session=bridge.openSession({localUserVerified:true,send:value=>send({type:'broadcast',method:'micro-agent-bridge/event',params:value})});
    socket.on('close',()=>{sockets.delete(socket);void session.close().catch(()=>{});});
    let buffer=Buffer.alloc(0);
    socket.on('data',bytes=>{
      buffer=Buffer.concat([buffer,bytes]);
      while(buffer.length>=4&&buffer.length>=buffer.readUInt32LE(0)+4) {
        const n=buffer.readUInt32LE(0),q=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4);
        if(q.type!=='request'||silent)continue;
        void (async()=>{
          const response={type:'response',requestId:q.requestId,method:q.method};
          try {
            let result;
            if(q.method==='initialize')result={clientId:'test-client'};
            else if(unsupported){send({type:'response',requestId:q.requestId,resultType:'error',error:'no-client-found'});return;}
            else result=await session.handle(q.method,q.params);
            send({...response,resultType:'success',result});
          }catch(e){send({...response,resultType:'error',error:{message:e.message}});}
        })();
      }
    });
  });
  server.listen(endpoint);await once(server,'listening');
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));await bridge.dispose();fs.rmSync(dir,{recursive:true,force:true});});
  return {endpoint,bridge,calls,sockets};
}

test('Windows uses the local Codex named pipe; Unix keeps its existing endpoint',()=>{
  assert.equal(codexIpcEndpoint({platform:'win32'}),String.raw`\\.\pipe\codex-ipc`);
  assert.equal(codexIpcEndpoint({platform:'linux',home:'/example'}),path.join('/example','.codex','ipc','ipc.sock'));
  assert.throws(()=>new MicroServiceClient({endpoint:String.raw`\\server\pipe\remote`}),/local/i);
});

test('real pipe handshake, fragmented replies, lighting, subscriptions and cleanup',async t=>{
  const h=await host(t,{fragment:true});
  const client=new MicroServiceClient({endpoint:h.endpoint});t.after(()=>client.close());
  const hello=await client.connect({banks:[6,12]});
  assert.deepEqual(hello.banks,[6,12]);
  assert.deepEqual(await client.status(),{status:'connected',transport:'bluetooth',layerIndex:2});
  const value=frame(Array(6).fill('idle'),6);
  assert.deepEqual(await client.lights(value),{sent:true});
  await client.subscribe(['input','layer']);
  const input=once(client,'input');h.bridge.publish('v.oai.hid',{k:'AG06',act:1});
  assert.deepEqual((await input)[0],{event:'input',key:'AG06',act:1});
  await client.close();
  assert.equal(client.ready,false);
  assert.deepEqual(h.calls.map(x=>x.method),['device.status','v.oai.thstatus','v.oai.thstatus']);
  assert.ok(h.calls.at(-1).params.every(x=>x.b===0));
});

test('unimplemented extension returns an actionable error without device calls',async t=>{
  const h=await host(t,{unsupported:true});
  const client=new MicroServiceClient({endpoint:h.endpoint});t.after(()=>client.close());
  await assert.rejects(client.connect(),e=>e.code==='MICRO_UNAVAILABLE'&&/host integration/i.test(e.message));
  assert.equal(client.ready,false);assert.equal(h.calls.length,0);
});

test('a silent endpoint has a bounded connection deadline',async t=>{
  const h=await host(t,{silent:true});
  const client=new MicroServiceClient({endpoint:h.endpoint,timeout:50});t.after(()=>client.close());
  await assert.rejects(client.connect(),/deadline/i);
  assert.equal(client.ready,false);
});

test('oversized and invalid messages close the client; reconnect never replays writes',async t=>{
  const h=await host(t);
  const client=new MicroServiceClient({endpoint:h.endpoint});t.after(()=>client.close());
  await client.connect({banks:[6]});
  await client.lights(frame(Array(6).fill('working'),6));
  const lost=once(client,'lost');
  const header=Buffer.alloc(4);header.writeUInt32LE(0xffffffff);[...h.sockets][0].write(header);
  assert.match((await lost)[0].message,/frame/i);
  assert.equal(client.ready,false);
  await assert.rejects(client.status(),/connect/i);
  // A read-only reconnect does not reacquire or replay the old lighting grant.
  await client.connect();
  assert.equal((await client.status()).layerIndex,2);
  const lights=h.calls.filter(x=>x.method==='v.oai.thstatus');
  assert.equal(lights.filter(x=>x.params.some(v=>v.b>0)).length,1);
  const bad=once(client,'lost');[...h.sockets].at(-1).write(packet(null));
  assert.match((await bad)[0].message,/message/i);
});

test('disconnect rejects outstanding work and concurrent connect shares negotiation',async t=>{
  const h=await host(t);
  const client=new MicroServiceClient({endpoint:h.endpoint});t.after(()=>client.close());
  const [a,b]=await Promise.all([client.connect(),client.connect()]);assert.deepEqual(a,b);
  const pending=client.status();const rejected=assert.rejects(pending,/disconnect|closed/i);
  for(const socket of h.sockets)socket.destroy();
  await rejected;assert.equal(client.ready,false);
});
