import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {StandaloneRuntime, reconcileViews, standaloneFrame, taskRoute} from '../src/standalone-runtime.mjs';
import {parseArguments} from '../src/standalone-control.mjs';
import {normalizeSettings, effectiveMapping, parseToml, stickDirection, ACTIONS} from '../src/standalone-controls.mjs';

const codexTask = {provider: 'codex', host: 'local', hostId: 'local', nativeId: '11111111-1111-4111-8111-111111111111', title: 'One'};
const claudeTask = {provider: 'claude', host: 'local', nativeId: null, navId: 'session_test123', title: 'Two', state: 'working'};
const inventory = () => ({codex: [codexTask], claude: [claudeTask], errors: {}});
function fixtures(overrides = {}) {
  const transport = new EventEmitter(); transport.calls = []; transport.closed = false;
  transport.rpc = async (method, params) => { assert.equal(transport.closed, false); transport.calls.push({method, params}); return {}; };
  transport.close = async error => { transport.closed = true; transport.emit('closed', error); };
  const codex = {connect() {}, update(tasks) { this.tasks = tasks; }, state() { return 'working'; }, close() { this.closed = true; }};
  const opened = [];
  const runtime = new StandaloneRuntime({transport, codex, inventory: async () => inventory(), topology: async () => {}, openTask: async t => opened.push(t), pollMs: 60000,
    codexLayout: () => null, settings: () => normalizeSettings(null), ...overrides});
  return {transport, codex, runtime, opened};
}

test('frames use provider colours for working/inactive and the shared palette otherwise', () => {
  const states = ['idle', 'unknown', 'working', 'working', 'testing', 'empty'];
  const providers = ['codex', 'claude', 'codex', 'claude', 'claude', undefined];
  for (const layer of [0, 1, 2]) {
    const f = standaloneFrame(states, layer, providers);
    assert.deepEqual(f.map(s => s.id), [0, 1, 2, 3, 4, 5].map(i => layer * 6 + i));
    assert.deepEqual(f.slice(0, 4).map(s => [s.c, s.e]), [[0x0066ff, 1], [0xff9900, 1], [0x0066ff, 6], [0xff9900, 6]]);
    assert.ok(f[0].b < f[2].b && f[1].b < f[3].b, 'inactive stays dimmer than working');
    assert.equal(f[4].c, 0xffd000, 'activity colour overrides provider colour');
    assert.deepEqual([f[5].c, f[5].b, f[5].e], [0, 0, 0]);
  }
});

// Feed a raw device event and wait until the control it decodes to has run.
const press = async (runtime, event) => { runtime.transport.emit(event.event ?? 'input', event); await runtime.queue; };

