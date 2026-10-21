// The Lights view: the colour, brightness and animation of each task state on the keys and of
// each situation the background ring shows. Only what a person changes is saved (controls.json,
// "lights"); the running host repaints within one poll.
import {call, parse} from './bridge.js';

const KEYS = [['approval', 'Needs approval'], ['question', 'Asking a question'], ['planning', 'Planning'], ['testing', 'Running tests'],
  ['command', 'Running a command'], ['editing', 'Editing files'], ['working', 'Working (other)'], ['completed', 'Completed'],
  ['error', 'Error'], ['disconnected', 'Disconnected'], ['inactive', 'Idle']];
const RING = [['approval', 'A task needs approval'], ['question', 'A task asks a question'], ['error', 'A task has an error'],
  ['working', 'Tasks working in one app'], ['both', 'Both apps working'], ['idle', 'Nothing happening']];
const KEY_EFFECTS = [[1, 'Solid'], [6, 'Breathe'], [4, 'Pulse'], [0, 'Off']];
const RING_EFFECTS = [[1, 'Solid'], [6, 'Breathe'], [4, 'Pulse'], [2, 'Sweep'], [0, 'Off']];
// null colour means the app's colour for these.
const APP_COLOURED = {keys: ['working', 'inactive'], ring: ['working']};
const MAX = .65;

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
export const hex = c => '#' + c.toString(16).padStart(6, '0');

export class LightsView {
  constructor(root, onChange) { this.root = root; this.onChange = onChange; this.data = null; }

  async load() {
    const result = await call('controls');
    this.data = parse(result);
    if (!this.data) { this.root.replaceChildren(el('div', 'callout bad', 'The lights could not be read: ' + (result.stderr || 'unknown error'))); return; }
    this.onChange?.(this.data.settings.lights);
    this.render();
  }

  async save(change) {
    const settings = structuredClone(this.data.settings);
    settings.lights ??= {providers: {}, keys: {}, ring: {}};
    change(settings.lights);
    await call('controlsSet', {settings});
    await this.load();
  }

  render() {
    const {lights: {effective, defaults}, settings} = this.data, over = settings.lights;
    const root = this.root; root.replaceChildren();
    const head = el('div', 'lights-head');
    head.append(el('p', 'control-note', 'Changes show on the Micro within a couple of seconds. Brightness is limited by the device.'));
    if (Object.keys(over.providers).length + Object.keys(over.keys).length + Object.keys(over.ring).length) {
      const reset = el('button', 'btn quiet small', 'Reset all lights');
      reset.addEventListener('click', () => this.save(l => { l.providers = {}; l.keys = {}; l.ring = {}; }));
      head.append(reset);
    }
    root.append(head);

    const apps = el('section', 'control-group'); apps.append(el('h2', '', 'App colours'));
    apps.append(el('p', 'control-note', 'Used for working and idle tasks, and for the ring while one app works.'));
    for (const [p, name] of [['codex', 'Codex'], ['claude', 'Claude']]) {
      const row = el('div', 'light-row app');
      const pick = this.colour(hex(effective.providers[p]), v => this.save(l => { l.providers[p] = v; }));
      row.append(swatch({c: effective.providers[p], b: .55, e: 1, s: 0}), el('span', 'light-name', name), pick);
      if (over.providers[p]) row.append(this.reset(() => this.save(l => { delete l.providers[p]; })));
      apps.append(row);
    }
    root.append(apps);

    root.append(this.group('Task keys', 'What each key shows for the state of its task.', KEYS, 'keys', KEY_EFFECTS, effective, defaults, over));
    root.append(this.group('Background ring', 'The ring shows the most urgent situation across all tasks, in this order.', RING, 'ring', RING_EFFECTS, effective, defaults, over));
  }

  group(title, note, rows, part, effects, effective, defaults, over) {
    const section = el('section', 'control-group'); section.append(el('h2', '', title), el('p', 'control-note', note));
    for (const [state, name] of rows) {
      const st = effective[part][state], appColoured = APP_COLOURED[part].includes(state);
      // With the app's colour, the preview shows Codex's.
      const shown = st.c ?? effective.providers.codex;
      const set = change => this.save(l => { l[part][state] = {...(l[part][state] ?? {}), ...change}; });
      const row = el('div', 'light-row'); row.dataset.state = state;
      const top = el('div', 'light-top');
      top.append(swatch(st.c == null ? {...st, c: shown} : st, appColoured && st.c == null), el('span', 'light-name', name));
      const pick = this.colour(hex(shown), v => set({c: v}));
      pick.disabled = st.e === 0 || (appColoured && st.c == null);
      top.append(pick);
      if (appColoured) {
        const lab = el('label', 'app-colour'), box = el('input'); box.type = 'checkbox'; box.checked = st.c == null;
        box.addEventListener('change', () => set({c: box.checked ? null : hex(shown)}));
        lab.append(box, el('span', '', "App's colour")); top.append(lab);
      }
      const effect = el('select'); effect.setAttribute('aria-label', `${name} animation`);
      for (const [e, label] of effects) { const o = el('option', '', label); o.value = String(e); o.selected = e === st.e; effect.append(o); }
      effect.addEventListener('change', () => {
        const e = Number(effect.value);
        // Turning a light on from Off needs a visible brightness and colour.
        set(e && !st.b ? {e, b: defaults[part][state].b || .45, s: defaults[part][state].s || .3, ...(st.c === 0 ? {c: '#ffffff'} : {})} : {e});
      });
      top.append(effect);
      if (over[part][state]) top.append(this.reset(() => this.save(l => { delete l[part][state]; })));
      row.append(top);
      if (st.e !== 0) {
        const sliders = el('div', 'light-sliders');
        sliders.append(this.slider('Brightness', Math.round(st.b / MAX * 100), v => set({b: Math.round(v / 100 * MAX * 1000) / 1000})));
        if (st.e !== 1) sliders.append(this.slider('Speed', Math.round(st.s * 100), v => set({s: v / 100})));
        row.append(sliders);
      }
      section.append(row);
    }
    return section;
  }

  colour(value, onChange) {
    const pick = el('input'); pick.type = 'color'; pick.value = value; pick.className = 'colour';
    pick.addEventListener('change', () => onChange(pick.value));
    return pick;
  }
  slider(label, value, onChange) {
    const wrap = el('label', 'slider'), input = el('input'), out = el('output', '', `${value}%`);
    input.type = 'range'; input.min = '0'; input.max = '100'; input.value = String(value);
    input.addEventListener('input', () => { out.textContent = `${input.value}%`; });
    input.addEventListener('change', () => onChange(Number(input.value)));
    wrap.append(el('span', '', label), input, out);
    return wrap;
  }
  reset(onClick) { const b = el('button', 'btn quiet small', 'Reset'); b.addEventListener('click', onClick); return b; }
}

// A small preview of a light: colour, brightness and animation (speed sets its pace).
function swatch(st, app) {
  const s = el('span', 'swatch' + (app ? ' app' : ''));
  if (st.e === 0) { s.classList.add('off'); return s; }
  s.style.setProperty('--c', hex(st.c)); s.style.setProperty('--level', String(.25 + .75 * st.b / MAX));
  if (st.e !== 1) { s.classList.add(st.e === 2 ? 'sweep' : 'pulse'); s.style.setProperty('--period', `${(st.e === 4 ? 1.6 : 4) - (st.e === 4 ? 1.3 : 3) * st.s}s`); }
  return s;
}
