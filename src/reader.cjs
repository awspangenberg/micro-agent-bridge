'use strict';
// This adapter is gated to the inspected Codex bundle in install.mjs.
// Its HIDAsync "newListener" hook unconditionally restarts the native reader.
// Append only our callback to the existing EventEmitter data list, without
// emitting that hook, changing native callbacks, or starting another reader.
module.exports=function observeExistingReader(device,listener){
  if(Object.getPrototypeOf(device)?.constructor?.name!=='HIDAsync'||typeof device.rawListeners!=='function'||typeof listener!=='function')throw Error('Unsupported existing HID reader');
  const table=device._events,descriptor=table&&Object.getOwnPropertyDescriptor(table,'data');
  if(!descriptor?.writable)throw Error('Native data listener is unavailable');
  const existing=typeof descriptor.value==='function'?[descriptor.value]:Array.isArray(descriptor.value)?descriptor.value.slice():[];
  if(!existing.length||existing.some(fn=>typeof fn!=='function'))throw Error('Native data listener is unavailable');
  const actual=device.rawListeners('data');
  if(actual.length!==existing.length||actual.some((fn,i)=>fn!==existing[i]))throw Error('Unexpected native listener shape');
  if(existing.includes(listener))return;
  Object.defineProperty(table,'data',{...descriptor,value:[...existing,listener]});
};