test('Claude-layer controls click named buttons only for pinned Claude tasks in the front window', async () => {
  const claude = {provider: 'claude', host: 'local', nativeId: null, navId: 'session_test123', title: 'Two', state: 'working', bridges: ['session_alt']};
  const calls = [], results = [], shortcuts = [];
  const {runtime, transport} = fixtures({inventory: async () => ({codex: [codexTask], claude: [claude], errors: {}}),
    runAction: async (labels, ids, mode) => { calls.push({labels, ids, mode}); return {performed: true}; },
    sendShortcut: async chord => { shortcuts.push(chord); return {performed: true}; }});
  let layerIndex = 1;
  transport.rpc = async (method, params) => { transport.calls.push({method, params}); return method === 'device.status' ? {layer_index: layerIndex} : {}; };
  runtime.on('action', a => results.push(a));
  await runtime.start();
  // Check on the Claude layer (shared code ACT14) approves in Claude, bound to the pinned sessions.
  await press(runtime, {key: 'ACT14', act: 1});
  assert.deepEqual(calls[0], {labels: ACTIONS.approve.claude.labels, ids: ['session_test123', 'session_alt'], mode: 'invoke'});
  assert.deepEqual(results[0], {layer: 2, control: 'check', action: 'approve', performed: true, reason: null});
  // Releases do nothing except end a held microphone.
  await press(runtime, {key: 'ACT14', act: 0});
  assert.equal(calls.length, 1);
  await press(runtime, {key: 'ACT17', act: 1}); await press(runtime, {key: 'ACT18', act: 1});
  await press(runtime, {key: 'ACT17', act: 0}); await press(runtime, {key: 'ACT18', act: 0});
  assert.deepEqual(calls.slice(1).map(c => [c.labels[0], c.mode]), [['Press and hold to record', 'on'], ['Press and hold to record', 'off']]);
  // Codex's layer sends Codex shortcuts; Approve waits for a Codex approval.
  await press(runtime, {key: 'ACT07', act: 1});
  assert.deepEqual(shortcuts, [], 'no Codex approval is waiting');
  assert.equal(results.at(-1).reason, 'no-codex-approval-waiting');
  await press(runtime, {event: 'stick', a: 0.01, d: 1});
  await press(runtime, {event: 'stick', a: 0, d: 0});
  assert.deepEqual(shortcuts, ['Ctrl+['], 'joystick left is Back');
  // "Opened" targeting binds to the task last opened by its key, and expires.
  runtime.settings = () => normalizeSettings({target: 'opened'});
  await press(runtime, {key: 'ACT15', act: 1});
  assert.equal(results.at(-1).reason, 'task-not-bound');
  await runtime.select({key: `AG${String(6 + runtime.views[1].slots.findIndex(Boolean)).padStart(2, '0')}`, act: 1});
  await press(runtime, {key: 'ACT15', act: 1});
  assert.deepEqual(calls.at(-1).labels, ACTIONS.reject.claude.labels);
  runtime.bound.at -= 16 * 60000;
  await press(runtime, {key: 'ACT15', act: 1});
  assert.equal(results.at(-1).reason, 'task-not-bound');
  await runtime.stop();
});

test('Mixed tries Claude then Codex; knob cycles pinned tasks; the app key follows the layer', async () => {
  const shortcuts = [], apps = [];
  const {runtime, transport, opened} = fixtures({
    runAction: async () => ({performed: false, reason: 'foreground-not-claude'}),
    sendShortcut: async chord => { shortcuts.push(chord); return {performed: true}; },
    openApp: async provider => { apps.push(provider); return {performed: true}; }});
  let layerIndex = 2;
  transport.rpc = async (method, params) => { transport.calls.push({method, params}); return method === 'device.status' ? {layer_index: layerIndex} : {}; };
  await runtime.start();
  await press(runtime, {key: 'ACT01', act: 1}); await press(runtime, {key: 'ACT01', act: 0});
  await press(runtime, {key: 'ACT01', act: 1});
  assert.deepEqual(opened.map(t => t.provider), ['codex', 'claude'], 'knob right opens the next pinned task each detent');
  await press(runtime, {key: 'ACT04', act: 1});
  assert.deepEqual(shortcuts, ['Ctrl+['], 'Claude not in front, so Back goes to Codex');
  await press(runtime, {key: 'ACT19', act: 1});
  assert.equal(apps.at(-1), 'codex', 'Mixed opens the app acted on most recently (Back went to Codex)');
  layerIndex = 1; await press(runtime, {key: 'ACT19', act: 1});
  assert.equal(apps.at(-1), 'claude');
  await press(runtime, {key: 'ACT12', act: 1});
  assert.equal(apps.at(-1), 'codex', "Codex's own app key");
  // Layer reads come from the device for shared codes only.
  assert.ok(transport.calls.filter(c => c.method === 'device.status').length >= 5);
  await runtime.stop();
});

