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
import {ControlDecoder, ACTIONS, LAYERS, effectiveMapping, readSettings, readCodexLayout, supported} from './standalone-controls.mjs';
export {ACTIONS};

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
export async function runWindowsAction(labels, ids, mode = 'invoke') {
  if (process.platform !== 'win32') throw Error('Windows actions require Windows');
  const script = fileURLToPath(new URL('./windows-actions.ps1', import.meta.url));
  const {stdout} = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Names', labels.join('|'), '-Ids', ids.join('|'), '-Mode', mode], {windowsHide: true, timeout: 15000, maxBuffer: 65536});
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}
export async function sendCodexShortcut(chord) {
  if (process.platform !== 'win32') throw Error('Windows shortcuts require Windows');
  const script = fileURLToPath(new URL('./windows-keys.ps1', import.meta.url));
  const {stdout} = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Chord', chord],
    {windowsHide: true, timeout: 10000, maxBuffer: 65536});
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}
// Store app identities; opening by identity needs no URL handler.
export const APP_IDS = {codex: 'OpenAI.Codex_2p2nqsd0c76g0!App', claude: 'Claude_pzs8sxrjxfjjc!Claude'};
export async function openWindowsApp(provider) {
  const id = APP_IDS[provider];
  if (!id) throw Error('Unknown app');
  await run('explorer.exe', [`shell:AppsFolder\\${id}`], {windowsHide: true, timeout: 10000}).catch(error => {
    // explorer.exe exits 1 after handing the launch to the shell.
    if (error.code !== 1) throw error;
  });
  return {performed: true};
}
const writeJson = (file, value) => { const temp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value), {mode: 0o600}); fs.renameSync(temp, file); };

