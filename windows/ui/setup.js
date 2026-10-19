import {call, on, parse, failure} from './bridge.js';
import {Device, COLORS, STATES} from './device.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const device = new Device($('#device'));
const caption = text => { $('#caption').textContent = text ?? ''; };
const ORDER = ['welcome', 'connect', 'control', 'map', 'test', 'prefs', 'finish'];
const LAYER_LIGHTS = [
  Array(6).fill({color: COLORS.codex, motion: 'solid', level: .8}),
  Array(6).fill({color: COLORS.claude, motion: 'solid', level: .8}),
  [0, 1, 2, 3, 4, 5].map(i => ({color: i % 2 ? COLORS.claude : COLORS.codex, motion: 'solid', level: .8})),
];
let current = 'welcome', env = {}, statusInfo = null;
const leave = {};

function note(target, kind, lines) {
  const box = $(target);
  if (!lines) { box.replaceChildren(); return; }
  const div = document.createElement('div'); div.className = 'callout ' + kind;
  for (const line of [].concat(lines)) { const p = document.createElement('p'); p.textContent = line; div.append(p); }
  box.replaceChildren(div);
}
function row(list, {mark, name, detail, action}) {
  const li = document.createElement('li');
  const m = document.createElement('span'); m.className = 'mark ' + mark;
  const n = document.createElement('span'); n.className = 'name'; n.textContent = name;
  li.append(m, n);
  if (action) li.append(action); else li.append(document.createElement('span'));
  if (detail) { const d = document.createElement('span'); d.className = 'detail'; d.textContent = detail; li.append(d); }
  list.append(li);
}
function button(text, kind, handler) {
  const b = document.createElement('button'); b.className = 'btn small ' + kind; b.textContent = text;
  b.addEventListener('click', handler); return b;
}

async function go(step) {
  if (leave[current]) await leave[current]();
  current = step;
  for (const s of $$('.step')) {
    const show = s.dataset.step === step;
    s.hidden = !show; s.classList.toggle('enter', show);
  }
  const index = ORDER.indexOf(step);
  $('#scale').classList.toggle('hidden', step === 'welcome');
  for (const d of $$('.detent')) {
    const i = ORDER.indexOf(d.dataset.step);
    d.classList.toggle('done', i < index); d.classList.toggle('now', i === index);
    if (i === index) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current');
  }
  await enter[step]?.();
  // Move focus to the new step's heading so keyboard and screen-reader users land on it.
  const heading = $('.step:not([hidden]) h1');
  heading.tabIndex = -1; heading.focus({preventScroll: true});
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-next]')) go(ORDER[ORDER.indexOf(current) + 1]);
  if (e.target.closest('[data-back]')) go(ORDER[ORDER.indexOf(current) - 1]);
});

const enter = {};

// ---- 0. Welcome: what's installed, what's pinned, and whether scripts may run.
enter.welcome = async () => {
  device.ring('off'); device.clear();
  caption('');
  const list = $('#preflight'); list.replaceChildren();
  row(list, {mark: 'busy', name: 'Checking this PC…'});
  env = await call('env');
  const doctor = parse(await call('doctor')) ?? {};
  list.replaceChildren();
  const pins = doctor.pins ?? {};
  row(list, env.codexInstalled
    ? {mark: 'ok', name: 'Codex app', detail: pinText(pins.codex, 'Codex')}
    : {mark: 'warn', name: 'Codex app not found', detail: 'Install Codex from the Microsoft Store to use layers 1 and 3.'});
  row(list, env.claudeInstalled
    ? {mark: 'ok', name: 'Claude app', detail: pinText(pins.claude, 'Claude')}
    : {mark: 'warn', name: 'Claude app not found', detail: 'Install the Claude desktop app to use layers 2 and 3.'});
  const blocked = ['Restricted', 'AllSigned'].includes(env.policy);
  row(list, blocked
    ? {mark: 'bad', name: 'Scripts are blocked by policy', detail: `Group Policy sets PowerShell to ${env.policy}. The bridge's keyboard helper can't run until your administrator allows it.`}
    : {mark: 'ok', name: 'Keyboard helper can run'});
  note('#preflight-note', '', (pins.codex ?? 0) + (pins.claude ?? 0) === 0
    ? ['Tip: pin the tasks you want on keys in each app\'s sidebar. Only pinned tasks get a key.'] : null);
  if ($('#preflight-note').firstChild) $('#preflight-note').firstChild.className = 'callout ok';
  $('[data-step="welcome"] [data-next]').disabled = blocked;
};
const pinText = (n, app) => n === undefined ? 'Installed' : n === 0 ? `No pinned ${app} tasks yet` : `${n} pinned task${n === 1 ? '' : 's'}`;

