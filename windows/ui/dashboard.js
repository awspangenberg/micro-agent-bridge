import {call, on, parse, failure} from './bridge.js';
import {Device, COLORS, lightFor} from './device.js';
import {ControlsView} from './controls.js';

const $ = s => document.querySelector(s);
const device = new Device($('#device'));
const controls = new ControlsView($('#controls'), device);
let view = 'tasks';
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => {
  view = b.dataset.view;
  for (const o of document.querySelectorAll('[data-view]')) { o.setAttribute('aria-pressed', String(o === b)); o.setAttribute('aria-selected', String(o === b)); }
  $('#board').hidden = view !== 'tasks'; $('#controls').hidden = view !== 'controls';
  device.svg.classList.toggle('interactive', view === 'controls');
  if (view === 'controls') { controls.show(shown); void controls.load(); } else device.highlight(null);
});
// In the Controls view, clicking a control on the drawing jumps to its setting.
device.svg.addEventListener('click', e => {
  const target = e.target.closest?.('[data-control]');
  if (view === 'controls' && target) controls.focus(target.dataset.control);
});
const NAMES = ['Codex', 'Claude', 'Mixed'];
const BARS = ['var(--codex)', 'var(--claude)', 'linear-gradient(90deg, var(--codex) 0 50%, var(--claude) 50% 100%)'];
let status = 'stopped', snapshot = null, shown = 0, physical = null, restoring = false, profileUpdate = false;
const welcome = new URLSearchParams(location.search).has('welcome');

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }

function render() {
  const board = $('#board'); board.replaceChildren();
  const layers = snapshot?.layers ?? [];
  NAMES.forEach((name, li) => {
    const layer = layers[li], group = el('section', 'group' + (li === (physical ?? shown) ? ' current' : ''));
    const h = el('h2'); const bar = el('span', 'bar'); bar.style.background = BARS[li];
    h.append(bar, document.createTextNode(name), el('span', 'count', `Layer ${li + 1}`));
    if (layer?.waiting) h.append(el('span', 'count', `and ${layer.waiting} more pinned`));
    group.append(h);
    const list = el('ol');
    for (let i = 0; i < 6; i++) {
      const slot = layer?.slots?.[i] ?? null, light = status === 'running' ? lightFor(slot) : null;
      const item = el('li', 'slot' + (slot ? '' : ' empty')); item.dataset.id = li * 6 + i;
      const cap = el('span', 'cap', String(i + 1)); const ring = el('i');
      if (light) { ring.style.setProperty('--c', light.color); ring.style.setProperty('--o', light.level); if (light.motion !== 'solid') ring.className = light.motion; }
      cap.append(ring);
      const title = el('span', 'title', slot ? slot.title || 'Untitled task' : 'Empty. Pin a task to fill this key.');
      const state = el('span', 'state');
      if (slot) { const b = el('b', '', light?.label ?? '—'); if (light) b.style.setProperty('--sc', light.color); state.append(b); if (li === 2) state.append(document.createTextNode(slot.provider === 'claude' ? ' in Claude' : ' in Codex')); }
      item.append(cap, title, state); list.append(item);
    }
    group.append(list); board.append(group);
  });
  paintDevice();
}

function paintDevice() {
  const layer = snapshot?.layers?.[shown];
  if (status !== 'running') { device.clear(); device.ring(status === 'error' ? 'error' : status === 'waiting' || status === 'starting' ? 'search' : 'off', status === 'error' ? COLORS.bad : COLORS.white); return; }
  device.keysAll([0, 1, 2, 3, 4, 5].map(i => lightFor(layer?.slots?.[i] ?? null)));
  const all = (snapshot?.layers ?? []).flatMap(l => l.slots).filter(Boolean);
  const wait = all.find(s => ['approval', 'awaiting_input', 'question'].includes(s.state));
  const busy = [...new Set(all.filter(s => ['working', 'planning', 'testing', 'command', 'editing'].includes(s.state)).map(s => s.provider))];
  if (wait) device.ring('error', lightFor(wait).color);
  else if (busy.length) device.ring('search', busy.length > 1 ? COLORS.white : COLORS[busy[0]]);
  else device.ring('steady', '#5b8cff');
}

