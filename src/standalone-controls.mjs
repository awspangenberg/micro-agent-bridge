// Lower controls: action keys, microphone, last key, knob and joystick. Decodes device events into
// physical controls, resolves each to an action through the person's settings (by default
// following Codex's own Micro settings), and runs it against Claude (named buttons, bound to a
// pinned task) or Codex (its keyboard shortcuts, only while a Codex window is in front).
// See docs/micro-controls.md for the events each control sends.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONTROLS = ['bolt', 'check', 'cross', 'branch', 'mic', 'app', 'knobLeft', 'knobRight', 'knobPress', 'knobHold', 'up', 'right', 'down', 'left'];
export const LAYERS = ['codex', 'claude', 'mixed'];

// Codex's native layer sends its own codes; the Claude and Mixed layers share the bridge's codes.
const NATIVE = {ACT06: 'bolt', ACT07: 'check', ACT08: 'cross', ACT09: 'branch', ACT10: 'mic', ACT11: 'mic', ACT12: 'app', ENC_CC: 'knobLeft', ENC_CW: 'knobRight', ENC_CLK: 'knob'};
const SHARED = {ACT13: 'bolt', ACT14: 'check', ACT15: 'cross', ACT16: 'branch', ACT17: 'mic', ACT18: 'mic', ACT19: 'app',
  ACT00: 'knobLeft', ACT01: 'knobRight', ACT02: 'knob', ACT03: 'up', ACT04: 'left', ACT05: 'right', ACT20: 'down'};
export const HOLD_MS = 500;
// Joystick angle sectors, matching the radial sectors setup writes (docs/micro-controls.md).
export const stickDirection = a => a >= 0.875 || a < 0.125 ? 'left' : a < 0.375 ? 'right' : a < 0.625 ? 'down' : 'up';

/** Turns raw events into {control, phase, layer?}. `layer` is set for Codex's native codes; shared
 * codes need the current layer from the device. Phases: press, release (microphone only), tick. */
export class ControlDecoder {
  constructor({now = Date.now} = {}) { this.now = now; this.mic = new Set(); this.knobDown = null; this.stick = false; }
  feed(event) {
    if (event?.event === 'stick') {
      // Codex's native joystick streams angle and distance; act once per push.
      if (!this.stick && event.d >= 0.6) { this.stick = true; return {control: stickDirection(event.a), phase: 'press', layer: 0}; }
      if (this.stick && event.d <= 0.05) this.stick = false;
      return null;
    }
    if (typeof event?.key !== 'string') return null;
    const native = NATIVE[event.key], control = native ?? SHARED[event.key];
    if (!control) return null;
    const layer = native ? 0 : undefined;
    if (control === 'mic') {
      // Both switches under the wide key report together: one press, one release.
      if (event.act === 1) { const first = this.mic.size === 0; this.mic.add(event.key); return first ? {control, phase: 'press', layer} : null; }
      if (event.act === 0) { this.mic.delete(event.key); return this.mic.size === 0 ? {control, phase: 'release', layer} : null; }
      return null;
    }
    if (control === 'knobLeft' || control === 'knobRight') return event.act === 2 || event.act === 1 ? {control, phase: 'tick', layer} : null;
    if (control === 'knob') {
      if (event.act === 1) { this.knobDown = this.now(); return null; }
      if (event.act === 0 && this.knobDown !== null) {
        const held = this.now() - this.knobDown; this.knobDown = null;
        return {control: held >= HOLD_MS ? 'knobHold' : 'knobPress', phase: 'press', layer};
      }
      return null;
    }
    return event.act === 1 ? {control, phase: 'press', layer} : null;
  }
}


// ---- Actions ----------------------------------------------------------------------------
// An action is one of:
//   'none'
//   a bridge action: the bridge does it itself, for either app (BRIDGE below)
//   'cmd:<id>'   a Codex command (the full catalog Codex offers for the Micro)
//   'ptt'        push to talk while the key is held
//   'text:<t>'   write text in Codex's composer (Codex's :yolo: and :yeet: keycaps)
//   'url:<u>'    open a web page (Codex's OAI keycap)
//   'stop'       stop the running turn (Claude's Stop button; Escape in Codex)
export const BRIDGE = {
  prevTask: 'Previous task on this layer', nextTask: 'Next task on this layer', openTask: 'Open the selected task',
  nextAttention: 'Next task needing you', openApp: 'Open the app (Codex, Claude, or the one that last needed you)',
  scrollUp: 'Scroll the conversation up', scrollDown: 'Scroll the conversation down',
};