test('controls follow Codex settings, fall back where Claude has no equivalent, and honour overrides', () => {
  const layout = parseToml(`
[desktop.codex-micro-layout]
encoderMode = "composer-navigation"
[desktop.codex-micro-layout.slots.ACT06]
keycapId = "FAST"
[desktop.codex-micro-layout.slots.ACT07]
keycapId = "APPR"
[desktop.codex-micro-layout.slots.ACT10_ACT11]
keycapId = "MIC"
[desktop.codex-micro-layout.slots.ACT12]
keycapId = "CODEX"
[desktop.codex-micro-layout.analogStick.up]
type = "command"
commandId = "composer.togglePlanMode"
[desktop.codex-micro-layout.analogStick.down]
type = "command"
commandId = "toggleSidebar"
`).desktop['codex-micro-layout'];
  const map = effectiveMapping(normalizeSettings({layers: {mixed: {followCodex: false, overrides: {bolt: 'nextAttention'}}}}), layout);
  assert.deepEqual([map.codex.check.action, map.codex.check.source], ['approve', 'codex']);
  assert.deepEqual([map.claude.down.action, map.claude.mic.action, map.claude.app.action], ['sidebar', 'dictate', 'openApp']);
  // FAST and plan mode have no Claude equivalent: the bridge default applies there.
  assert.deepEqual([map.claude.bolt.action, map.claude.bolt.source, map.claude.up.action], ['stop', 'default-for-unsupported', 'prevTask']);
  assert.equal(map.codex.bolt.runs.codex, false, 'shown as unable to run on Codex');
  assert.deepEqual([map.mixed.bolt.action, map.mixed.bolt.source, map.mixed.check.source], ['nextAttention', 'override', 'default']);
  assert.deepEqual(stickDirection(0.76) + stickDirection(0.23) + stickDirection(0.49) + stickDirection(0.007), 'uprightdownleft');
});

test('three independent views map to all eighteen slots with stable positions', () => {
  const first = reconcileViews([], inventory());
  assert.equal(first[0].slots[0].provider, 'codex'); assert.equal(first[1].slots[0].provider, 'claude');
  assert.deepEqual(first[2].slots.slice(0, 2).map(t => t.provider), ['codex', 'claude']);
  const changed = reconcileViews(first, {...inventory(), codex: [{...codexTask, title: 'Renamed'}]});
  assert.equal(changed[0].slots[0].title, 'Renamed'); assert.equal(changed[2].slots[1].navId, claudeTask.navId);
  assert.deepEqual([0, 1, 2].flatMap(layer => standaloneFrame(Array(6).fill('unknown'), layer).map(s => s.id)), Array.from({length: 18}, (_, i) => i));
  const offline = reconcileViews(first, {codex: [], claude: [], errors: {codex: 'offline', claude: 'offline'}});
  assert.deepEqual(offline.map(v => v.slots), first.map(v => v.slots));
});

test('host paints all banks, handles only task presses, deduplicates presses, and clears on stop', async () => {
  const {runtime, transport, codex, opened} = fixtures();
  await runtime.start();
  assert.equal(codex.tasks.length, 1);
  assert.deepEqual(transport.calls.filter(x => x.method === 'v.oai.thstatus').map(x => x.params[0].id), [0, 6, 12]);
  await runtime.select({key: 'ACT00', act: 1}); await runtime.select({key: 'AG00', act: 0});
  await runtime.select({key: 'AG00', act: 1}); await runtime.select({key: 'AG00', act: 1});
  await runtime.select({key: 'AG06', act: 1});
  assert.deepEqual(opened, [codexTask, claudeTask]);
  const count = transport.calls.length; await runtime.tick();
  assert.equal(transport.calls.length, count + 1, 'unchanged colors are not replayed');
  await runtime.stop(); assert.equal(codex.closed, true); assert.equal(transport.closed, true);
  assert.ok(transport.calls.slice(-3).every(call => call.params.every(slot => slot.b === 0)));
  await runtime.select({key: 'AG12', act: 1}); assert.equal(opened.length, 2);
});

test('missing metadata retains assignments but disables stale navigation and working lights', async () => {
  const {runtime, opened} = fixtures(); await runtime.start();
  runtime.inventory = async () => { throw Error('reader unavailable'); };
  await runtime.tick(); await runtime.select({key: 'AG06', act: 1});
  assert.equal(opened.length, 0); assert.equal(runtime.taskState(claudeTask), 'unknown');
  assert.equal(runtime.views[1].slots[0].title, 'Two'); await runtime.stop();
});

