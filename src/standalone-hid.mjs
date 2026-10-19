import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {eventValue, lightingFrame} from './micro-protocol.mjs';

const MAX_BUFFER = 256 * 1024;
export const microDevice = d => d.vendorId === 0x303a && d.productId === 0x8360 && d.usagePage === 0xff00;
export async function enumerateMicroDevices() {
  const {default: hid} = await import('node-hid');
  return (await hid.devicesAsync(0x303a, 0x8360)).filter(microDevice).map(d => ({
    path: d.path, product: d.product || 'Codex Micro', serialNumber: d.serialNumber || null,
    key: createHash('sha256').update(d.serialNumber || d.path).digest('hex').slice(0, 24),
  }));
}

// Windows HID collection paths of one device instance differ only in &ColNN and the
// trailing instance number. Returns null when a path has no collection component.
export function collectionInstance(path) {
  const match = /^(.*)&col[0-9a-f]{2}#(.*)&[0-9a-f]{4}#(\{[0-9a-f-]+\})(?:\\.*)?$/i.exec(path ?? '');
  return match ? `${match[1]}#${match[2]}#${match[3]}`.toLowerCase() : null;
}

// While this host holds the RPC collection with share mode 0, hidapi cannot open it
// and omits it from enumeration. Sibling collections of the same instance remain.
export async function enumerateMicroTopology() {
  const {default: hid} = await import('node-hid');
  const all = await hid.devicesAsync(0x303a, 0x8360);
  return {rpc: all.filter(microDevice).map(d => ({path: d.path})), collections: all.map(d => d.path)};
}

function unchangedTopology(current, expectedPath) {
  const rpc = Array.isArray(current) ? current : current?.rpc;
  if (!Array.isArray(rpc) || rpc.some(d => d.path !== expectedPath) || rpc.length > 1) return false;
  if (rpc.length === 1) return true;
  // The held interface is hidden; require its own instance to still be enumerated.
  const instance = collectionInstance(expectedPath);
  return !!instance && !Array.isArray(current) && Array.isArray(current?.collections) &&
    current.collections.some(path => path !== expectedPath && collectionInstance(path) === instance);
}

export function connectionGuard(enumerate, expectedPath, {now = Date.now, intervalMs = 2000} = {}) {
  let lastCheck = -Infinity, lastActivity = now(), pending;
  return async () => {
    const started = now();
    if (started < lastActivity || started - lastActivity > 15000) throw Error('Host paused or system resumed; explicitly restart the Micro host.');
    lastActivity = started;
    if (started - lastCheck < intervalMs) return;
    if (!pending) pending = Promise.resolve().then(enumerate).then(current => {
      if (!unchangedTopology(current, expectedPath)) throw Error('Micro connection changed; stop and explicitly restart the host.');
      if (now() - started > 15000) throw Error('Micro topology check paused; explicitly restart the host.');
      lastCheck = now();
    }).finally(() => { pending = null; });
    await pending;
  };
}