export class StandaloneRuntime extends EventEmitter {
  constructor({transport, inventory, topology, openTask = openWindowsTask, runAction = runWindowsAction, sendShortcut = sendCodexShortcut, openApp = openWindowsApp,
    settings = () => readSettings(this.stateDirectory), codexLayout = () => readCodexLayout(), stateDirectory, codex = new CodexActivity(), remote = null, pollMs = 2000, now = Date.now}) {
    super(); Object.assign(this, {transport, inventory, topology, openTask, runAction, sendShortcut, openApp, settings, codexLayout, stateDirectory, codex, remote, pollMs, now});
    this.views = []; this.errors = {}; this.lastInventory = 0; this.lastPaint = []; this.stopped = false; this.selecting = false; this.bound = null;
    this.decoder = new ControlDecoder({now}); this.queue = Promise.resolve(); this.cursor = [null, null, null]; this.holding = null; this.lastActivity = null; this.attention = new Map();
    this.onInput = event => {
      if (/^AG\d\d$/.test(event.key)) { void this.select(event).catch(error => this.emit('notice', error.message)); return; }
      this.onControl(this.decoder.feed(event));
    };
    this.onStick = event => this.onControl(this.decoder.feed(event));
    this.onRadial = event => { this.layerIndex = event.layerIndex; };
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
    this.transport.on('stick', this.onStick); this.transport.on('radial', this.onRadial);
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
      // When each task started waiting for you: for "next task needing you" and the Mixed app key.
      const waiting = new Set();
      for (const t of this.views.flatMap(v => v.slots)) {
        if (!t || !['approval', 'question', 'awaiting_input'].includes(this.taskState(t))) continue;
        const identity = pinIdentity(t); waiting.add(identity);
        if (!this.attention.has(identity)) { this.attention.set(identity, this.now()); this.noteActivity(t.provider); }
      }
      for (const identity of [...this.attention.keys()]) if (!waiting.has(identity)) this.attention.delete(identity);
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
      this.cursor[Math.floor(id / 6)] = id % 6;
      // In "opened" targeting, lower controls bind to the Claude task last opened by its key.
      this.bound = id >= 6 && current.provider === 'claude' ? {id, identity: pinIdentity(current), at: Date.now()} : null;
      this.noteActivity(current.provider);
      this.emit('selected', {layer: Math.floor(id / 6) + 1, slot: id % 6 + 1, provider: task.provider});
    } finally { this.selecting = false; }
  }

  // ---- Lower controls -------------------------------------------------------------------
  noteActivity(provider) { if (provider) this.lastActivity = {provider, at: this.now()}; }
  onControl(decoded) {
    if (!decoded || this.stopped) return;
    // One control at a time, in order; a release always follows its press.
    this.queue = this.queue.then(() => this.control(decoded)).catch(error => this.emit('notice', error.message));
  }
  async control(decoded) {
    if (this.stopped) return;
    if (decoded.phase === 'release') {
      const held = this.holding;
      if (held?.control === decoded.control) { this.holding = null; await this.perform(held.action, held.layer, decoded.control, 'off'); }
      return;
    }
    let layer = decoded.layer;
    if (layer === undefined) {
      // The Claude and Mixed layers share codes; the device says which layer is active.
      const status = await this.transport.rpc('device.status');
      layer = status?.layer_index;
      if (layer !== 1 && layer !== 2) return;
    }
    this.layerIndex = layer;
    const entry = effectiveMapping(this.settings(), this.codexLayout())[LAYERS[layer]][decoded.control];
    if (!entry || entry.action === 'none') return;
    const hold = decoded.control === 'mic' && ACTIONS[entry.action]?.claude?.hold;
    const result = await this.perform(entry.action, layer, decoded.control, hold ? 'on' : 'invoke');
    if (hold && result.performed) this.holding = {control: decoded.control, action: entry.action, layer};
  }
  async perform(action, layer, control, mode) {
    const spec = ACTIONS[action];
    let result;
    try {
      if (spec.bridge) result = await this.bridgeAction(action, layer);
      else {
        // Codex's layer acts on Codex; the Claude layer on Claude; Mixed on whichever app is in front.
        const providers = layer === 0 ? ['codex'] : layer === 1 ? ['claude'] : ['claude', 'codex'];
        result = {performed: false, reason: 'unsupported'};
        for (const provider of providers) {
          if (!supported(action, provider)) continue;
          result = provider === 'claude' ? await this.claudeAction(spec, layer, mode) : await this.codexAction(spec);
          if (result.performed) { this.noteActivity(provider); break; }
          if (!/^foreground-not-/.test(result.reason ?? '')) break;
        }
      }
    } catch (error) { result = {performed: false, reason: 'error', message: error.message}; }
    if (mode !== 'off') this.emit('action', {layer: layer + 1, control, action, performed: result.performed === true, reason: result.reason ?? null});
    return result;
  }
  // Claude: the named button in the front Claude window, only when that window shows an allowed task.
  async claudeAction(spec, layer, mode) {
    if (this.errors.claude || this.now() - this.lastInventory > 10000) return {performed: false, reason: 'claude-unavailable'};
    let tasks;
    if (this.settings().target === 'opened') {
      const bound = this.bound, task = bound && this.views[Math.floor(bound.id / 6)]?.slots[bound.id % 6];
      if (!task || pinIdentity(task) !== bound.identity || this.now() - bound.at > 15 * 60000) { this.bound = null; return {performed: false, reason: 'task-not-bound'}; }
      tasks = [task];
    } else tasks = this.views[layer]?.slots.filter(t => t?.provider === 'claude' && t.host === 'local') ?? [];
    const ids = [...new Set(tasks.flatMap(t => [t.navId, ...(Array.isArray(t.bridges) ? t.bridges : [])]).filter(id => typeof id === 'string'))];
    if (!ids.length) return {performed: false, reason: 'no-pinned-claude-task'};
    return this.runAction(spec.claude.labels, ids, mode === 'invoke' ? 'invoke' : mode);
  }
  // Codex: its own shortcut, only to a Codex window in front. Approve and Reject only while a
  // pinned Codex task is waiting for approval, so Enter can't send a half-written prompt.
  async codexAction(spec) {
    if (spec.guard === 'approval' && !this.views.some(v => v.slots.some(t => t?.provider === 'codex' && this.taskState(t) === 'approval')))
      return {performed: false, reason: 'no-codex-approval-waiting'};
    return this.sendShortcut(spec.codex);
  }
  layerTasks(layer) { return (this.views[layer]?.slots ?? []).map((t, i) => t && {task: t, slot: i}).filter(Boolean); }
  async openSlot(layer, slot) {
    const task = this.views[layer]?.slots[slot];
    if (!task || this.errors[task.provider]) return {performed: false, reason: 'no-task'};
    await this.openTask(task);
    this.cursor[layer] = slot; this.noteActivity(task.provider);
    if (task.provider === 'claude') this.bound = {id: layer * 6 + slot, identity: pinIdentity(task), at: this.now()};
    this.emit('selected', {layer: layer + 1, slot: slot + 1, provider: task.provider});
    return {performed: true};
  }
  async bridgeAction(action, layer) {
    if (action === 'openApp') {
      // Codex's layer opens Codex, Claude's opens Claude; Mixed opens the app that most recently
      // asked for you or was acted on.
      const provider = layer === 0 ? 'codex' : layer === 1 ? 'claude' : this.lastActivity?.provider ?? 'codex';
      return this.openApp(provider);
    }
    if (this.now() - this.lastInventory > 10000) return {performed: false, reason: 'tasks-unavailable'};
    if (action === 'nextAttention') {
      const waiting = [];
      for (const [l, view] of this.views.entries()) for (const [slot, t] of view.slots.entries()) {
        if (t && ['approval', 'question', 'awaiting_input'].includes(this.taskState(t))) waiting.push({l, slot, at: this.attention.get(pinIdentity(t)) ?? 0});
      }
      if (!waiting.length) return {performed: false, reason: 'nothing-waiting'};
      waiting.sort((a, b) => a.at - b.at);
      return this.openSlot(waiting[0].l, waiting[0].slot);
    }
    const tasks = this.layerTasks(layer);
    if (!tasks.length) return {performed: false, reason: 'no-pinned-task'};
    if (action === 'openTask') return this.openSlot(layer, this.cursor[layer] ?? tasks[0].slot);
    // Previous/next move through the layer's pinned tasks and open the one reached.
    const at = tasks.findIndex(t => t.slot === this.cursor[layer]);
    const step = action === 'nextTask' ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : tasks.length - 1) : (at + step + tasks.length) % tasks.length;
    return this.openSlot(layer, tasks[next].slot);
  }
  stop(error) {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true; clearInterval(this.timer); this.transport.removeListener('input', this.onInput);
    this.transport.removeListener('stick', this.onStick); this.transport.removeListener('radial', this.onRadial);
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
