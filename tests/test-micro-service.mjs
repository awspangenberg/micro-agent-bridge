import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMicroBridge} from '../src/micro-service.mjs';
import {frame} from '../src/slots.mjs';

const lights=bank=>frame(Array(6).fill('working'),bank);
function fixture(options={}) {
  const calls=[],events=[];
  let allowed=[6,12],state={status:'connected',transport:'usb'},layer=1;
  const bridge=createMicroBridge({
    getState:()=>state,
    getAllowedBanks:()=>allowed,
    request:async(method,params)=>{
      calls.push({method,params});
      return method==='device.status'?{layer_index:layer,prompt:'private'}:{ok:true};
    },...options,
  });
  const session=bridge.openSession({localUserVerified:true,send:x=>events.push(x)});
  return {bridge,session,calls,events,setAllowed:x=>allowed=x,setState:x=>state=x,
    setLayer:x=>layer=x,call:(method,params={})=>session.handle('micro-agent-bridge/'+method,params)};
}

test('host authentication and explicit bank consent are required',async()=>{
  const f=fixture();
  assert.throws(()=>f.bridge.openSession({send:()=>{}}),/local.*user/i);
  await assert.rejects(f.call('lights',{frame:lights(6)}),/initializ/i);
  f.setAllowed([]);
  await assert.rejects(f.call('initialize',{protocol:1,banks:[6]}),/consent/i);
  await assert.rejects(f.call('initialize',{protocol:2,banks:[]}),/protocol/i);
  await assert.rejects(f.call('initialize',{protocol:1,banks:[0]}),/bank/i);
  assert.deepEqual(f.calls,[]);
  await f.bridge.dispose();
});

test('only an entire opted-in bank reaches the existing device request queue',async()=>{
  const f=fixture();
  const hello=await f.call('initialize',{protocol:1,banks:[6]});
  assert.deepEqual(hello.banks,[6]);
  assert.equal(hello.profileWrite,false);
  for(const value of [lights(12),lights(6).map((x,i)=>i?x:{...x,id:0}),
    lights(6).map(x=>({...x,id:6})),lights(6).slice(1),
    lights(6).map(x=>({...x,b:1})),lights(6).map(x=>({...x,sk:1}))]) {
    await assert.rejects(f.call('lights',{frame:value}));
  }
  await assert.rejects(f.call('fs.writebin',{file:'keymap.json'}),/method/i);
  assert.equal(f.calls.length,0);
  assert.deepEqual(await f.call('lights',{frame:lights(6)}),{sent:true});
  assert.deepEqual(f.calls,[{method:'v.oai.thstatus',params:lights(6)}]);
  await f.session.close();
  assert.deepEqual(f.calls.at(-1).params.map(x=>x.id),[6,7,8,9,10,11]);
  assert.ok(f.calls.at(-1).params.every(x=>x.b===0));
  await f.bridge.dispose();
});

test('status and subscribed events omit unrelated data and do not alter native listeners',async()=>{
  const f=fixture();
  await f.call('initialize',{protocol:1,banks:[]});
  const status=await f.call('status');
  assert.deepEqual(status,{status:'connected',transport:'usb',layerIndex:1});
  f.bridge.publish('v.oai.hid',{k:'AG06',act:1,prompt:'secret'});
  assert.equal(f.events.length,0);
  await f.call('subscribe',{events:['input','layer','state','invalidate']});
  f.bridge.publish('v.oai.hid',{k:'AG06',act:1,ag:{private:'secret'},prompt:'secret'});
  f.bridge.publish('kb.radial',{layer_index:2,other:'secret'});
  f.bridge.publish('unrelated',{prompt:'secret'});
  f.bridge.publish('v.oai.hid',{k:'arbitrary text',act:1});
  assert.deepEqual(f.events.slice(0,2),[
    {event:'input',key:'AG06',act:1},
    {event:'layer',layerIndex:2},
  ]);
  f.setState({status:'disconnected',transport:null,private:'secret'});
  f.bridge.invalidate('connection-changed');
  assert.deepEqual(await f.call('status'),{status:'disconnected',transport:null,layerIndex:null});
  assert.equal(JSON.stringify(f.events).includes('secret'),false);
  assert.equal(f.calls.filter(x=>x.method==='device.status').length,1);
  await f.bridge.dispose();
});

