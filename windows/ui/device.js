// The Codex Micro seen from above: a square board in a frosted rim (the ambient light ring), on a
// 4 x 4 grid. Row 1: knob, two task keys, joystick. Row 2: four task keys. Row 3: four action keys.
// Row 4: round button with status LEDs, a double-width microphone key, and one key.
// It is the progress indicator for setup and the live view on the dashboard.
const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, parent) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
};

const octagon = (cx, cy, r) => {
  const a = r * .414;
  return `M${cx - a} ${cy - r}H${cx + a}L${cx + r} ${cy - a}V${cy + a}L${cx + a} ${cy + r}H${cx - a}L${cx - r} ${cy + a}V${cy - a}Z`;
};

// Line symbols printed on the action keys, drawn around (cx, cy).
const GLYPHS = {
  bolt: 'M3 -13 L-7 2 H1 L-3 13 L8 -3 H0 Z',
  check: 'M-6 0 L-2 5 L6 -5 M12 0 A12 12 0 1 1 -12 0 A12 12 0 1 1 12 0',
  cross: 'M-5 -5 L5 5 M5 -5 L-5 5 M12 0 A12 12 0 1 1 -12 0 A12 12 0 1 1 12 0',
  fork: 'M-13 -2 H-5 L6 -12 M0 -12 H6 V-6 M-1 -1 L9 9 M9 3 V9 H3',
  mic: 'M-5 -13 A5 5 0 0 1 5 -13 V-1 A5 5 0 0 1 -5 -1 Z M-10 -3 A10 10 0 0 0 10 -3 M0 7 V13 M-5 13 H5',
};
function glyph(svg, name, cx, cy) {
  el('path', {d: GLYPHS[name], transform: `translate(${cx} ${cy})`, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: .8}, svg);
}

export const COLORS ={codex: '#2f6bff', claude: '#ff9a1f', ok: '#2fd15a', white: '#f4f6f8', bad: '#f23b3b'};