function setStatus(next, message) {
  status = next;
  const title = {running: message || 'Running', waiting: 'Waiting for your Micro', starting: 'Starting…', error: 'Stopped with an error', stopped: 'Stopped'}[next] ?? next;
  $('#status-title').textContent = title;
  $('#status-detail').textContent = {
    running: 'Your pinned tasks are on the keys. Press one to open its task.',
    waiting: 'Connect or wake your Micro. The bridge picks it up by itself.',
    starting: 'Taking control of the Micro.',
    error: message || 'The bridge stopped.',
    stopped: 'The Micro is released to Codex and Work Louder Input.',
  }[next] ?? '';
  $('#toggle').textContent = ['running', 'waiting', 'starting'].includes(next) ? 'Stop' : 'Start';
  banner();
  render();
}

function banner() {
  const box = $('#banner'); box.replaceChildren();
  if (welcome && status === 'running') {
    const c = el('div', 'callout ok'); const t = el('div'); t.append(el('p', '', 'The bridge is running. Reopen Codex now.'));
    const b = el('button', 'btn small secondary', 'Open Codex'); b.addEventListener('click', () => call('openCodex'));
    c.append(t, b); box.append(c);
  }
  if (profileUpdate) {
    const c = el('div', 'callout'); const t = el('div');
    t.append(el('p', '', 'The knob, joystick and action keys need a mapping update to work on the Claude layer.'));
    const b = el('button', 'btn small secondary', 'Open setup'); b.addEventListener('click', () => call('openSetup'));
    c.append(t, b); box.append(c);
  }
  if (status === 'error') {
    const c = el('div', 'callout bad'); const t = el('div');
    t.append(el('p', '', 'Quit Codex and Work Louder Input if they took the Micro back, then start again.'));
    c.append(t); box.append(c);
  }
}

on(message => {
  if (message.event === 'status') { snapshot = message.state?.snapshot ?? snapshot; setStatus(message.status, message.message); }
  if (message.event === 'host') {
    const e = message.data ?? {};
    if (e.type === 'state') { snapshot = e.snapshot; render(); }
    if (e.type === 'layer') { physical = e.layerIndex <= 2 ? e.layerIndex : null; if (physical !== null) select(physical); }
    if (e.type === 'action' && e.action) {
      // Show which control ran, on the layer it ran on.
      if (e.action.layer - 1 !== shown) select(e.action.layer - 1);
      device.flashControl(e.action.control);
    }
    if (e.type === 'selected') {
      const id = (e.selected.layer - 1) * 6 + e.selected.slot - 1;
      device.press(e.selected.slot - 1);
      const row = document.querySelector(`.slot[data-id="${id}"]`);
      row?.classList.add('selected'); setTimeout(() => row?.classList.remove('selected'), 1200);
    }
  }
});

function select(layer) {
  shown = layer;
  for (const t of document.querySelectorAll('.layer-tabs button')) t.setAttribute('aria-selected', String(Number(t.dataset.layer) === layer));
  device.layer(layer);
  controls.show(layer);
  render();
}
device.layer(shown);
for (const t of document.querySelectorAll('.layer-tabs button')) t.addEventListener('click', () => select(Number(t.dataset.layer)));

$('#toggle').addEventListener('click', async e => {
  e.currentTarget.disabled = true;
  try { await call(['running', 'waiting', 'starting'].includes(status) ? 'hostStop' : 'hostStart'); }
  finally { e.currentTarget.disabled = false; }
});
$('#setup').addEventListener('click', () => call('openSetup'));
$('#restore').addEventListener('click', async e => {
  if (restoring) return;
  const b = e.currentTarget;
  if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Stop the bridge and restore the original profile?'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Restore original keyboard profile'; }, 6000); return; }
  restoring = true; b.textContent = 'Restoring…';
  const result = await call('restore');
  restoring = false; b.dataset.confirm = '';
  const out = parse(result);
  b.textContent = result.code === 0 && out?.restored ? 'Original profile restored' : 'Restore failed: ' + failure(result).text;
});

const initial = await call('hostState');
snapshot = initial.state?.snapshot ?? null;
setStatus(initial.status, initial.message);
// Ask once whether the profile predates lower-control mapping.
call('controls').then(result => { profileUpdate = Boolean(parse(result)?.profileUpdate); banner(); }).catch(() => {});
