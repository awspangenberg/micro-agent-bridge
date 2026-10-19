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

// Actions. `claude`: how it runs on Claude (labels of one named button, a toggle, or the bridge
// itself). `codex`: Codex's default shortcut, or false when Codex defines none.
export const ACTIONS = {
  none: {label: 'Nothing'},
  approve: {label: 'Approve', claude: {labels: ['Allow once', 'Allow', 'Approve once', 'Allow this time', 'Approve']}, codex: 'Enter', guard: 'approval'},
  reject: {label: 'Reject', claude: {labels: ['Deny', 'Reject']}, codex: 'Escape', guard: 'approval'},
  stop: {label: 'Stop the running turn', claude: {labels: ['Stop']}, codex: false},
  newTask: {label: 'New task', claude: {labels: ['New session']}, codex: 'Ctrl+N'},
  dictate: {label: 'Dictate while held', claude: {labels: ['Press and hold to record'], hold: true}, codex: false},
  back: {label: 'Back', claude: {labels: ['Back']}, codex: 'Ctrl+['},
  forward: {label: 'Forward', claude: {labels: ['Forward']}, codex: 'Ctrl+]'},
  sidebar: {label: 'Show or hide the sidebar', claude: {labels: ['Hide sidebar', 'Show sidebar']}, codex: 'Ctrl+B'},
  nextAttention: {label: 'Next task needing you', bridge: true},
  prevTask: {label: 'Previous pinned task', bridge: true},
  nextTask: {label: 'Next pinned task', bridge: true},
  openTask: {label: 'Open the selected task', bridge: true},
  openApp: {label: 'Open the app', bridge: true},
  planMode: {label: 'Toggle plan mode', claude: false, codex: false},
  fast: {label: 'Cycle speed', claude: false, codex: false},
  fork: {label: 'Fork the task', claude: false, codex: false},
};
export const supported = (action, provider) => {
  const spec = ACTIONS[action];
  if (!spec || action === 'none') return false;
  return spec.bridge ? true : Boolean(spec[provider]);
};

// The bridge's own defaults, used where a layer doesn't follow Codex or Codex's action has no
// equivalent: "stick moves, knob cycles".
export const DEFAULTS = {
  bolt: 'stop', check: 'approve', cross: 'reject', branch: 'newTask', mic: 'dictate', app: 'openApp',
  knobLeft: 'prevTask', knobRight: 'nextTask', knobPress: 'openTask', knobHold: 'nextAttention',
  up: 'prevTask', down: 'nextTask', left: 'back', right: 'forward',
};

// Codex's Micro settings (~/.codex/config.toml [desktop.codex-micro-layout]) in bridge terms.
const KEYCAPS = {FAST: 'fast', APPR: 'approve', REJ: 'reject', SPLIT: 'fork', MIC: 'dictate', MIC1: 'dictate', CODEX: 'openApp', EMPT: 'none', EMPT1: 'none'};
const COMMANDS = {'composer.togglePlanMode': 'planMode', navigateForward: 'forward', navigateBack: 'back', toggleSidebar: 'sidebar',
  nextThread: 'nextTask', previousThread: 'prevTask', nextRecentThread: 'nextTask', previousRecentThread: 'prevTask',
  nextThreadNeedingAttention: 'nextAttention', 'approval.approve': 'approve', 'approval.decline': 'reject',
  'composer.toggleFastMode': 'fast', forkThread: 'fork', newTask: 'newTask'};
const ENCODER_MODES = {
  'composer-navigation': {knobLeft: 'prevTask', knobRight: 'nextTask', knobPress: 'openTask'},
  'conversation-scroll': {knobLeft: 'prevTask', knobRight: 'nextTask'},
  reasoning: {knobLeft: 'none', knobRight: 'none'},
};
const fromCommand = entry => entry?.type === 'command' ? COMMANDS[entry.commandId] ?? 'none' : 'none';

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
    const pair = /^([A-Za-z0-9_.-]+|"[^"]*")\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const key = pair[1].replace(/^"|"$/g, ''), value = pair[2].trim();
    if (/^"(?:[^"\\]|\\.)*"$/.test(value)) table[key] = JSON.parse(value);
    else if (/^'[^']*'$/.test(value)) table[key] = value.slice(1, -1);
    else if (value === 'true' || value === 'false') table[key] = value === 'true';
    else if (/^-?\d+(?:\.\d+)?$/.test(value)) table[key] = Number(value);
  }
  return root;
}

