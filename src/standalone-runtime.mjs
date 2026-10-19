import {EventEmitter} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {allocate, pinIdentity} from './slots.mjs';
import {clearFrame} from './micro-protocol.mjs';
import {CodexActivity} from './standalone-activity.mjs';
import {slotLight, ambientLight} from './standalone-palette.mjs';

const run = promisify(execFile);
export async function readWindowsInventory({python = 'python', home, claudeData, stateDirectory} = {}) {
  const args = [fileURLToPath(new URL('./windows-inventory.py', import.meta.url))];
  if (home) args.push('--home', home);
  if (claudeData) args.push('--claude-data', claudeData);
  if (stateDirectory) args.push('--state', stateDirectory);
  const {stdout} = await run(python, args, {windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024});
  const inventory = JSON.parse(stdout);
  if (!inventory || !Array.isArray(inventory.codex) || !Array.isArray(inventory.claude) || !inventory.errors) throw Error('Invalid Windows inventory');
  return inventory;
}

export function taskRoute(task) {
  if (task?.host !== 'local' || task.archived) throw Error('Only local, unarchived task navigation is supported');
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (task.provider === 'codex' && uuid.test(task.nativeId) && task.hostId === 'local')
    return `codex://threads/${task.nativeId}?hostId=local`;
  if (task.provider === 'claude' && typeof task.navId === 'string') {
    if (task.navId.startsWith('local_') && uuid.test(task.navId.slice(6))) return `claude://code/continue?session=${task.navId}`;
    if (/^session_[A-Za-z0-9]{1,128}$/.test(task.navId)) return `claude://code/${task.navId}`;
  }
  throw Error('Invalid task navigation identity');
}
export async function openWindowsTask(task) {
  const url = taskRoute(task);
  if (process.platform !== 'win32') throw Error('Windows task navigation requires Windows');
  // Pass the validated URI as data, never as interpolated PowerShell code.
  await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Start-Process -FilePath $env:MICRO_AGENT_BRIDGE_URL -WindowStyle Hidden'],
  {windowsHide: true, timeout: 10000, env: {...process.env, MICRO_AGENT_BRIDGE_URL: url}});
}

export function reconcileViews(previous = [], inventory) {
  const sources = ['codex', 'claude'].map(provider => ({provider, host: 'local',
    available: !inventory.errors[provider], tasks: inventory[provider]}));
  return [allocate(previous[0], sources.slice(0, 1)), allocate(previous[1], sources.slice(1)), allocate(previous[2], sources)];
}
// Each slot uses the shared palette; working and inactive use the provider colour
// so Codex (blue) and Claude (amber) stay distinguishable on every layer.
export const standaloneFrame = (states, layer, providers = []) => {
  if (![0, 1, 2].includes(layer)) throw Error('Invalid standalone layer');
  return states.map((state, i) => slotLight(state, providers[i], layer * 6 + i));
};
// Mixed-layer lower controls, matching the Mac/Linux helpers. Only Claude tasks can
// be bound to a window exactly (its document URL names the session), so only they act.
export const ACTIONS = {
  ACT14: {labels: ['Allow once', 'Approve once', 'Allow this time', 'Allow'], navigates: false},
  ACT15: {labels: ['Deny', 'Reject'], navigates: false},
  ACT19: {labels: ['New', 'New session'], navigates: true},
  ACT04: {labels: ['Back'], navigates: true},
  ACT05: {labels: ['Forward'], navigates: true},
  ACT20: {labels: ['Hide sidebar', 'Show sidebar'], navigates: false},
};
export async function runWindowsAction(labels, ids) {
  if (process.platform !== 'win32') throw Error('Windows actions require Windows');
  const script = fileURLToPath(new URL('./windows-actions.ps1', import.meta.url));
  const {stdout} = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Names', labels.join('|'), '-Ids', ids.join('|')], {windowsHide: true, timeout: 15000, maxBuffer: 65536});
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}
const writeJson = (file, value) => { const temp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value), {mode: 0o600}); fs.renameSync(temp, file); };