export class Device {
  constructor(host) {
    const svg = this.svg = el('svg', {viewBox: '0 0 520 540', class: 'device', role: 'img', 'aria-label': 'Codex Micro'});
    const defs = el('defs', {}, svg);
    const grad = (id, stops, x2 = 0, y2 = 1) => {
      const g = el('linearGradient', {id, x1: 0, y1: 0, x2, y2}, defs);
      stops.forEach(([o, c]) => el('stop', {offset: o, 'stop-color': c}, g));
    };
    grad('mab-body', [[0, 'var(--body-top)'], [1, 'var(--body-bottom)']]);
    grad('mab-cap', [[0, 'var(--cap-top)'], [1, 'var(--cap-bottom)']]);
    const blur = (id, d) => { const f = el('filter', {id, x: '-50%', y: '-50%', width: '200%', height: '200%'}, defs); el('feGaussianBlur', {stdDeviation: d}, f); };
    blur('mab-glow', 9); blur('mab-soft', 18); blur('mab-shadow', 16);

    el('ellipse', {cx: 260, cy: 500, rx: 210, ry: 20, fill: 'rgba(0,0,0,.26)', filter: 'url(#mab-shadow)'}, svg);
    // Frosted rim: it is the ambient light ring, so the ring colour tints the whole rim.
    const rim = {x: 30, y: 30, width: 460, height: 460, rx: 70};
    this.halo = el('rect', {...rim, fill: 'none', 'stroke-width': 22, stroke: 'transparent', filter: 'url(#mab-soft)', class: 'ring-glow', opacity: 0, pathLength: 1400}, svg);
    el('rect', {...rim, fill: 'var(--rim)'}, svg);
    this.rimTint = el('rect', {...rim, fill: 'transparent', class: 'ring-glow', opacity: 0}, svg);
    this.strip = el('rect', {...rim, x: 33, y: 33, width: 454, height: 454, rx: 67, fill: 'none', 'stroke-width': 6, stroke: 'transparent', class: 'ring-glow', pathLength: 1400}, svg);
    this.comet = el('rect', {...rim, x: 33, y: 33, width: 454, height: 454, rx: 67, fill: 'none', 'stroke-width': 7, stroke: 'transparent', 'stroke-linecap': 'round', 'stroke-dasharray': '170 1230', class: 'comet', opacity: 0, pathLength: 1400}, svg);
    el('rect', {x: 72, y: 72, width: 376, height: 376, rx: 12, fill: 'var(--plate)'}, svg);
    for (const [cx, cy] of [[90, 90], [430, 90], [90, 430], [430, 430]]) el('circle', {cx, cy, r: 6, fill: 'var(--screw)'}, svg);

    // 4 x 4 grid of 80 px cells with 8 px gaps, starting at (86, 86).
    const cell = (col, row) => ({x: 86 + col * 88, y: 86 + row * 88});
    const cap = (x, y, width = 80, height = 80, parent = svg) => el('rect', {x, y, width, height, rx: 14, fill: 'url(#mab-cap)'}, parent);

    // Task keys are translucent and lit from inside. Slot order follows the profile rows:
    // top row left to right, then the second row.
    this.keys = [];
    for (const [col, row] of [[1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [3, 1]]) {
      const {x, y} = cell(col, row);
      const g = el('g', {class: 'key'}, svg);
      const light = el('rect', {x: x - 6, y: y - 6, width: 92, height: 92, rx: 20, fill: 'transparent', filter: 'url(#mab-glow)', class: 'key-light', opacity: 0}, g);
      cap(x, y, 80, 80, g);
      const tint = el('rect', {x, y, width: 80, height: 80, rx: 14, fill: 'transparent', class: 'key-light', opacity: 0}, g);
      el('circle', {cx: x + 40, cy: y + 42, r: 9, fill: 'var(--nub)'}, g);
      this.keys.push({g, light, tint, x, y, width: 80, height: 80});
    }

    // Lower controls are not lit by the bridge; each is a group the dashboard can point at.
    this.controls = {};
    const control = (name, shape) => { const g = el('g', {class: 'control', 'data-control': name}, svg); shape(g); this.controls[name] = g; return g; };
    const knob = cell(0, 0);
    control('knob', g => {
      el('circle', {cx: knob.x + 40, cy: knob.y + 40, r: 37, fill: 'url(#mab-cap)', class: 'face'}, g);
      el('path', {d: `M${knob.x + 22} ${knob.y + 12} Q${knob.x + 44} ${knob.y + 40} ${knob.x + 30} ${knob.y + 74}`, fill: 'none', stroke: 'var(--faint)', 'stroke-width': 2, opacity: .7}, g);
    });
    const stick = cell(3, 0);
    control('stick', g => {
      el('path', {d: octagon(stick.x + 40, stick.y + 40, 36), fill: 'var(--well)', stroke: 'var(--faint)', 'stroke-width': 1.5, class: 'face'}, g);
      el('circle', {cx: stick.x + 40, cy: stick.y + 40, r: 25, fill: 'var(--stick)'}, g);
    });

    // Action keys and the bottom row carry their printed symbols.
    [['bolt', 'bolt'], ['check', 'check'], ['cross', 'cross'], ['branch', 'fork']].forEach(([name, icon], col) => {
      const {x, y} = cell(col, 2);
      control(name, g => { cap(x, y, 80, 80, g).classList.add('face'); glyph(g, icon, x + 40, y + 40); });
    });
    // The touch layer button, with one LED per layer.
    const button = cell(0, 3);
    el('circle', {cx: button.x + 46, cy: button.y + 40, r: 17, fill: 'var(--stick)'}, svg);
    this.leds = [0, 1, 2].map(i => el('rect', {x: button.x - 6, y: button.y + 22 + i * 14, width: 9, height: 5, rx: 1.5, fill: 'var(--led)', opacity: .35}, svg));
    const mic = cell(1, 3);
    control('mic', g => { cap(mic.x, mic.y, 168, 80, g).classList.add('face'); glyph(g, 'mic', mic.x + 84, mic.y + 40); });
    const last = cell(3, 3);
    control('app', g => { cap(last.x, last.y, 80, 80, g).classList.add('face'); });
    host.replaceChildren(svg);
  }

  // Which layer the LEDs show (0-2), or null for none.
  layer(index) { this.leds.forEach((led, i) => led.setAttribute('opacity', i === index ? 1 : .35)); }

  // Point at a lower control (knob*, up/down/left/right map to the knob and joystick).
  highlight(name) {
    const target = /^knob/.test(name ?? '') ? 'knob' : ['up', 'down', 'left', 'right'].includes(name) ? 'stick' : name;
    for (const [key, g] of Object.entries(this.controls)) g.classList.toggle('highlight', key === target);
  }
  flashControl(name) {
    this.highlight(name);
    clearTimeout(this.flashTimer); this.flashTimer = setTimeout(() => this.highlight(null), 900);
  }

  // mode: off | steady | search | success | error
  ring(mode, color = COLORS.white) {
    const on = mode !== 'off';
    this.comet.setAttribute('opacity', mode === 'search' ? 1 : 0);
    this.comet.setAttribute('stroke', color);
    this.strip.setAttribute('stroke', on && mode !== 'search' ? color : 'transparent');
    this.halo.setAttribute('stroke', on ? color : 'transparent');
    this.halo.setAttribute('opacity', mode === 'search' ? .25 : on ? .55 : 0);
    this.rimTint.setAttribute('fill', on ? color : 'transparent');
    this.rimTint.setAttribute('opacity', mode === 'search' ? .08 : on ? .28 : 0);
    this.strip.classList.toggle('breathe', mode === 'error');
    if (mode === 'success') {
      this.halo.animate([{opacity: 1}, {opacity: .55}], {duration: 900, easing: 'ease-out'});
    }
  }

  // light: {color, level 0..1, motion: 'solid' | 'breathe' | 'flash'} or null for off
  key(i, light) {
    const k = this.keys[i]; if (!k) return;
    for (const part of [k.light, k.tint]) {
      part.classList.remove('breathe', 'flash');
      if (!light) { part.setAttribute('opacity', 0); continue; }
      part.setAttribute('fill', light.color);
      part.setAttribute('opacity', (part === k.tint ? .42 : .9) * (light.level ?? 1));
      if (light.motion && light.motion !== 'solid') part.classList.add(light.motion);
    }
  }
  keysAll(lights) { lights.forEach((l, i) => this.key(i, l)); }
  clear() { this.keysAll([null, null, null, null, null, null]); }

  press(i, color = COLORS.ok) {
    const k = this.keys[i]; if (!k) return;
    k.g.classList.add('pressed'); setTimeout(() => k.g.classList.remove('pressed'), 140);
    const r = el('rect', {x: k.x, y: k.y, width: k.width, height: k.height, rx: 14, fill: 'none', stroke: color, 'stroke-width': 3, class: 'ripple'}, this.svg);
    setTimeout(() => r.remove(), 800);
  }

  // Light keys one after another, for "mapped" and "ready" moments.
  async sweep(lights, gap = 90) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (let i = 0; i < 6; i++) { this.key(i, lights[i]); if (!reduce) await new Promise(r => setTimeout(r, gap)); }
  }
}