// How each Codex command runs in Claude, where Claude has an equivalent. Claude has no
// shortcut API, so these use named controls in its window through UI Automation:
//   labels: invoke the one visible, enabled button with one of these names
//   hold: toggle that button on while the key is held, off on release
//   menu: open the menu whose button name starts with `opener`, then act on an item
export const CLAUDE = {
  'approval.approve': {labels: ['Allow once', 'Allow', 'Approve once', 'Allow this time', 'Approve']},
  'approval.decline': {labels: ['Deny', 'Reject']},
  newTask: {labels: ['New session']}, newThread: {labels: ['New session']},
  navigateBack: {labels: ['Back']}, navigateForward: {labels: ['Forward']},
  toggleSidebar: {labels: ['Hide sidebar', 'Show sidebar']},
  'composer.submit': {labels: ['Send', 'Send message', 'Submit']},
  'composer.addFiles': {labels: ['Add']}, 'composer.addPhotos': {labels: ['Add']},
  feedback: {labels: ['Send feedback']},
  'composer.toggleFastMode': {menu: {opener: 'Model:', toggle: 'Enable fast mode'}},
  'composer.increaseReasoningEffort': {menu: {opener: 'Model:', submenu: 'Effort', step: 1}},
  'composer.decreaseReasoningEffort': {menu: {opener: 'Model:', submenu: 'Effort', step: -1}},
  'composer.togglePlanMode': {menu: {opener: ['Auto', 'Manual', 'Accept edits', 'Plan', 'Bypass permissions'], plan: 'Plan'}},
  stop: {labels: ['Stop']},
  ptt: {labels: ['Press and hold to record'], hold: true},
};

// The bridge's own defaults, where a layer doesn't follow Codex or Codex's choice can't run
// there: "stick moves, knob cycles".
export const DEFAULTS = {
  bolt: 'stop', check: 'cmd:approval.approve', cross: 'cmd:approval.decline', branch: 'cmd:newTask', mic: 'ptt', app: 'openApp',
  knobLeft: 'prevTask', knobRight: 'nextTask', knobPress: 'openTask', knobHold: 'nextAttention',
  up: 'prevTask', down: 'nextTask', left: 'cmd:navigateBack', right: 'cmd:navigateForward',
};
// Knob presets, matching Codex's encoder modes.
export const KNOB_MODES = {
  'composer-navigation': {knobLeft: 'prevTask', knobRight: 'nextTask', knobPress: 'openTask'},
  // Turning left raises the thinking level (tested on the Micro).
  reasoning: {knobLeft: 'cmd:composer.increaseReasoningEffort', knobRight: 'cmd:composer.decreaseReasoningEffort'},
  'conversation-scroll': {knobLeft: 'scrollUp', knobRight: 'scrollDown'},
};
// Earlier action names, from controls.json written by rc.6.
const LEGACY = {approve: 'cmd:approval.approve', reject: 'cmd:approval.decline', newTask: 'cmd:newTask', back: 'cmd:navigateBack',
  forward: 'cmd:navigateForward', sidebar: 'cmd:toggleSidebar', planMode: 'cmd:composer.togglePlanMode', fast: 'cmd:composer.toggleFastMode',
  fork: 'cmd:forkThread', dictate: 'ptt'};
export const migrate = action => LEGACY[action] ?? action;

export const validAction = action => typeof action === 'string' && (action === 'none' || action === 'ptt' || action === 'stop' || BRIDGE[action] !== undefined ||
  /^cmd:[A-Za-z0-9_.+-]{1,80}$/.test(action) || /^text:[^\r\n]{1,200}$/.test(action) || /^url:https:\/\/[^\s]{1,300}$/.test(action));

/** Whether an action can run for a provider. `codexKeys(command)` says whether Codex has (or the
 * bridge registered) a shortcut for a command. */