export class StandaloneRuntime extends EventEmitter {
  constructor({transport, inventory, topology, openTask = openWindowsTask, runAction = runWindowsAction, stateDirectory, codex = new CodexActivity(), remote = null, pollMs = 2000}) {
    super(); Object.assign(this, {transport, inventory, topology, openTask, runAction, stateDirectory, codex, remote, pollMs});
    this.views = []; this.errors = {}; this.lastInventory = 0; this.lastPaint = []; this.stopped = false; this.selecting = false; this.acting = false; this.bound = null;
    this.onInput = event => { void (/^ACT\d\d$/.test(event.key) ? this.action(event) : this.select(event)).catch(error => this.emit('notice', error.message)); };
    this.onClosed = error => { void this.stop(error || Error('Device disconnected')); };
  }
  async start() {
    if (this.stateDirectory) {
      try {
        const file = path.join(this.stateDirectory, 'standalone-slots.json');
        if (fs.statSync(file).size <= 1024 * 1024) {
          const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (Array.isArray(saved) && saved.length === 3 && saved.every(v => v && Array.isArray(v.slots) && v.slots.length === 6 && Array.isArray(v.waiting) &&
            [...v.slots, ...v.waiting].every(t => { if (t === null) return true; try { taskRoute(t); return true; } catch { return false; } }))) this.views = saved;
        }
      } catch { /* Fresh allocation on missing or invalid cache. */ }
    }
    this.transport.on('input', this.onInput); this.transport.on('closed', this.onClosed);
    this.onLayer = event => { this.lastPaint = []; this.emit('layer', event.layerIndex); };
    this.transport.on('layer', this.onLayer);
    this.codex.connect();
    try { await this.tick(); }
    catch (error) { await this.stop(error); throw error; }
    if (this.stopped) throw Error('Standalone host stopped during startup');
    this.timer = setInterval(() => { void this.tick().catch(error => this.stop(error)); }, this.pollMs);
    return this.snapshot();
  }
  snapshot() {
    return {layers: this.views.map((v, layer) => ({layer: layer + 1, slots: v.slots.map(t => t ?
      {provider: t.provider, title: t.title, state: this.taskState(t)} : null), waiting: v.waiting.length})), errors: this.errors};
  }
  taskState(task) {
    if (!task) return 'empty';
    if (this.errors[task.provider] || Date.now() - this.lastInventory > 10000) return 'unknown';
    if (task.provider === 'codex') return this.codex.detail?.(task) ?? this.codex.state(task);
    // Hook detail is validated against the live process by the inventory.
    if (task.detail && task.detail !== 'unknown') return task.detail;
    if (task.state === 'working' || task.state === 'awaiting_input') return task.state;
    return this.remote?.state(task) ?? 'unknown';
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      this.checkAwake();
      // Topology checks never open another reader or reconnect/replay a write.
      await this.topology();
      if (this.stopped) return;
      this.checkAwake();
      let data;
      try { data = await this.inventory(); }
      catch { data = {codex: [], claude: [], errors: {codex: 'inventory-unavailable', claude: 'inventory-unavailable'}}; }
      if (this.stopped) return;
      this.checkAwake();
      this.errors = data.errors; this.lastInventory = Date.now();
      this.views = reconcileViews(this.views, data);
      if (this.stateDirectory) {
        fs.mkdirSync(this.stateDirectory, {recursive: true});
        writeJson(path.join(this.stateDirectory, 'standalone-slots.json'), this.views);
        // Owned hooks record only assigned local sessions; the list expires after 15 s.
        const ids = [...new Set(this.views.flatMap(v => v.slots).filter(t => t?.provider === 'claude' && t.host === 'local' && t.nativeId).map(t => t.nativeId))];
        writeJson(path.join(this.stateDirectory, 'claude-allowlist.json'), {timestamp: Date.now() / 1000, ids});
      }
      this.codex.update([...new Map(this.views.flatMap(v => v.slots).filter(t => t?.provider === 'codex').map(t => [pinIdentity(t), t])).values()]);
      this.codex.connect();
      if (this.remote) { this.remote.update(this.views.flatMap(v => v.slots)); this.remote.tick(); }
      await this.transport.rpc('device.status');
      for (let layer = 0; layer < 3 && !this.stopped; layer++) {
        this.checkAwake();
        const slots = this.views[layer].slots;
        const colors = standaloneFrame(slots.map(t => this.taskState(t)), layer, slots.map(t => t?.provider)), key = JSON.stringify(colors);
        if (key !== this.lastPaint[layer]) { await this.transport.rpc('v.oai.thstatus', colors); this.lastPaint[layer] = key; }
      }
      const ring = ambientLight(this.views.flatMap(v => v.slots).map(t => t && {provider: t.provider, state: this.taskState(t)}));
      const ringKey = JSON.stringify(ring);
      if (!this.stopped && ringKey !== this.lastRing) { await this.transport.rpc('v.oai.rgbcfg', {ambient: ring}); this.lastRing = ringKey; }
      if (!this.stopped) this.emit('state', this.snapshot());
    } finally { this.busy = false; }
  }
  checkAwake() {
    const now = Date.now();
    if (this.lastProgress && (now < this.lastProgress || now - this.lastProgress > Math.max(15000, this.pollMs * 3)))
      throw Error('Host paused or system resumed; explicitly restart the Micro host.');
    this.lastProgress = now;
  }
  async select(event) {
    if (this.stopped || this.selecting || event.act !== 1 || !/^AG(?:0[0-9]|1[0-7])$/.test(event.key)) return;
    const id = Number(event.key.slice(2)), task = this.views[Math.floor(id / 6)]?.slots[id % 6];
    if (!task || this.errors[task.provider] || Date.now() - this.lastInventory > 10000) return;
    if (this.lastSelection?.id === id && Date.now() - this.lastSelection.at < 500) return;
    this.selecting = true;
    try {
      taskRoute(task);
      try { await this.topology(); }
      catch (error) { await this.stop(error); throw error; }
      const current = this.views[Math.floor(id / 6)]?.slots[id % 6];
      if (this.stopped || !current || pinIdentity(current) !== pinIdentity(task) ||
        this.errors[current.provider] || Date.now() - this.lastInventory > 10000) return;
      await this.openTask(current);
      this.lastSelection = {id, at: Date.now()};
      // Lower Mixed controls bind to the Claude task opened from a Mixed key.
      this.bound = id >= 12 && current.provider === 'claude' ? {id, identity: pinIdentity(current), at: Date.now()} : null;
      this.emit('selected', {layer: Math.floor(id / 6) + 1, slot: id % 6 + 1, provider: task.provider});
    } finally { this.selecting = false; }
  }
  async action(event) {
    const spec = ACTIONS[event.key];
    if (this.stopped || this.acting || event.act !== 1 || !spec || !this.bound) return;
    const task = this.views[2]?.slots[this.bound.id - 12];
    // The binding expires and never follows a slot that now holds another task.
    if (!task || pinIdentity(task) !== this.bound.identity || Date.now() - this.bound.at > 15 * 60000 || this.errors.claude ||
      Date.now() - this.lastInventory > 10000) { this.bound = null; return; }
    const ids = [...new Set([task.navId, ...(Array.isArray(task.bridges) ? task.bridges : [])].filter(id => typeof id === 'string'))];
    this.acting = true;
    try {
      const result = await this.runAction(spec.labels, ids);
      this.emit('action', {key: event.key, performed: result?.performed === true, reason: result?.reason ?? null});
      if (result?.performed && spec.navigates) this.bound = null;
    } finally { this.acting = false; }
  }
  stop(error) {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true; clearInterval(this.timer); this.transport.removeListener('input', this.onInput);
    this.transport.removeListener('closed', this.onClosed);
    if (this.onLayer) this.transport.removeListener('layer', this.onLayer);
    this.codex.close(); this.codex.socket?.destroy(); this.remote?.close();
    this.stopPromise = (async () => {
      if (!error && !this.transport.closed) {
        try {
          if (this.lastRing) await this.transport.rpc('v.oai.rgbcfg', {ambient: {e: 0, b: 0, s: 0, m: 0, c: 0}});
          for (const bank of [0, 6, 12]) await this.transport.rpc('v.oai.thstatus', clearFrame(bank));
        } catch { /* Still close on unplug. */ }
      }
      if (this.stateDirectory) try { writeJson(path.join(this.stateDirectory, 'claude-allowlist.json'), {timestamp: 0, ids: []}); } catch { /* Expires anyway. */ }
      await this.transport.close(error);
      this.emit('stopped', error || null);
    })();
    return this.stopPromise;
  }
}
