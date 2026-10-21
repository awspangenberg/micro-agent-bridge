// The Controls view: what the agent keys show and what each lower control does on the layer
// shown, where that comes from, and the person's overrides. Settings are saved to the bridge's
// controls.json; the host reads them on the next press.
import {call, parse} from './bridge.js';

const LAYERS = ['codex', 'claude', 'mixed'];
const GROUPS = [
  ['Keys', [['bolt', 'Bolt key'], ['check', 'Check key'], ['cross', 'Cross key'], ['branch', 'Branch key'], ['mic', 'Microphone (hold)'], ['app', 'Bottom-right key']]],
  ['Knob', [['knobLeft', 'Turn left'], ['knobRight', 'Turn right'], ['knobPress', 'Press'], ['knobHold', 'Press and hold']]],
  ['Joystick', [['up', 'Push up'], ['right', 'Push right'], ['down', 'Push down'], ['left', 'Push left']]],
];
const NAMES = Object.fromEntries(GROUPS.flatMap(([, rows]) => rows));
const KNOB_LABELS = {'composer-navigation': 'Move between tasks', reasoning: 'Thinking level (right raises it)', 'conversation-scroll': 'Scroll the conversation'};
const REASONS = {
  'foreground-not-claude': 'Claude was not in front', 'foreground-not-codex': 'Codex was not in front', 'task-not-bound': "the window in front isn't one of this layer's tasks",
  'no-claude-task-on-layer': 'no Claude task on this layer', 'no-codex-approval-waiting': 'no Codex approval was waiting', 'no-codex-shortcut': 'Codex has no shortcut for it',
  'claude-unavailable': "Claude's tasks couldn't be read", unsupported: "the app in front can't do this", 'layer-unknown': "the layer couldn't be read", unassigned: 'nothing assigned',
  'modifier-held': 'a modifier key was held', 'effort-at-limit': 'already at the limit', 'codex-waiting-for-you': 'a Codex task is waiting for you (Escape would decline it)', 'no-codex-task-working': 'no Codex task was working', 'no-task': 'no task on that key',
};
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const option = (value, text, selected) => { const o = el('option', '', text); o.value = value; o.selected = selected; return o; };

export class ControlsView {
  constructor(root, device) { this.root = root; this.device = device; this.layer = 0; this.data = null; }

  async load() {
    const result = await call('controls');
    this.data = parse(result);
    if (!this.data) { this.root.replaceChildren(el('div', 'callout bad', 'The controls could not be read: ' + (result.stderr || 'unknown error'))); return; }
    this.actions = new Map(this.data.actions.map(a => [a.id, a]));
    this.render();
  }
  show(layer) { this.layer = layer; if (this.data) this.render(); }

  async save(change) {
    const settings = structuredClone(this.data.settings);
    change(settings);
    await call('controlsSet', {settings});
    await this.load();
  }

  setting(title, detail, control) {
    const row = el('label', 'setting');
    const text = el('span'); text.append(el('b', '', title), el('span', 'detail', detail));
    row.append(text, control);
    return row;
  }
  select(choices, value, onChange) {
    const pick = el('select');
    for (const [v, text] of choices) pick.append(option(v, text, v === value));
    pick.addEventListener('change', () => onChange(pick.value));
    return pick;
  }