// ---- 1. Connect: poll enumeration until exactly one Micro interface is present.
let via = 'usb', polling = 0;
for (const b of $$('[data-via]')) b.addEventListener('click', () => {
  via = b.dataset.via;
  for (const o of $$('[data-via]')) o.setAttribute('aria-pressed', String(o === b));
  for (const p of $$('[data-for]')) p.hidden = p.dataset.for !== via;
});
$('#open-bluetooth').addEventListener('click', () => call('bluetooth'));
enter.connect = async () => {
  device.clear(); device.ring('search', COLORS.white);
  caption('Searching');
  const token = ++polling;
  let found = null;
  while (token === polling) {
    const doctor = parse(await call('doctor'));
    if (token !== polling) return;
    const devices = doctor?.devices ?? [];
    const live = $('#connect-live');
    if (devices.length === 1) {
      const d = devices[0];
      if (found !== d.key) { device.ring('success', COLORS.ok); setTimeout(() => current === 'connect' && device.ring('steady', COLORS.ok), 900); }
      found = d.key;
      // Show the instructions for the connection that was actually found.
      if (d.transport === 'usb' || d.transport === 'bluetooth') $(`[data-via="${d.transport}"]`).click();
      live.replaceChildren(markEl('ok'), text(`Found your Micro over ${d.transport === 'bluetooth' ? 'Bluetooth' : d.transport === 'usb' ? 'USB' : 'a connection'}.`));
      caption('Connected'); note('#connect-note'); $('#connect-next').disabled = false;
    } else {
      if (found) device.ring('search', COLORS.white);
      found = null; $('#connect-next').disabled = true; caption('Searching');
      live.replaceChildren(markEl('busy'), text(devices.length ? 'Two connections found.' : 'Looking for your Micro…'));
      note('#connect-note', 'bad', devices.length > 1 ? ['The Micro is connected by both cable and Bluetooth.', 'Unplug the cable or turn off Bluetooth on the Micro so one connection remains.'] : null);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
};
leave.connect = () => { polling++; };
const markEl = kind => { const m = document.createElement('span'); m.className = 'mark ' + kind; return m; };
const text = t => { const s = document.createElement('span'); s.textContent = t; return s; };

// ---- 2. Take control: other apps release the device; then open it exclusively once.
async function renderApps() {
  const running = await call('running');
  const list = $('#apps'); list.replaceChildren();
  for (const [app, name] of [['codex', 'Codex'], ['input', 'Work Louder Input']]) {
    const open = running[app] > 0;
    row(list, {mark: open ? 'warn' : 'ok', name: open ? `${name} is open` : `${name} is closed`,
      action: open ? button(`Quit ${name}`, 'secondary', async e => {
        e.target.disabled = true; e.target.textContent = 'Quitting…';
        const left = await call('quit', {app});
        if (left > 0) note('#control-note', '', [`${name} is still running. It may be waiting in the notification area.`, 'Quit it from its own icon, or force it to close.']), offerForce(app, name);
        renderApps();
      }) : null});
  }
  return running;
}
function offerForce(app, name) {
  $('#control-note .callout').append(button(`Force quit ${name}`, 'secondary', async () => { await call('quit', {app, force: true}); note('#control-note'); renderApps(); }));
}
enter.control = async () => {
  device.ring('steady', COLORS.ok); device.clear(); caption('');
  note('#control-note', '', env.hostRunning ? ['Micro Agent Bridge is running. Setup pauses it while you continue.'] : null);
  await renderApps();
};
$('#take-control').addEventListener('click', async e => {
  const b = e.currentTarget; b.disabled = true; b.textContent = 'Connecting…';
  device.ring('search', COLORS.white);
  const result = await call('status');
  b.disabled = false; b.textContent = 'Connect to the Micro';
  statusInfo = parse(result);
  if (result.code === 0 && statusInfo?.exclusive) {
    device.ring('steady', COLORS.ok);
    go('map');
    return;
  }
  device.ring('error', COLORS.bad);
  const f = failure(result);
  note('#control-note', 'bad', {
    busy: ['Another app still holds the Micro.', 'Quit Codex and Work Louder Input completely, including their notification-area icons, then connect again.'],
    'no-device': ['The Micro is no longer connected.', 'Go back and reconnect it.'],
    multiple: ['The Micro is connected twice.', 'Go back and keep one connection.'],
    'host-running': ['Another Micro host is running for this user.', 'Close other Micro Agent Bridge windows or terminals, then connect again.'],
  }[f.code] ?? ['The bridge couldn\'t open the Micro.', f.text]);
  renderApps();
});

// ---- 3. Map keys: show what changes, take consent, write and verify the profile.
$('#consent').addEventListener('change', e => { $('#map').disabled = !e.target.checked; });
enter.map = async () => {
  caption('');
  const profile = statusInfo?.profile ?? {};
  if (profile.configured) {
    device.sweep(LAYER_LIGHTS[0]);
    $('#map-body').hidden = true; $('#map').textContent = 'Continue'; $('#map').disabled = false;
    note('#map-note', 'ok', ['The task keys are already mapped on this Micro.', 'Your original profile backup is kept for restore.']);
  } else {
    device.clear(); $('#map-body').hidden = false; $('#map').textContent = 'Map keys'; $('#map').disabled = !$('#consent').checked;
    note('#map-note', '', profile.pending ? ['A previous mapping was interrupted. Mapping again finishes it from the same backup.'] : null);
  }
};
$('#map').addEventListener('click', async e => {
  if (statusInfo?.profile?.configured) return go('test');
  const b = e.currentTarget; b.disabled = true; b.textContent = 'Mapping…';
  device.ring('search', COLORS.white);
  const result = await call('configure');
  const out = parse(result);
  if (result.code === 0 && out?.profile?.configured) {
    statusInfo = {...statusInfo, profile: {...statusInfo?.profile, configured: true}};
    device.ring('steady', COLORS.ok);
    note('#map-note', 'ok', ['Task keys mapped and verified.', `Backup: ${out.profile.backupPath ?? 'saved in the bridge\'s data folder'}`]);
    for (const lights of LAYER_LIGHTS) { await device.sweep(lights, 70); await new Promise(r => setTimeout(r, 260)); }
    b.textContent = 'Continue'; b.disabled = false;
    return;
  }
  device.ring('error', COLORS.bad);
  b.textContent = 'Try again'; b.disabled = false;
  const f = failure(result);
  note('#map-note', 'bad', {
    'linked-apps': ['Your profile switches layers automatically when you change apps (linked apps).', 'Turn that off in Work Louder Input, quit it, and try again.'],
    identity: ['This Micro (or Bluetooth channel) differs from the one the backup belongs to.', 'Switch back to the original connection, or restore the profile first.'],
    busy: ['Another app took the Micro back.', 'Quit Codex and Work Louder Input, then try again.'],
  }[f.code] ?? ['The profile wasn\'t changed.', f.text]);
});

// ---- 4. Test: the device lights every task key; each press shows up live.
let testDone = false;
const passed = new Set();
enter.test = async () => {
  testDone = false; passed.clear();
  for (const l of $$('#test-layers .layer')) l.classList.remove('passed');
  $('#test-next').disabled = true; note('#test-note');
  device.ring('steady', COLORS.white);
  device.keysAll(Array(6).fill({color: COLORS.white, motion: 'breathe', level: .7}));
  setLive('busy', 'Lighting the keys…');
  try { await call('keyTestStart'); }
  catch (e) { setLive('bad', 'The test couldn\'t start.'); note('#test-note', 'bad', [e.message]); }
};
leave.test = async () => { if (!testDone) await call('keyTestStop'); device.clear(); };
$('#test-skip').addEventListener('click', () => go('prefs'));
const setLive = (mark, t) => $('#test-live').replaceChildren(markEl(mark), text(t));
on(message => {
  if (current !== 'test') return;
  if (message.event === 'keytest') {
    const e = message.data ?? {};
    if (e.type === 'ready') setLive('busy', 'Press any glowing key.');
    if (e.type === 'layer') caption(`Layer ${e.layerIndex + 1}`);
    if (e.type === 'press') {
      device.press(e.slot - 1);
      device.key(e.slot - 1, {color: COLORS.ok, motion: 'solid'});
      passed.add(e.layer);
      $(`#test-layers [data-layer="${e.layer}"]`)?.classList.add('passed');
      caption(`Layer ${e.layer}, key ${e.slot}`);
      setLive('busy', `${passed.size} of 3 layers done. ${passed.size < 3 ? 'Switch layers and press another.' : ''}`);
      // Each layer has its own lights; show the next layer's keys waiting again.
      setTimeout(() => { if (current === 'test' && !testDone) device.keysAll(Array(6).fill({color: COLORS.white, motion: 'breathe', level: .7})); }, 700);
    }
    if (e.type === 'done') {
      testDone = true;
      if (e.result === 'complete') {
        setLive('ok', 'Every layer responds.'); device.ring('success', COLORS.ok);
        device.sweep(Array(6).fill({color: COLORS.ok, motion: 'solid', level: .8}), 60);
        $('#test-next').disabled = false;
      } else {
        setLive('warn', e.result === 'timeout' ? 'The test timed out.' : 'The test stopped.');
        note('#test-note', '', e.result === 'disconnected' ? ['The Micro disconnected. Reconnect it and go back one step.'] : null);
        const again = button('Test again', 'secondary', () => enter.test());
        $('#test-note').append(again);
      }
    }
    if (e.type === 'fatal' || e.type === 'stderr') { note('#test-note', 'bad', [e.message ?? 'The test stopped.']); }
  }
});

// ---- 5. Preferences.
enter.prefs = async () => {
  caption('');
  device.ring('steady', COLORS.codex); device.keysAll(LAYER_LIGHTS[2]);
  // First onboarding suggests starting with Windows; setting up again shows the current choice.
  $('#pref-startup').checked = env.onboarded ? !!env.startup : true;
  $('#pref-alerts').checked = env.alerts ?? true;
  $('#pref-hooks').checked = !!env.hooks;
};
$('#prefs-next').addEventListener('click', async e => {
  const b = e.currentTarget; b.disabled = true;
  try {
    await call('startup', {enable: $('#pref-startup').checked});
    await call('alerts', {enable: $('#pref-alerts').checked});
    if ($('#pref-hooks').checked !== !!env.hooks) env.hooks = await call('hooks', {enable: $('#pref-hooks').checked});
    note('#prefs-note');
    go('finish');
  } catch (error) {
    note('#prefs-note', 'bad', ['A preference couldn\'t be saved.', error.message]);
  } finally { b.disabled = false; }
});

// ---- 6. Finish: legend of real key colours, then hand over to the tray app.
enter.finish = async () => {
  caption('');
  const legend = $('#legend'); legend.replaceChildren();
  const items = [
    ['Codex working', COLORS.codex], ['Claude working', COLORS.claude],
    ...['approval', 'question', 'planning', 'testing', 'command', 'editing', 'completed', 'error'].map(k => [STATES[k].label, STATES[k].color]),
  ];
  for (const [label, color] of items) {
    const li = document.createElement('li'); const sw = document.createElement('span');
    sw.className = 'swatch'; sw.style.background = color; li.append(sw, text(label)); legend.append(li);
  }
  device.ring('steady', COLORS.white);
  await device.sweep([STATES.approval, {color: COLORS.codex}, {color: COLORS.claude}, STATES.testing, STATES.completed, STATES.planning]
    .map(s => ({color: s.color, motion: s.motion ?? 'solid', level: .9})), 110);
};
$('#finish').addEventListener('click', async e => {
  e.currentTarget.disabled = true; e.currentTarget.textContent = 'Starting…';
  await call('finish');
});

go('welcome');
