import os from 'node:os';
import path from 'node:path';

export function codexIpcEndpoint({platform=process.platform,home=os.homedir()}={}) {
  return platform==='win32'?String.raw`\\.\pipe\codex-ipc`:path.join(home,'.codex','ipc','ipc.sock');
}

export function localEndpoint(endpoint) {
  if(typeof endpoint!=='string'||endpoint.includes('\0'))throw Error('A local IPC endpoint is required');
  if(endpoint.startsWith('\\\\')) {
    if(!/^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(endpoint))throw Error('Only a local Windows named pipe is allowed');
  } else if(process.platform==='win32'||!path.isAbsolute(endpoint))throw Error('A local IPC endpoint is required');
  return endpoint;
}