// node-hid is used only for enumeration. Its Windows handles permit sharing.
// This helper opens every discovered RPC interface with CreateFile share mode 0.
export class WindowsHidHandle extends EventEmitter {
  static async open(devices, activePath) {
    if (process.platform !== 'win32') throw Error('The standalone HID host requires Windows');
    const handle = new WindowsHidHandle();
    try {
      const result = await handle.command('open', {paths: devices.map(d => d.path), activePath});
      if (handle.ended || result?.opened !== true || result.exclusive !== true ||
        result.inputReportLength !== 64 || result.outputReportLength !== 64) throw Error('HID helper did not confirm exclusive compatible ownership');
      handle.capabilities = result;
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  constructor() {
    super();
    this.pending = new Map(); this.serial = 0; this.ended = false; this.buffer = '';
    this.child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', fileURLToPath(new URL('./windows-hid.ps1', import.meta.url))], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > MAX_BUFFER) return this.fail(Error('Oversized HID helper output'));
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.event === 'data') {
            if (typeof message.data !== 'string' || message.data.length > 88) throw Error('Invalid HID helper report');
            const report = Buffer.from(message.data, 'base64');
            if (report.length !== 64 || report.toString('base64') !== message.data) throw Error('Invalid HID helper report');
            this.emit('data', report);
          } else if (message.event === 'error') this.fail(Error(message.error?.message || String(message.error)));
          else {
            const pending = this.pending.get(message.id);
            if (!pending) continue;
            this.pending.delete(message.id); clearTimeout(pending.timer);
            if (message.error) pending.reject(Error(message.error.message || String(message.error)));
            else pending.resolve(message.result);
          }
        } catch (error) { this.fail(error); }
      }
    });
    // Keep compiler diagnostics bounded; never forward arbitrary device contents.
    this.diagnostic = '';
    this.child.stderr.on('data', chunk => { this.diagnostic = (this.diagnostic + chunk).slice(-4096); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.exited = new Promise(resolve => this.child.once('close', (code) => {
      if (!this.ended) this.fail(Error(`HID helper exited (${code}): ${this.diagnostic.trim()}`));
      resolve();
    }));
  }
  command(command, params = {}) {
    if (this.ended) return Promise.reject(Error('HID helper closed'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(Error(`HID helper ${command} timed out`)), 15000);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(JSON.stringify({id, command, ...params}) + '\n');
    });
  }
  write(bytes) { return this.command('write', {data: Buffer.from(bytes).toString('base64')}); }
  fail(error) {
    if (this.ended) return;
    this.ended = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.child.kill(); this.emit('fault', error);
  }
  async close() {
    if (!this.ended) {
      try { await this.command('close'); } catch { /* fail() already terminates the helper */ }
      this.ended = true; this.child.stdin.end();
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('HID helper closed')); }
      this.pending.clear(); this.child.kill();
    }
    await this.exited;
  }
}

// Only the ambient ring is driven; key backlighting always stays off.
export function ambientConfig(params) {
  const side = params?.ambient;
  if (!side || !Number.isInteger(side.c) || side.c < 0 || side.c > 0xffffff || !Number.isFinite(side.b) || side.b < 0 || side.b > .65 ||
    ![0, 1, 2, 4, 6].includes(side.e) || !Number.isFinite(side.s) || side.s < 0 || side.s > 1 || (side.m !== undefined && side.m !== 0)) throw Error('Invalid ambient lighting');
  return {ambient: {e: side.e, b: side.b, s: side.s, m: 0, c: side.c}, keys: {e: 0, b: 0, s: 0, m: 0, c: 0}};
}

function validateRpc(method, params) {
  if (!['sys.version', 'device.status', 'v.oai.thstatus', 'v.oai.rgbcfg', 'fs.readbin', 'fs.writebin'].includes(method)) throw Error('Unsupported Micro RPC');
  if (method === 'v.oai.thstatus') return lightingFrame(params, [0, 6, 12]);
  if (method === 'v.oai.rgbcfg') return ambientConfig(params);
  if (method.startsWith('fs.')) {
    if (params?.file !== 'keymap.json' || !Number.isInteger(params.offset) || params.offset < 0 || params.offset > 100000)
      throw Error('Invalid profile RPC');
    if (method === 'fs.readbin' && (!Number.isInteger(params.len) || params.len < 1 || params.len > 3072)) throw Error('Invalid profile read');
    if (method === 'fs.writebin') {
      if (typeof params.data !== 'string' || params.data.length > 172 || params.append !== true || typeof params.completed !== 'boolean') throw Error('Invalid profile write');
      const bytes = Buffer.from(params.data, 'base64');
      if (bytes.length < 1 || bytes.length > 128 || bytes.toString('base64') !== params.data || params.offset + bytes.length > 100000) throw Error('Invalid profile write');
    }
  }
  return params;
}