export function codexMapping(layout) {
  const slots = layout?.slots ?? {}, map = {};
  const keycap = slot => KEYCAPS[slots[slot]?.keycapId];
  Object.assign(map, {bolt: keycap('ACT06'), check: keycap('ACT07'), cross: keycap('ACT08'), branch: keycap('ACT09'),
    mic: keycap('ACT10_ACT11') ?? keycap('ACT10'), app: keycap('ACT12')});
  const stick = layout?.analogStick;
  if (stick) for (const d of ['up', 'right', 'down', 'left']) if (stick[d] !== undefined) map[d] = fromCommand(stick[d]);
  const mode = layout?.encoderMode;
  if (mode === 'custom') {
    const e = layout?.encoder ?? {};
    Object.assign(map, {knobLeft: fromCommand(e.left), knobRight: fromCommand(e.right), knobPress: fromCommand(e.click), knobHold: fromCommand(e.longPress)});
  } else if (ENCODER_MODES[mode]) Object.assign(map, ENCODER_MODES[mode]);
  for (const k of Object.keys(map)) if (map[k] === undefined) delete map[k];
  return map;
}

export function readCodexLayout(home = os.homedir()) {
  try {
    const file = path.join(home, '.codex', 'config.toml');
    if (fs.statSync(file).size > 1024 * 1024) return null;
    return parseToml(fs.readFileSync(file, 'utf8'))?.desktop?.['codex-micro-layout'] ?? null;
  } catch { return null; }
}

export const DEFAULT_SETTINGS = Object.freeze({version: 1, target: 'foreground',
  layers: {codex: {followCodex: true, overrides: {}}, claude: {followCodex: true, overrides: {}}, mixed: {followCodex: true, overrides: {}}}});

export function normalizeSettings(value) {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (!value || typeof value !== 'object') return out;
  if (value.target === 'opened' || value.target === 'foreground') out.target = value.target;
  for (const layer of LAYERS) {
    const v = value.layers?.[layer];
    if (!v || typeof v !== 'object') continue;
    out.layers[layer].followCodex = v.followCodex !== false;
    for (const [control, action] of Object.entries(v.overrides ?? {})) if (CONTROLS.includes(control) && ACTIONS[action]) out.layers[layer].overrides[control] = action;
  }
  return out;
}
export const settingsPath = stateDirectory => path.join(stateDirectory, 'controls.json');
export function readSettings(stateDirectory) {
  try { return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath(stateDirectory), 'utf8'))); } catch { return normalizeSettings(null); }
}

/** The action for every control on every layer, with where it came from and whether it can run. */
export function effectiveMapping(settings, codexLayout) {
  const codex = codexMapping(codexLayout), out = {};
  for (const [index, layer] of LAYERS.entries()) {
    const providers = index === 0 ? ['codex'] : index === 1 ? ['claude'] : ['claude', 'codex'];
    const conf = settings.layers[layer]; out[layer] = {};
    for (const control of CONTROLS) {
      let action = DEFAULTS[control], source = 'default';
      if (conf.followCodex && codex[control] !== undefined) {
        // A Codex action Claude can't do falls back to the bridge default on the Claude layer.
        if (providers.some(p => supported(codex[control], p)) || codex[control] === 'none') { action = codex[control]; source = 'codex'; }
        else source = 'default-for-unsupported';
      }
      if (conf.overrides[control]) { action = conf.overrides[control]; source = 'override'; }
      out[layer][control] = {action, source, codexAction: codex[control] ?? null,
        runs: Object.fromEntries(providers.map(p => [p, supported(action, p)]))};
    }
  }
  return out;
}