// Bridge task states, as the keys show them (see docs/windows.md).
export const STATES = {
  approval: {label: 'Needs approval', color: '#ff4a1c', motion: 'flash'},
  awaiting_input: {label: 'Needs approval', color: '#ff4a1c', motion: 'flash'},
  question: {label: 'Has a question', color: '#e040fb', motion: 'flash'},
  planning: {label: 'Planning', color: '#8b5cf6', motion: 'breathe'},
  testing: {label: 'Running tests', color: '#f5c518', motion: 'breathe'},
  command: {label: 'Running a command', color: '#22c7f0', motion: 'breathe'},
  editing: {label: 'Editing files', color: '#19d3a0', motion: 'breathe'},
  working: {label: 'Working', color: null, motion: 'breathe'},
  completed: {label: 'Done', color: '#2fd15a', motion: 'solid'},
  error: {label: 'Error', color: '#f23b3b', motion: 'solid'},
  disconnected: {label: 'Disconnected', color: '#f23b3b', motion: 'breathe'},
  inactive: {label: 'Idle', color: null, motion: 'solid', level: .32},
};
export function lightFor(slot) {
  if (!slot) return null;
  const s = STATES[slot.state] ?? STATES.inactive;
  return {color: s.color ?? COLORS[slot.provider] ?? '#8b959e', level: s.level ?? 1, motion: s.motion, label: s.label};
}