  render() {
    const {settings, mapping, codexSettingsFound, codexVersion, shortcuts, knobModes} = this.data;
    const layer = LAYERS[this.layer], conf = settings.layers[layer], map = mapping[layer];
    const providers = this.layer === 0 ? ['codex'] : this.layer === 1 ? ['claude'] : ['claude', 'codex'];
    const root = this.root; root.replaceChildren();

    const head = el('div', 'controls-head');
    head.append(this.setting('Agent keys', 'What the six task keys show on this layer.',
      this.select([['pinned', 'Pinned tasks'], ['recent', '6 most recent tasks']], conf.agentKeys, v => this.save(s => { s.layers[layer].agentKeys = v; }))));
    const box = el('input'); box.type = 'checkbox'; box.className = 'switch'; box.checked = conf.followCodex;
    box.addEventListener('change', () => this.save(s => { s.layers[layer].followCodex = box.checked; }));
    head.append(this.setting('Follow Codex settings', codexSettingsFound
      ? `Uses what Codex assigns to each control, where it can run here. Change them in Codex: Settings, Codex Micro.${codexVersion ? ` Codex ${codexVersion}.` : ''}`
      : 'Codex Micro settings were not found on this PC, so the bridge defaults apply.', box));
    head.append(this.setting('Knob', 'What turning the knob does on this layer.',
      this.select([['', conf.followCodex && codexSettingsFound ? "Codex's setting" : 'Bridge default'], ...knobModes.map(m => [m, KNOB_LABELS[m] ?? m])], conf.knobMode ?? '',
        v => this.save(s => { s.layers[layer].knobMode = v || null; }))));
    if (this.layer > 0)
      head.append(this.setting('Claude actions apply to', 'Which Claude task a key acts on.',
        this.select([['foreground', "this layer's task in front"], ['opened', 'the task last opened with its key']], settings.target, v => this.save(s => { s.target = v; }))));
    if (this.layer !== 1) {
      const add = el('input'); add.type = 'checkbox'; add.className = 'switch'; add.checked = shortcuts.enabled;
      add.addEventListener('change', () => this.save(s => { s.codexShortcuts = add.checked; }));
      const n = shortcuts.registered.length;
      head.append(this.setting('Let the bridge add Codex shortcuts',
        'Many Codex commands have no keyboard shortcut. With this on, the bridge adds unused ones (Ctrl/Alt/Shift with F13 to F24) to Codex\'s keybindings.json for the commands your controls use, and removes them when turned off. '
        + (n ? `${n} added. Restart Codex if a new one doesn't respond.` : 'Codex reads them when it starts.'), add));
    }
    root.append(head);

    for (const [title, rows] of GROUPS) {
      const group = el('section', 'control-group'); group.append(el('h2', '', title));
      for (const [control, name] of rows) {
        const entry = map[control], row = el('div', 'control-row'); row.dataset.control = control;
        const label = el('label', 'control-name', name); const id = `ctl-${control}`; label.htmlFor = id;
        const pick = this.actionSelect(entry.action, providers); pick.id = id;
        pick.addEventListener('change', () => this.save(s => { s.layers[layer].overrides[control] = pick.value; }));
        row.append(label, pick);
        if (entry.source === 'override') {
          const reset = el('button', 'btn quiet small', 'Reset');
          reset.addEventListener('click', () => this.save(s => { delete s.layers[layer].overrides[control]; }));
          row.append(reset);
        }
        row.append(el('div', 'control-note', this.explain(entry, providers, shortcuts.enabled)));
        const point = () => this.device.highlight(control), clear = () => this.device.highlight(null);
        row.addEventListener('mouseenter', point); row.addEventListener('mouseleave', clear);
        pick.addEventListener('focus', point); pick.addEventListener('blur', clear);
        group.append(row);
      }
      root.append(group);
    }
    root.append(this.pressLog());
  }

  // Every option Codex offers, grouped: the bridge's own, Codex's keycaps, text, every command.
  actionSelect(current, providers) {
    const pick = el('select'), seen = new Set();
    const add = (parent, id, text) => {
      const a = this.actions.get(id); if (!a) return;
      const runs = id === 'none' || providers.some(p => a[p]) || (providers.includes('codex') && a.registrable);
      const missing = providers.filter(p => id !== 'none' && !a[p] && !(p === 'codex' && a.registrable));
      const o = option(id, (text ?? a.label) + (!runs ? ' (not available here)' : missing.length ? ` (not in ${missing.map(cap).join(' or ')})` : ''), id === current);
      o.disabled = !runs && id !== current; parent.append(o); seen.add(id);
    };
    const groupOf = name => { const g = el('optgroup'); g.label = name; pick.append(g); return g; };
    const bridge = groupOf('Bridge');
    for (const a of this.data.actions) if (!a.id.includes(':')) add(bridge, a.id);
    const caps = groupOf('Codex keycaps');
    for (const k of this.data.keycaps) if (k.action !== 'none' && !seen.has(k.action) && this.actions.has(k.action)) add(caps, k.action, `${k.id}: ${this.actions.get(k.action).label}`);
    const other = groupOf('Write text or open a link');
    for (const a of this.data.actions) if (/^(text|url):/.test(a.id) && !seen.has(a.id)) add(other, a.id);
    const commands = groupOf('All Codex commands');
    for (const a of [...this.data.actions].filter(a => a.id.startsWith('cmd:') && !seen.has(a.id)).sort((x, y) => x.label.localeCompare(y.label))) add(commands, a.id);
    if (!seen.has(current)) pick.append(option(current, current, true));
    return pick;
  }