test('navigation validates provider, host, and URI identities without shell interpretation', () => {
  assert.equal(taskRoute(codexTask), `codex://threads/${codexTask.nativeId}?hostId=local`);
  assert.equal(taskRoute(claudeTask), 'claude://code/session_test123');
  assert.equal(taskRoute({...claudeTask, navId: 'local_' + codexTask.nativeId}), `claude://code/continue?session=local_${codexTask.nativeId}`);
  for (const invalid of [{...codexTask, nativeId: 'x;calc.exe'}, {...codexTask, host: 'remote'}, {...claudeTask, navId: 'session_x&url=bad'}, {...claudeTask, archived: true}])
    assert.throws(() => taskRoute(invalid));
});

test('shutdown during pending inventory cannot paint or open a task afterward', async () => {
  let release;
  const {runtime, transport, opened} = fixtures({inventory: () => new Promise(resolve => { release = resolve; })});
  const started = runtime.start();
  await new Promise(resolve => setImmediate(resolve));
  await runtime.stop(Error('shutdown'));
  release(inventory()); await assert.rejects(started, /stopped/);
  await runtime.select({key: 'AG00', act: 1});
  assert.equal(transport.calls.length, 0); assert.equal(opened.length, 0);
});

test('topology failure ends runtime without clearing a different device', async () => {
  const {runtime, transport} = fixtures(); await runtime.start();
  const before = transport.calls.length;
  runtime.topology = async () => { throw Error('connection changed'); };
  try { await runtime.tick(); } catch (error) { await runtime.stop(error); }
  assert.equal(transport.calls.length, before); assert.equal(transport.closed, true);
});

test('startup topology failure closes ownership without cleanup writes', async () => {
  const {runtime, transport} = fixtures({topology: async () => { throw Error('startup connection changed'); }});
  await assert.rejects(runtime.start(), /startup connection changed/);
  await runtime.stop(); assert.equal(transport.closed, true); assert.equal(transport.calls.length, 0);
});

test('a long pause stops the host before another device request', async () => {
  const {runtime, transport} = fixtures(); await runtime.start();
  const before = transport.calls.length;
  runtime.lastProgress = Date.now() - 600000;
  try { await runtime.tick(); } catch (error) { await runtime.stop(error); }
  assert.equal(transport.calls.length, before); assert.equal(transport.closed, true);
});

test('malformed persisted slot arrays are discarded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-runtime-'));
  const {runtime} = fixtures({stateDirectory: dir});
  try {
    fs.writeFileSync(path.join(dir, 'standalone-slots.json'), JSON.stringify(Array(3).fill({slots: 'abcdef', waiting: []})));
    await runtime.start(); assert.equal(runtime.views[0].slots[0].nativeId, codexTask.nativeId);
  } finally { await runtime.stop(); fs.rmSync(dir, {recursive: true, force: true}); }
});

test('selection topology failure stops immediately and never opens a task', async () => {
  const {runtime, transport, opened} = fixtures(); await runtime.start();
  runtime.topology = async () => { throw Error('connection changed'); };
  await assert.rejects(runtime.select({key: 'AG00', act: 1}), /connection changed/);
  assert.equal(runtime.stopped, true); assert.equal(transport.closed, true); assert.equal(opened.length, 0);
});

test('a task unpinned while checking topology is never opened', async () => {
  const {runtime, opened} = fixtures(); await runtime.start();
  let release;
  runtime.topology = () => new Promise(resolve => { release = resolve; });
  const selection = runtime.select({key: 'AG00', act: 1});
  runtime.views = reconcileViews(runtime.views, {codex: [], claude: [], errors: {}});
  release(); await selection; assert.equal(opened.length, 0); await runtime.stop();
});

test('CLI requires explicit profile consent and validates options before device access', () => {
  assert.equal(parseArguments([]).command, 'doctor');
  assert.equal(parseArguments(['start', '--configure-profile', '--consent']).configureProfile, true);
  assert.throws(() => parseArguments(['setup-profile']), /consent/);
  assert.throws(() => parseArguments(['start', '--configure-profile']), /consent/);
  assert.throws(() => parseArguments(['start', '--state']), /Missing/);
  assert.throws(() => parseArguments(['start', '--unsafe']), /Unknown/);
});
