// A stylised Codex Micro: six task keys, lower controls, a dial and the ambient light ring.
// It is the progress indicator for setup and the live view on the dashboard.
const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, parent) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
};

export const COLORS = {codex: '#2f6bff', claude: '#ff9a1f', ok: '#2fd15a', white: '#f4f6f8', bad: '#f23b3b'};

export class Device {
  constructor(host) {
    const svg = this.svg = el('svg', {viewBox: '0 0 520 400', class: 'device', role: 'img', 'aria-label': 'Codex Micro'});
    const defs = el('defs', {}, svg);
    const grad = (id, stops, x2 = 0, y2 = 1) => {
      const g = el('linearGradient', {id, x1: 0, y1: 0, x2, y2}, defs);
      stops.forEach(([o, c]) => el('stop', {offset: o, 'stop-color': c}, g));
    };
    grad('mab-body', [[0, 'var(--body-top)'], [1, 'var(--body-bottom)']]);
    grad('mab-cap', [[0, 'var(--cap-top)'], [1, 'var(--cap-bottom)']]);
    const blur = (id, d) => { const f = el('filter', {id, x: '-50%', y: '-50%', width: '200%', height: '200%'}, defs); el('feGaussianBlur', {stdDeviation: d}, f); };
    blur('mab-glow', 9); blur('mab-soft', 18); blur('mab-shadow', 16);

    el('ellipse', {cx: 260, cy: 352, rx: 214, ry: 22, fill: 'rgba(0,0,0,.28)', filter: 'url(#mab-shadow)'}, svg);
    // Ambient ring: a diffuse halo plus a crisp light strip around the body.
    const ringBox = {x: 36, y: 56, width: 448, height: 288, rx: 52, fill: 'none', pathLength: 1400};
    this.halo = el('rect', {...ringBox, 'stroke-width': 18, stroke: 'transparent', filter: 'url(#mab-soft)', class: 'ring-glow', opacity: 0}, svg);
    this.strip = el('rect', {...ringBox, 'stroke-width': 4, stroke: 'transparent', class: 'ring-glow'}, svg);
    this.comet = el('rect', {...ringBox, 'stroke-width': 5, stroke: 'transparent', 'stroke-linecap': 'round', 'stroke-dasharray': '170 1230', class: 'comet', opacity: 0}, svg);
    el('rect', {x: 40, y: 60, width: 440, height: 280, rx: 48, fill: 'url(#mab-body)'}, svg);
    el('rect', {x: 54, y: 74, width: 412, height: 252, rx: 36, fill: 'var(--plate)', opacity: .55}, svg);

    this.keys = [];
    for (let i = 0; i < 6; i++) {
      const x = 84 + (i % 3) * 94, y = 98 + Math.floor(i / 3) * 94;
      const g = el('g', {class: 'key'}, svg);
      const light = el('rect', {x: x - 6, y: y - 6, width: 88, height: 88, rx: 22, fill: 'transparent', filter: 'url(#mab-glow)', class: 'key-light', opacity: 0}, g);
      el('rect', {x, y, width: 76, height: 76, rx: 17, fill: 'url(#mab-cap)'}, g);
      const tint = el('rect', {x, y, width: 76, height: 76, rx: 17, fill: 'transparent', class: 'key-light', opacity: 0}, g);
      el('rect', {x: x + 8, y: y + 6, width: 60, height: 10, rx: 5, fill: '#fff', opacity: .28}, g);
      this.keys.push({g, light, tint, x, y});
    }
    // Lower controls and the dial are not lit by the bridge.
    for (let i = 0; i < 5; i++) el('rect', {x: 84 + i * 56, y: 292, width: 46, height: 22, rx: 8, fill: 'url(#mab-cap)', opacity: .85}, svg);
    el('circle', {cx: 412, cy: 150, r: 40, fill: 'url(#mab-cap)'}, svg);
    el('circle', {cx: 412, cy: 150, r: 34, fill: 'none', stroke: 'var(--faint)', 'stroke-width': 3, 'stroke-dasharray': '2 4', opacity: .6}, svg);
    el('circle', {cx: 412, cy: 236, r: 18, fill: 'url(#mab-cap)'}, svg);
    host.replaceChildren(svg);
  }

  // mode: off | steady | search | success | error
  ring(mode, color = COLORS.white) {
    const on = mode !== 'off';
    this.comet.setAttribute('opacity', mode === 'search' ? 1 : 0);
    this.comet.setAttribute('stroke', color);
    this.strip.setAttribute('stroke', on && mode !== 'search' ? color : 'transparent');
    this.halo.setAttribute('stroke', on ? color : 'transparent');
    this.halo.setAttribute('opacity', mode === 'search' ? .25 : on ? .55 : 0);
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
    const r = el('rect', {x: k.x, y: k.y, width: 76, height: 76, rx: 17, fill: 'none', stroke: color, 'stroke-width': 3, class: 'ripple'}, this.svg);
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