  explain(entry, providers, shortcutsOn) {
    const parts = [], a = this.actions.get(entry.action), name = id => this.actions.get(id)?.label ?? id;
    if (entry.source === 'codex') parts.push('From Codex.');
    else if (entry.source === 'default-for-unsupported') parts.push(`Codex assigns "${name(entry.codexAction)}", which can't run here, so the bridge default applies.`);
    else if (entry.source === 'override') parts.push('Your choice.');
    else if (entry.source === 'knob-mode') parts.push('From the knob setting.');
    else parts.push('Bridge default.');
    for (const p of providers) {
      if (entry.action === 'none') break;
      if (!entry.runs[p]) {
        if (p === 'codex' && a?.registrable) parts.push(shortcutsOn ? 'The bridge adds a Codex shortcut for this; restart Codex if it doesn\'t respond.' : 'Codex has no shortcut for this. Turn on "Let the bridge add Codex shortcuts" to use it in Codex.');
        else parts.push(providers.length > 1 ? `Does nothing when ${cap(p)} is in front.` : `${cap(p)} has no way to do this, so the control does nothing.`);
      } else if (p === 'codex' && entry.action.startsWith('cmd:approval.')) parts.push('In Codex, only while a Codex approval is waiting.');
    }
    if (entry.action.includes('ReasoningEffort') && providers.includes('claude')) parts.push("In Claude, changes Effort in the model menu.");
    if (entry.action === 'stop' && providers.includes('codex')) parts.push('In Codex, sends Escape, only while a Codex task is working and none is waiting for you.');
    if (entry.action === 'ptt') parts.push('Hold the key to dictate; release to stop.');
    return parts.join(' ');
  }

  // The last presses and what happened, newest first, so a key that seems dead explains itself.
  pressLog() {
    const section = el('section', 'control-group press-log'); section.append(el('h2', '', 'Recent presses'));
    const recent = [...(this.data.recent ?? [])].reverse().slice(0, 12);
    if (!recent.length) { section.append(el('p', 'control-note', 'Press a control on the Micro; it shows up here with what happened.')); return section; }
    const list = el('ol', 'presses');
    for (const r of recent) {
      const li = el('li', r.performed ? 'ok' : 'skipped');
      li.append(el('time', '', new Date(r.at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})),
        el('span', '', `Layer ${r.layer} · ${NAMES[r.control] ?? r.control}`), el('span', 'what', this.actions.get(r.action)?.label ?? r.action ?? '—'),
        el('span', 'result', r.performed ? 'Done' : `Skipped: ${REASONS[r.reason] ?? r.reason ?? 'unknown'}`));
      list.append(li);
    }
    section.append(list);
    return section;
  }

  // A press reported by the running host: add it to the log without reloading the view.
  pressed(entry) {
    if (!this.data) return;
    this.data.recent = [...(this.data.recent ?? []), {...entry, at: Date.now()}].slice(-40);
    this.root.querySelector('.press-log')?.replaceWith(this.pressLog());
  }

  // Clicking a control on the drawing jumps to its row.
  focus(name) {
    const control = name === 'knob' ? 'knobLeft' : name === 'stick' ? 'up' : name;
    const pick = this.root.querySelector(`#ctl-${control}`);
    pick?.scrollIntoView({block: 'center', behavior: 'smooth'}); pick?.focus({preventScroll: true});
  }
}

const cap = s => s[0].toUpperCase() + s.slice(1);
