// The Controls view: what each lower control does on the layer shown, where that comes from, and
// the person's overrides. Settings are saved to the bridge's controls.json; the host reads them on
// the next press.
import {call, parse} from './bridge.js';

const LAYERS = ['codex', 'claude', 'mixed'];
const GROUPS = [
  ['Keys', [['bolt', 'Bolt key'], ['check', 'Check key'], ['cross', 'Cross key'], ['branch', 'Branch key'], ['mic', 'Microphone (hold)'], ['app', 'Bottom-right key']]],
  ['Knob', [['knobLeft', 'Turn left'], ['knobRight', 'Turn right'], ['knobPress', 'Press'], ['knobHold', 'Press and hold']]],
  ['Joystick', [['up', 'Push up'], ['right', 'Push right'], ['down', 'Push down'], ['left', 'Push left']]],
];
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

export class ControlsView {
  constructor(root, device) { this.root = root; this.device = device; this.layer = 0; this.data = null; }

  async load() {
    const result = await call('controls');
    this.data = parse(result);
    if (!this.data) { this.root.replaceChildren(el('div', 'callout bad', 'The controls could not be read: ' + (result.stderr || 'unknown error'))); return; }
    this.render();
  }
  show(layer) { this.layer = layer; if (this.data) this.render(); }

  async save(change) {
    const settings = structuredClone(this.data.settings);
    change(settings);
    await call('controlsSet', {settings});
    await this.load();
  }

  render() {
    const {settings, mapping, actions, codexSettingsFound} = this.data;
    const layer = LAYERS[this.layer], conf = settings.layers[layer], map = mapping[layer];
    const providers = this.layer === 0 ? ['codex'] : this.layer === 1 ? ['claude'] : ['claude', 'codex'];
    const root = this.root; root.replaceChildren();

    const head = el('div', 'controls-head');
    const follow = el('label', 'follow');
    const box = el('input'); box.type = 'checkbox'; box.className = 'switch'; box.checked = conf.followCodex;
    box.addEventListener('change', () => this.save(s => { s.layers[layer].followCodex = box.checked; }));
    const text = el('span'); text.append(el('b', '', 'Follow Codex settings'),
      el('span', 'detail', codexSettingsFound ? 'Uses what Codex assigns to each control, where it can run here. Change them in Codex: Settings, Codex Micro.'
        : 'Codex Micro settings were not found on this PC, so the bridge defaults apply.'));
    follow.append(text, box);
    head.append(follow);
    if (this.layer > 0) {
      const target = el('label', 'target');
      target.append(el('span', '', 'Claude actions apply to'));
      const pick = el('select');
      for (const [value, label] of [['foreground', 'the pinned task in front'], ['opened', 'the task last opened with its key']]) {
        const o = el('option', '', label); o.value = value; o.selected = settings.target === value; pick.append(o);
      }
      pick.addEventListener('change', () => this.save(s => { s.target = pick.value; }));
      target.append(pick);
      head.append(target);
    }
    root.append(head);

    for (const [title, rows] of GROUPS) {
      const group = el('section', 'control-group'); group.append(el('h2', '', title));
      for (const [control, name] of rows) {
        const entry = map[control], row = el('div', 'control-row'); row.dataset.control = control;
        const label = el('label', 'control-name', name); const id = `ctl-${control}`; label.htmlFor = id;
        const pick = el('select'); pick.id = id;
        for (const [action, spec] of Object.entries(actions)) {
          const runs = action === 'none' || providers.some(p => spec[p]);
          const missing = providers.filter(p => action !== 'none' && !spec[p]);
          const o = el('option', '', spec.label + (missing.length && runs ? ` (not in ${missing.map(cap).join(' or ')})` : !runs ? ' (not available here)' : ''));
          o.value = action; o.selected = action === entry.action; o.disabled = !runs && action !== entry.action;
          pick.append(o);
        }
        pick.addEventListener('change', () => this.save(s => { s.layers[layer].overrides[control] = pick.value; }));
        const note = el('div', 'control-note', explain(entry, actions, providers));
        row.append(label, pick);
        if (entry.source === 'override') {
          const reset = el('button', 'btn quiet small', 'Reset');
          reset.addEventListener('click', () => this.save(s => { delete s.layers[layer].overrides[control]; }));
          row.append(reset);
        }
        row.append(note);
        const point = () => this.device.highlight(control), clear = () => this.device.highlight(null);
        row.addEventListener('mouseenter', point); row.addEventListener('mouseleave', clear);
        pick.addEventListener('focus', point); pick.addEventListener('blur', clear);
        group.append(row);
      }
      root.append(group);
    }
  }

  // Clicking a control on the drawing jumps to its row.
  focus(name) {
    const control = name === 'knob' ? 'knobLeft' : name === 'stick' ? 'up' : name;
    const pick = this.root.querySelector(`#ctl-${control}`);
    pick?.scrollIntoView({block: 'center', behavior: 'smooth'}); pick?.focus({preventScroll: true});
  }
}

const cap = s => s[0].toUpperCase() + s.slice(1);
function explain(entry, actions, providers) {
  const parts = [];
  const name = a => actions[a]?.label ?? a;
  if (entry.source === 'codex') parts.push('From Codex.');
  else if (entry.source === 'default-for-unsupported') parts.push(`Codex assigns "${name(entry.codexAction)}", which can't run here, so the bridge default applies.`);
  else if (entry.source === 'override') parts.push('Your choice.');
  else parts.push('Bridge default.');
  for (const p of providers) {
    if (entry.action === 'none') break;
    if (!entry.runs[p]) parts.push(providers.length > 1 ? `Does nothing when ${cap(p)} is in front.` : `${cap(p)} has no way to do this, so the control does nothing.`);
    else if (p === 'codex' && actions[entry.action]?.guarded) parts.push('In Codex, only while a Codex approval is waiting.');
  }
  if (entry.action === 'dictate') parts.push('Hold the key to dictate; release to stop.');
  return parts.join(' ');
}