test('banks have one owner and become available after cleanup',async()=>{
  const f=fixture();
  await f.call('initialize',{protocol:1,banks:[6]});
  const second=f.bridge.openSession({localUserVerified:true,send:()=>{}});
  await assert.rejects(second.handle('micro-agent-bridge/initialize',{protocol:1,banks:[6,12]}),/owned/i);
  const third=f.bridge.openSession({localUserVerified:true,send:()=>{}});
  await third.handle('micro-agent-bridge/initialize',{protocol:1,banks:[12]});
  await f.session.close();
  await second.handle('micro-agent-bridge/initialize',{protocol:1,banks:[6]});
  await f.bridge.dispose();
});

test('revoked consent, disconnects and queued work cannot write stale frames',async()=>{
  let finish;
  const calls=[];
  const f=fixture({request:async(method,params)=>{
    calls.push({method,params});
    if(calls.length===1)await new Promise(r=>finish=r);
    return {ok:true};
  }});
  await f.call('initialize',{protocol:1,banks:[6]});
  const first=f.call('lights',{frame:lights(6)});
  await new Promise(r=>setImmediate(r));
  const queued=f.call('lights',{frame:lights(6)});
  const rejected=assert.rejects(queued,/changed|consent/i);
  f.setAllowed([]);f.bridge.invalidate('consent-changed');finish();
  await first;await rejected;
  assert.equal(calls.length,1);
  await assert.rejects(f.call('lights',{frame:lights(6)}),/consent/i);
  f.setAllowed([6]);f.setState({status:'disconnected',transport:null});
  await assert.rejects(f.call('lights',{frame:lights(6)}),/connect/i);
  await f.bridge.dispose();
});

test('outstanding requests are bounded and a failed RPC does not poison the queue',async()=>{
  let finish,attempt=0;
  const f=fixture({maxPending:1,request:()=>++attempt===1?new Promise((resolve,reject)=>finish=()=>reject(Error('device failure'))):Promise.resolve({layer_index:2})});
  await f.call('initialize',{protocol:1,banks:[]});
  const first=f.call('status');const rejected=assert.rejects(first,/device failure/);
  await new Promise(r=>setImmediate(r));
  await assert.rejects(f.call('status'),/busy/i);
  finish();await rejected;
  assert.equal((await f.call('status')).layerIndex,2);
  await f.bridge.dispose();
});

test('suspend and an unavailable control plane prevent device I/O',async()=>{
  const f=fixture();
  await f.call('initialize',{protocol:1,banks:[6]});
  f.bridge.invalidate('suspend');
  await assert.rejects(f.call('lights',{frame:lights(6)}),/suspend/i);
  assert.equal((await f.call('status')).layerIndex,null);
  assert.equal(f.calls.length,0);
  f.bridge.invalidate('resume');
  f.setState({status:'connected',transport:'usb',controlPlaneStatus:'unavailable'});
  await assert.rejects(f.call('lights',{frame:lights(6)}),/control plane/i);
  assert.equal((await f.call('status')).layerIndex,null);
  assert.equal(f.calls.length,0);
  await f.bridge.dispose();
});

test('closing an old session never clears lights on a replacement device',async()=>{
  const f=fixture();
  await f.call('initialize',{protocol:1,banks:[6]});
  await f.call('lights',{frame:lights(6)});
  f.bridge.invalidate('connection-changed');
  await f.session.close();
  assert.equal(f.calls.length,1);
  await f.bridge.dispose();
});

test('repeated host disposal waits for the same cleanup',async()=>{
  let finish;
  const f=fixture({request:async(method,params)=>{
    if(params.every(x=>x.b===0))await new Promise(resolve=>finish=resolve);
    return {ok:true};
  }});
  await f.call('initialize',{protocol:1,banks:[6]});
  await f.call('lights',{frame:lights(6)});
  const first=f.bridge.dispose();let complete=false;
  const second=f.bridge.dispose().then(()=>complete=true);
  await new Promise(r=>setImmediate(r));
  try{assert.equal(complete,false);}finally{finish();await first;await second;}
});