export function runs(action, provider, {codexKeys = () => false} = {}) {
  if (action === 'none') return false;
  // Scrolling needs Claude's transcript; Codex exposes no scroll control.
  if (BRIDGE[action] !== undefined) return !(provider === 'codex' && action.startsWith('scroll'));
  if (action.startsWith('url:')) return true;
  if (provider === 'claude') return Boolean(CLAUDE[action.startsWith('cmd:') ? action.slice(4) : action]);
  // Codex has no stop command; Escape in its composer interrupts the turn.
  if (action === 'stop') return true;
  if (action === 'ptt') return codexKeys('globalDictationHold');
  if (action.startsWith('text:')) return true;
  return action.startsWith('cmd:') && codexKeys(action.slice(4));
}

export function label(action, catalog) {
  if (action === 'none') return 'Nothing';
  if (BRIDGE[action]) return BRIDGE[action];
  if (action === 'ptt') return 'Push to talk (hold)';
  if (action === 'stop') return 'Stop the running turn';
  if (action.startsWith('text:')) return `Write ${action.slice(5)}`;
  if (action.startsWith('url:')) return `Open ${action.slice(4)}`;
  const id = action.slice(4);
  return catalog?.commands?.find(c => c.id === id)?.title ?? id;
}

// ---- Codex's own Micro settings ----------------------------------------------------------
// A minimal reader for the tables and scalar values Codex writes; anything else is ignored.
export function parseToml(text) {
  const root = {}; let table = root;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\[\]]+)\]$/.exec(line);
    if (header) {
      table = root;
      for (const part of header[1].match(/"[^"]*"|[^.]+/g)) { const k = part.replace(/^"|"$/g, '').trim(); table = table[k] ??= {}; }
      continue;
    }
    const pair = /^([A-Za-z0-9_.+-]+|"[^"]*")\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const key = pair[1].replace(/^"|"$/g, ''), value = pair[2].trim();
    if (/^"(?:[^"\\]|\\.)*"$/.test(value)) table[key] = JSON.parse(value);
    else if (/^'[^']*'$/.test(value)) table[key] = value.slice(1, -1);
    else if (value === 'true' || value === 'false') table[key] = value === 'true';
    else if (/^-?\d+(?:\.\d+)?$/.test(value)) table[key] = Number(value);
  }
  return root;
}

const entryAction = entry => entry?.type === 'command' && entry.commandId ? `cmd:${entry.commandId}`
  : entry?.type === 'composer-text' && entry.text ? `text:${entry.text}` : 'none';

/** Codex's settings as bridge actions, using its keycap catalog for what each keycap does. */
export function codexMapping(layout, catalog) {
  if (!layout) return {};
  const slots = layout.slots ?? {}, map = {};
  const keycapAction = slot => {
    const s = slots[slot]; if (!s) return undefined;
    // An explicit action or command on the slot wins over the keycap's printed meaning.
    if (s.action) return entryAction(s.action);
    if (s.commandId) return `cmd:${s.commandId}`;
    if (s.keycapId === 'MIC' || s.keycapId === 'MIC1') return 'ptt';
    // The CODEX keycap sends the message in Codex; on the Micro bridge it opens the app.
    if (s.keycapId === 'CODEX') return 'openApp';
    const k = catalog?.keycaps?.find(c => c.id === s.keycapId);
    if (!k) return undefined;
    if (k.type === 'command' && k.command) return `cmd:${k.command}`;
    if (k.type === 'composer-text' && k.text) return `text:${k.text}`;
    if (k.type === 'external-url') return 'url:https://developers.openai.com';
    return 'none';
  };
  Object.assign(map, {bolt: keycapAction('ACT06'), check: keycapAction('ACT07'), cross: keycapAction('ACT08'), branch: keycapAction('ACT09'),
    mic: layout.separateMicrophoneKeys ? keycapAction('ACT10') : keycapAction('ACT10_ACT11') ?? keycapAction('ACT10'), app: keycapAction('ACT12')});
  const stick = layout.analogStick;
  if (stick) for (const d of ['up', 'right', 'down', 'left']) if (stick[d] !== undefined) map[d] = entryAction(stick[d]);
  const mode = layout.encoderMode ?? 'composer-navigation';
  if (mode === 'custom') {
    const e = layout.encoder ?? {};
    Object.assign(map, {knobLeft: entryAction(e.left), knobRight: entryAction(e.right), knobPress: entryAction(e.click), knobHold: entryAction(e.longPress)});
  } else Object.assign(map, KNOB_MODES[mode] ?? {});
  for (const k of Object.keys(map)) if (map[k] === undefined) delete map[k];
  return map;
}

