// Proposed host extension, not an API shipped by Codex desktop.
export const PREFIX='micro-agent-bridge/';
export const PROTOCOL=1;
export const EVENTS=['input','layer','state','invalidate'];

export function banks(value) {
  if(!Array.isArray(value)||value.length>2||new Set(value).size!==value.length||
    value.some(x=>x!==6&&x!==12))throw Error('Invalid custom lighting banks');
  return [...value];
}

export function lightingFrame(value,owned) {
  if(!Array.isArray(value)||value.length!==6)throw Error('Expected six lighting slots');
  const bank=owned.find(start=>value.every(x=>x&&Number.isInteger(x.id)&&x.id>=start&&x.id<start+6));
  if(bank===undefined||new Set(value.map(x=>x.id)).size!==6)throw Error('Invalid or unowned lighting bank');
  return value.map(x=>{
    if(!Number.isInteger(x.c)||x.c<0||x.c>0xffffff||
      !Number.isFinite(x.b)||x.b<0||x.b>.65||
      ![0,1,4,6].includes(x.e)||!Number.isFinite(x.s)||x.s<0||x.s>1||
      (x.sk!==undefined&&x.sk!==0)||(x.sa!==undefined&&x.sa!==0))throw Error('Invalid lighting slot');
    return {id:x.id,c:x.c,b:x.b,e:x.e,s:x.s,sk:0,sa:0};
  });
}

export const clearFrame=bank=>Array.from({length:6},(_,i)=>({id:bank+i,c:0,b:0,e:0,s:0,sk:0,sa:0}));

export function deviceState(value,layerIndex=null) {
  const status=['connected','disconnected','not-detected','detected','connecting','error'].includes(value?.status)?value.status:'unknown';
  return {status,transport:['usb','bluetooth'].includes(value?.transport)?value.transport:null,
    layerIndex:status==='connected'&&Number.isInteger(layerIndex)&&layerIndex>=0&&layerIndex<=255?layerIndex:null};
}

export function eventValue(method,value) {
  if(method==='v.oai.hid') {
    const key=value?.k??value?.key;
    if(typeof key==='string'&&/^(?:AG\d{2}|ACT\d{2}|ENC_(?:CC|CW|CLK))$/.test(key)&&Number.isInteger(value.act)&&value.act>=0&&value.act<=3)
      return {event:'input',key,act:value.act};
  }
  // Codex's native joystick: angle 0..1 and distance 0..1, streamed while pushed.
  if(method==='v.oai.rad') {
    if(Number.isFinite(value?.a)&&value.a>=0&&value.a<=1&&Number.isFinite(value?.d)&&value.d>=0&&value.d<=1)
      return {event:'stick',a:value.a,d:value.d};
  }
  if(method==='kb.radial') {
    const layerIndex=value?.layer_index??value?.layerIndex;
    if(Number.isInteger(layerIndex)&&layerIndex>=0&&layerIndex<=255)return {event:'layer',layerIndex};
    // Radial joystick reports on the Claude and Mixed layers carry the current layer as `l`.
    if(Number.isInteger(value?.l)&&value.l>=0&&value.l<=255)return {event:'radial',layerIndex:value.l};
  }
  return null;
}