export class MicroHidTransport extends EventEmitter {
  constructor(handle, {timeoutMs = 10000, cooldownMs = 50, maxPending = 32, beforeRequest = async () => {}} = {}) {
    super(); Object.assign(this, {handle, timeoutMs, cooldownMs, maxPending, beforeRequest});
    this.queue = []; this.current = null; this.serial = 0; this.closed = false; this.buffer = Buffer.alloc(0);
    this.onData = bytes => { try { this.receive(bytes); } catch (error) { void this.close(error); } };
    this.onFault = error => { void this.close(error); };
    handle.on('data', this.onData); handle.on('fault', this.onFault); handle.on('error', this.onFault);
  }
  rpc(method, params = {}) {
    try { params = validateRpc(method, params); } catch (error) { return Promise.reject(error); }
    if (this.closed) return Promise.reject(Error('Micro transport closed'));
    if (this.queue.length + Number(!!this.current) >= this.maxPending) return Promise.reject(Error('Micro RPC queue full'));
    // Snapshot arguments now so callers cannot change a queued profile write.
    const request = JSON.parse(JSON.stringify({method, params}));
    return new Promise((resolve, reject) => { this.queue.push({request, resolve, reject}); void this.drain(); });
  }
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.closed) {
        const item = this.queue.shift();
        try { item.resolve(await this.send(item.request)); }
        catch (error) { item.reject(error); await this.close(error); }
        if (!this.closed && this.cooldownMs) await delay(this.cooldownMs);
      }
    } finally { this.draining = false; }
  }
  async send(request) {
    const id = this.serial; this.serial = (id + 1) % 999;
    const bytes = Buffer.from(JSON.stringify({...request, id}).replace(/[\u007f-\uffff]/g,
      c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')), 'ascii');
    let resolve, reject, abort;
    const response = new Promise((yes, no) => { resolve = yes; reject = no; });
    const cancelled = new Promise((_, no) => { abort = no; });
    // Attach immediately: a device can disconnect while a write is in flight.
    response.catch(() => {});
    cancelled.catch(() => {});
    const timer = setTimeout(() => { void this.close(Error(`Micro RPC ${request.method} timed out`)); }, this.timeoutMs);
    this.current = {id, resolve, reject: error => { reject(error); abort(error); }, timer};
    const write = async () => {
      for (let offset = 0; offset < bytes.length; offset += 61) {
        await this.beforeRequest();
        if (this.closed) throw Error('Micro transport closed');
        const part = bytes.subarray(offset, offset + 61), report = Buffer.alloc(64);
        report[0] = 6; report[1] = 2; report[2] = part.length; part.copy(report, 3);
        await this.handle.write(report);
      }
    };
    try { return await Promise.race([Promise.all([write(), response]).then(([, result]) => result), cancelled]); }
    finally { clearTimeout(timer); this.current = null; }
  }
  receive(raw) {
    const bytes = Buffer.from(raw);
    if (bytes.length !== 64) throw Error('Invalid HID report size');
    if (bytes[0] !== 6 || bytes[1] !== 2) return;
    if (bytes[2] > 61) throw Error('Invalid HID RPC payload length');
    this.buffer = Buffer.concat([this.buffer, bytes.subarray(3, 3 + bytes[2])]);
    if (this.buffer.length > MAX_BUFFER) throw Error('Oversized Micro RPC response');
    let end;
    while ((end = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
      if (!line.toString('utf8').trim()) continue;
      const message = JSON.parse(line.toString('utf8'));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('Invalid Micro RPC response');
      const id = message.id ?? message.i;
      if (id !== undefined && id !== null) {
        if (!this.current || id !== this.current.id) continue;
        if (message.error) this.current.reject(Error(`Micro RPC error: ${message.error.message || message.error.code || 'unknown'}`));
        else if (Object.hasOwn(message, 'result')) this.current.resolve(message.result);
        else throw Error('Micro RPC response has no result');
      } else {
        const event = eventValue(message.method ?? message.m, message.params ?? message.p);
        if (event) this.emit(event.event, event);
      }
    }
  }
  close(error) {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const reason = error || Error('Micro transport closed');
    if (this.current) { clearTimeout(this.current.timer); this.current.reject(reason); }
    for (const item of this.queue.splice(0)) item.reject(reason);
    this.handle.removeListener('data', this.onData);
    this.closePromise = Promise.resolve().then(() => this.handle.close()).catch(() => {}).then(() => {
      this.handle.removeListener('fault', this.onFault); this.handle.removeListener('error', this.onFault);
      this.emit('closed', error || null);
    });
    return this.closePromise;
  }
}