export function readCodexLayout(home = os.homedir()) {
  try {
    const file = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
    if (fs.statSync(file).size > 1024 * 1024) return null;
    return parseToml(fs.readFileSync(file, 'utf8'))?.desktop?.['codex-micro-layout'] ?? null;
  } catch { return null; }
}

// ---- The person's settings (controls.json) -----------------------------------------------
// agentKeys: what the six task keys show on that layer, as in Codex's own agent-key setting.
export const AGENT_KEY_MODES = ['pinned', 'recent'];
export const DEFAULT_SETTINGS = Object.freeze({version: 1, target: 'foreground', codexShortcuts: false,
  layers: Object.fromEntries(LAYERS.map(l => [l, {followCodex: true, agentKeys: 'pinned', knobMode: null, overrides: {}}]))});

export function normalizeSettings(value) {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (!value || typeof value !== 'object') return out;
  if (value.target === 'opened' || value.target === 'foreground') out.target = value.target;
  out.codexShortcuts = value.codexShortcuts === true;
  for (const layer of LAYERS) {
    const v = value.layers?.[layer];
    if (!v || typeof v !== 'object') continue;
    out.layers[layer].followCodex = v.followCodex !== false;
    if (AGENT_KEY_MODES.includes(v.agentKeys)) out.layers[layer].agentKeys = v.agentKeys;
    if (KNOB_MODES[v.knobMode]) out.layers[layer].knobMode = v.knobMode;
    for (const [control, raw] of Object.entries(v.overrides ?? {})) {
      const action = migrate(raw);
      if (CONTROLS.includes(control) && validAction(action)) out.layers[layer].overrides[control] = action;
    }
  }
  return out;
}
export const settingsPath = stateDirectory => path.join(stateDirectory, 'controls.json');
export function readSettings(stateDirectory) {
  try { return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath(stateDirectory), 'utf8'))); } catch { return normalizeSettings(null); }
}

export const providersFor = index => index === 0 ? ['codex'] : index === 1 ? ['claude'] : ['claude', 'codex'];

/** The action for every control on every layer, where it came from, and whether it can run.
 * Precedence: override, then the layer's knob preset, then Codex's settings (when followed and
 * runnable there), then the bridge default. */
export function effectiveMapping(settings, codexLayout, {catalog = null, codexKeys = () => false} = {}) {
  const codex = codexMapping(codexLayout, catalog), out = {};
  for (const [index, layer] of LAYERS.entries()) {
    const providers = providersFor(index), conf = settings.layers[layer]; out[layer] = {};
    const runnable = action => action === 'none' || providers.some(p => runs(action, p, {codexKeys}));
    for (const control of CONTROLS) {
      let action = DEFAULTS[control], source = 'default';
      const codexAction = codex[control];
      if (conf.followCodex && codexAction !== undefined) {
        // A Codex choice that can't run on this layer falls back to the bridge default.
        if (runnable(codexAction)) { action = codexAction; source = 'codex'; } else source = 'default-for-unsupported';
      }
      const preset = conf.knobMode && KNOB_MODES[conf.knobMode][control];
      if (preset) { action = preset; source = 'knob-mode'; }
      if (conf.overrides[control]) { action = conf.overrides[control]; source = 'override'; }
      out[layer][control] = {action, source, codexAction: codexAction ?? null,
        runs: Object.fromEntries(providers.map(p => [p, runs(action, p, {codexKeys})]))};
    }
  }
  return out;
}

/** Codex commands the current mapping uses, for shortcut registration. */
export function usedCodexCommands(mapping) {
  const used = new Set();
  for (const [index, layer] of LAYERS.entries()) {
    if (!providersFor(index).includes('codex')) continue;
    for (const entry of Object.values(mapping[layer])) {
      if (entry.action.startsWith('cmd:')) used.add(entry.action.slice(4));
      if (entry.action === 'ptt') used.add('globalDictationHold');
    }
  }
  return [...used];
}
