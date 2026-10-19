import {PREFIX,PROTOCOL,EVENTS,banks,lightingFrame,clearFrame,deviceState,eventValue} from './micro-protocol.mjs';

/**
 * Host-side integration. This module does not listen on a socket or attach to an
 * application. Only the process already owning the Micro may instantiate it.
 * request(method, params) MUST use that service's complete-request queue and
 * deadline, and return the unwrapped RPC result. getAllowedBanks() reads consent
 * held by the host, never parameters supplied by an IPC client.
 */
export function createMicroBridge({getState,request,getAllowedBanks=()=>[],maxPending=8}) {
  if(typeof getState!=='function'||typeof request!=='function'||typeof getAllowedBanks!=='function')
    throw Error('Native service callbacks are required');
  if(!Number.isInteger(maxPending)||maxPending<1||maxPending>64)throw Error('Invalid pending limit');
  const sessions=new Set(),owners=new Map();
  let disposed=false,disposing=null,suspended=false,generation=0,layerIndex=null,pending=0,chain=Promise.resolve();
  const allowed=()=>banks(getAllowedBanks());
  const connected=()=>getState()?.status==='connected';
  const available=()=>connected()&&!suspended&&getState()?.controlPlaneStatus!=='unavailable';

  function enqueue(fn) {
    if(pending>=maxPending)return Promise.reject(Error('Micro service busy'));
    pending++;
    const result=chain.then(fn);
    chain=result.catch(()=>{}).finally(()=>pending--);
    return result;
  }
  function broadcast(value) {
    for(const s of sessions)if(s.ready&&!s.closing&&s.events.has(value.event)) {
      try{s.send(structuredClone(value));}catch{void s.close().catch(()=>{});}
    }
  }
  function invalidate(reason='connection-changed') {
    generation++;layerIndex=null;
    if(reason==='suspend')suspended=true;
    if(reason==='resume')suspended=false;
    const safeReason=['connection-changed','consent-changed','suspend','resume','service-stop'].includes(reason)?reason:'connection-changed';
    broadcast({event:'invalidate',reason:safeReason});
    broadcast({event:'state',...deviceState(getState())});
  }

  function openSession({localUserVerified=false,send}={}) {
    // This argument belongs to the host integration, not the wire protocol.
    if(localUserVerified!==true)throw Error('A verified local same-user connection is required');
    if(disposed)throw Error('Micro service stopped');
    if(sessions.size>=16)throw Error('Too many Micro sessions');
    if(typeof send!=='function')throw Error('Event sink is required');
    const s={send,ready:false,closing:false,banks:[],events:new Set(),written:new Map(),close:null};
    sessions.add(s);
    function check(bank=null,epoch=generation) {
      if(disposed||s.closing)throw Error('Micro session closed');
      if(epoch!==generation)throw Error('Micro connection or consent changed');
      if(bank!==null&&(!s.banks.includes(bank)||!allowed().includes(bank)))throw Error('Lighting bank requires user consent');
      if(suspended)throw Error('Micro device I/O suspended');
      if(!connected())throw Error('Micro device disconnected');
      if(getState()?.controlPlaneStatus==='unavailable')throw Error('Micro control plane unavailable');
    }
    let closing;
    s.close=()=>{
      if(closing)return closing;
      s.closing=true;
      // Cleanup follows accepted writes. Keep ownership until it completes, so a
      // former client's clear cannot overwrite a newly granted client's frame.
      closing=chain.then(async()=>{
        try {
          for(const [bank,epoch] of s.written)if(epoch===generation&&available()&&allowed().includes(bank))
            await request('v.oai.thstatus',clearFrame(bank));
        } finally {
          for(const bank of s.banks)if(owners.get(bank)===s)owners.delete(bank);
          sessions.delete(s);
        }
      });
      chain=closing.catch(()=>{});
      return closing;
    };

    async function handle(method,params={}) {
      if(disposed||s.closing)throw Error('Micro session closed');
      if(!params||typeof params!=='object'||Array.isArray(params))throw Error('Invalid method parameters');
      if(method===PREFIX+'initialize') {
        if(s.ready)throw Error('Micro session already initialized');
        if(params.protocol!==PROTOCOL)throw Error('Unsupported Micro protocol');
        const wanted=banks(params.banks),granted=allowed();
        if(wanted.some(x=>!granted.includes(x)))throw Error('Lighting bank requires user consent');
        if(wanted.some(x=>owners.has(x)))throw Error('Lighting bank already owned');
        for(const bank of wanted)owners.set(bank,s);
        s.banks=wanted;s.ready=true;
        return {protocol:PROTOCOL,banks:[...wanted],allowedBanks:granted,events:[...EVENTS],profileWrite:false};
      }
      if(!s.ready)throw Error('Micro session must initialize first');
      if(method===PREFIX+'subscribe') {
        if(!Array.isArray(params.events)||params.events.length>EVENTS.length||params.events.some(x=>!EVENTS.includes(x)))throw Error('Invalid event subscription');
        s.events=new Set(params.events);return {subscribed:[...s.events]};
      }
      if(method===PREFIX+'status') {
        if(!available())return deviceState(getState());
        const epoch=generation;
        return enqueue(async()=>{
          check(null,epoch);
          const result=await request('device.status',{});
          check(null,epoch);
          if(!Number.isInteger(result?.layer_index)||result.layer_index<0||result.layer_index>255)throw Error('Invalid device status');
          layerIndex=result.layer_index;
          return deviceState(getState(),layerIndex);
        });
      }
      if(method===PREFIX+'lights') {
        const value=lightingFrame(params.frame,s.banks),bank=Math.floor(value[0].id/6)*6,epoch=generation;
        check(bank,epoch);
        return enqueue(async()=>{
          check(bank,epoch);s.written.set(bank,epoch);
          await request('v.oai.thstatus',value);
          return {sent:true};
        });
      }
      if(method===PREFIX+'release') {await s.close();return {released:true};}
      throw Error('Micro method not allowed');
    }
    return {handle,close:s.close};
  }

  return {
    openSession,invalidate,
    publish(method,params) {
      if(disposed||suspended||!connected())return;
      const value=eventValue(method,params);
      if(!value)return;
      if(value.event==='layer')layerIndex=value.layerIndex;
      broadcast(value);
    },
    dispose() {
      if(disposing)return disposing;
      broadcast({event:'invalidate',reason:'service-stop'});disposed=true;layerIndex=null;
      disposing=Promise.allSettled([...sessions].map(s=>s.close())).then(results=>{
        const errors=results.filter(x=>x.status==='rejected').map(x=>x.reason);
        if(errors.length)throw new AggregateError(errors,'Micro cleanup failed');
      });
      return disposing;
    },
  };
}
