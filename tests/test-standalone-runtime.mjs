import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {StandaloneRuntime, reconcileViews, standaloneFrame, taskRoute} from '../src/standalone-runtime.mjs';
import {parseArguments} from '../src/standalone-control.mjs';
import {normalizeSettings, effectiveMapping, parseToml, stickDirection, CLAUDE, usedCodexCommands} from '../src/standalone-controls.mjs';
import {FALLBACK} from '../src/codex-catalog.mjs';

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
    codexLayout: () => null, settings: () => normalizeSettings(null), catalog: FALLBACK, bindings: () => [], ...overrides});
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


test('Claude-layer controls use named controls only for the layer\'s Claude tasks in the front window', async () => {
  const claude = {provider: 'claude', host: 'local', nativeId: null, navId: 'session_test123', title: 'Two', state: 'working', bridges: ['session_alt']};
  const calls = [], results = [], shortcuts = [];
  const {runtime, transport} = fixtures({inventory: async () => ({codex: [codexTask], claude: [claude], errors: {}}),
    runAction: async (op, request) => { calls.push({op, ...request}); return {performed: true}; },
    sendShortcut: async (chord, phase) => { shortcuts.push([chord, phase]); return {performed: true}; }});
  let layerIndex = 1;
  transport.rpc = async (method, params) => { transport.calls.push({method, params}); return method === 'device.status' ? {layer_index: layerIndex} : {}; };
  runtime.on('action', a => results.push(a));
  await runtime.start();
  // Check on the Claude layer (shared code ACT14) approves in Claude, bound to the layer's sessions.
  await press(runtime, {key: 'ACT14', act: 1});
  assert.deepEqual(calls[0], {op: 'invoke', labels: CLAUDE['approval.approve'].labels, ids: ['session_test123', 'session_alt']});
  assert.deepEqual(results[0], {layer: 2, control: 'check', action: 'cmd:approval.approve', performed: true, reason: null});
  // Releases do nothing except end a held microphone.
  await press(runtime, {key: 'ACT14', act: 0});
  assert.equal(calls.length, 1);
  await press(runtime, {key: 'ACT17', act: 1}); await press(runtime, {key: 'ACT18', act: 1});
  await press(runtime, {key: 'ACT17', act: 0}); await press(runtime, {key: 'ACT18', act: 0});
  assert.deepEqual(calls.slice(1).map(c => [c.labels[0], c.op]), [['Press and hold to record', 'on'], ['Press and hold to record', 'off']]);
  // Menu-based equivalents: thinking level and plan mode.
  runtime.settings = () => normalizeSettings({layers: {claude: {knobMode: 'reasoning', overrides: {up: 'cmd:composer.togglePlanMode'}}}});
  await press(runtime, {key: 'ACT01', act: 1});
  assert.deepEqual([calls.at(-1).op, calls.at(-1).arg, calls.at(-1).labels], ['effort', -1, ['Model:', 'Effort']]);
  await press(runtime, {key: 'ACT03', act: 1});
  assert.deepEqual([calls.at(-1).op, calls.at(-1).arg], ['plan', 'Plan']);
  runtime.settings = () => normalizeSettings(null);
  // Codex's layer sends Codex shortcuts; Approve waits for a Codex approval.
  await press(runtime, {key: 'ACT07', act: 1});
  assert.deepEqual(shortcuts, [], 'no Codex approval is waiting');
  assert.equal(results.at(-1).reason, 'no-codex-approval-waiting');
  await press(runtime, {event: 'stick', a: 0.01, d: 1});
  await press(runtime, {event: 'stick', a: 0, d: 0});
  assert.deepEqual(shortcuts, [['Ctrl+[', 'tap']], 'joystick left is Back');
  // Stop sends Escape to Codex only while a Codex task works and none waits for approval.
  const detail = runtime.codex.detail;
  runtime.codex.detail = () => 'idle'; await press(runtime, {key: 'ACT06', act: 1});
  assert.equal(results.at(-1).reason, 'no-codex-task-working');
  runtime.codex.detail = () => 'approval'; await press(runtime, {key: 'ACT06', act: 1});
  assert.equal(results.at(-1).reason, 'codex-waiting-for-you');
  runtime.codex.detail = () => 'working'; await press(runtime, {key: 'ACT06', act: 1});
  assert.deepEqual(shortcuts.at(-1), ['Escape', 'tap']);
  runtime.codex.detail = detail; shortcuts.length = 1;
  // Push to talk has no Codex shortcut until one is registered.
  await press(runtime, {key: 'ACT10', act: 1}); await press(runtime, {key: 'ACT10', act: 0});
  assert.equal(results.find(r => r.control === 'mic' && r.layer === 1).reason, 'unsupported');
  runtime.bindings = () => [{command: 'globalDictationHold', key: 'Ctrl+Alt+Shift+F13'}];
  await press(runtime, {key: 'ACT10', act: 1}); await press(runtime, {key: 'ACT11', act: 1});
  await press(runtime, {key: 'ACT10', act: 0}); await press(runtime, {key: 'ACT11', act: 0});
  assert.deepEqual(shortcuts.slice(-2), [['Ctrl+Alt+Shift+F13', 'down'], ['Ctrl+Alt+Shift+F13', 'up']]);
  // "Opened" targeting binds to the task last opened by its key, and expires.
  runtime.settings = () => normalizeSettings({target: 'opened'});
  layerIndex = 1;
  await press(runtime, {key: 'ACT15', act: 1});
  assert.equal(results.at(-1).reason, 'task-not-bound');
  await runtime.select({key: `AG${String(6 + runtime.views[1].slots.findIndex(Boolean)).padStart(2, '0')}`, act: 1});
  await press(runtime, {key: 'ACT15', act: 1});
  assert.deepEqual(calls.at(-1).labels, CLAUDE['approval.decline'].labels);
  runtime.bound.at -= 16 * 60000;
  await press(runtime, {key: 'ACT15', act: 1});
  assert.equal(results.at(-1).reason, 'task-not-bound');
  await runtime.stop();
});

test('Mixed tries Claude then Codex; knob cycles the layer\'s tasks; the app key follows the layer', async () => {
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
  assert.deepEqual(opened.map(t => t.provider), ['codex', 'claude'], 'knob right opens the next task each detent');
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
  // Every press is kept for the dashboard.
  assert.ok(runtime.recent.length >= 6 && runtime.recent.every(r => typeof r.at === 'number'));
  await runtime.stop();
});

test('controls follow Codex settings, fall back where an action cannot run, and honour presets and overrides', () => {
  const layout = parseToml(`
[desktop.codex-micro-layout]
encoderMode = "reasoning"
[desktop.codex-micro-layout.slots.ACT06]
keycapId = "FAST"
[desktop.codex-micro-layout.slots.ACT07]
keycapId = "APPR"
[desktop.codex-micro-layout.slots.ACT09]
keycapId = "TERM"
[desktop.codex-micro-layout.slots.ACT10_ACT11]
keycapId = "MIC"
[desktop.codex-micro-layout.slots.ACT12]
keycapId = "CODEX"
[desktop.codex-micro-layout.analogStick.up]
type = "command"
commandId = "composer.togglePlanMode"
`).desktop['codex-micro-layout'];
  const catalog = {...FALLBACK, keycaps: [{id: 'FAST', type: 'command', command: 'composer.toggleFastMode'}, {id: 'APPR', type: 'command', command: 'approval.approve'},
    {id: 'TERM', type: 'command', command: 'toggleTerminal'}]};
  const settings = normalizeSettings({layers: {mixed: {followCodex: false, knobMode: 'conversation-scroll', overrides: {bolt: 'nextAttention', check: 'approve'}}}});
  const map = effectiveMapping(settings, layout, {catalog, codexKeys: id => id === 'approval.approve'});
  assert.deepEqual([map.codex.check.action, map.codex.check.source], ['cmd:approval.approve', 'codex']);
  // Fast mode, plan mode and thinking level run in Claude through its menus.
  assert.deepEqual([map.claude.bolt.action, map.claude.up.action, map.claude.knobRight.action, map.claude.mic.action, map.claude.app.action],
    ['cmd:composer.toggleFastMode', 'cmd:composer.togglePlanMode', 'cmd:composer.decreaseReasoningEffort', 'ptt', 'openApp']);
  // Codex has no shortcut for FAST here, and Claude has no terminal: bridge defaults apply.
  assert.deepEqual([map.codex.bolt.action, map.codex.bolt.source, map.codex.bolt.runs.codex], ['stop', 'default-for-unsupported', true]);
  assert.deepEqual([map.claude.branch.action, map.claude.branch.source], ['cmd:newTask', 'default-for-unsupported']);
  // Knob preset and overrides (legacy names are migrated).
  assert.deepEqual([map.mixed.knobLeft.action, map.mixed.knobLeft.source], ['scrollUp', 'knob-mode']);
  assert.deepEqual([map.mixed.bolt.action, map.mixed.check.action, map.mixed.check.source], ['nextAttention', 'cmd:approval.approve', 'override']);
  const used = usedCodexCommands(map);
  assert.ok(['approval.approve', 'approval.decline', 'globalDictationHold', 'navigateBack', 'navigateForward'].every(c => used.includes(c)), used.join());
  assert.equal(stickDirection(0.76) + stickDirection(0.23) + stickDirection(0.49) + stickDirection(0.007), 'uprightdownleft');
});

test('agent keys show pinned or the six most recent tasks per layer, and remote candidates only while live', () => {
  const recent = n => ({provider: 'claude', host: 'local', navId: `local_${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, title: `R${n}`, activity: n});
  const inventory = {codex: [codexTask], claude: [claudeTask], codexRecent: [{...codexTask, activity: 5}], claudeRecent: [1, 9, 3, 7, 2, 8, 4].map(recent), errors: {}};
  const views = reconcileViews([], inventory, ['pinned', 'recent', 'recent']);
  assert.deepEqual(views[0].slots[0].title, 'One');
  assert.deepEqual(views[1].slots.map(t => t.title), ['R9', 'R8', 'R7', 'R4', 'R3', 'R2']);
  assert.deepEqual(views[2].slots.map(t => t.title), ['R9', 'R8', 'R7', 'One', 'R4', 'R3']);
  // A task still in the six keeps its key.
  const next = reconcileViews(views, {...inventory, claudeRecent: [...inventory.claudeRecent, recent(10)]}, ['pinned', 'recent', 'recent']);
  assert.equal(next[1].slots[0].title, 'R9'); assert.ok(next[1].slots.some(t => t.title === 'R10'));
  // Switching back to pinned starts the layer afresh.
  assert.deepEqual(reconcileViews(next, inventory)[1].slots[0].title, 'Two');
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
test('a fast knob spin becomes one thinking-level change, and a failing Claude menu pauses menus', async () => {
  const calls = [], results = [];
  let release, outcome = {performed: true};
  const {runtime, transport} = fixtures({
    runAction: async (op, request) => { calls.push({op, ...request}); if (calls.length === 1) await new Promise(r => { release = r; }); return outcome; }});
  transport.rpc = async (method, params) => { transport.calls.push({method, params}); return method === 'device.status' ? {layer_index: 1} : {}; };
  runtime.settings = () => normalizeSettings({layers: {claude: {knobMode: 'reasoning'}}});
  runtime.on('action', a => results.push(a));
  await runtime.start();
  // The first detent opens the menu; the next five arrive while it is open and become one change.
  transport.emit('input', {key: 'ACT01', act: 2});
  while (!release) await new Promise(r => setImmediate(r));
  for (let i = 0; i < 5; i++) transport.emit('input', {key: 'ACT01', act: 2});
  transport.emit('input', {key: 'ACT00', act: 2});
  release(); await runtime.queue; await runtime.queue;
  assert.deepEqual(calls.map(c => [c.op, c.arg]), [['effort', -1], ['effort', -4]]);
  assert.equal(results.at(-1).steps, 4);
  // A menu that can't be found pauses menu actions instead of reopening on every detent.
  outcome = {performed: false, reason: 'effort-levels-not-found'};
  await press(runtime, {key: 'ACT01', act: 2});
  await press(runtime, {key: 'ACT01', act: 2});
  assert.equal(calls.length, 3);
  assert.equal(results.at(-1).reason, 'claude-menu-paused');
  runtime.now = () => Date.now() + 31000; outcome = {performed: true};
  runtime.lastInventory = runtime.now();
  await press(runtime, {key: 'ACT01', act: 2});
  assert.equal(calls.length, 4);
  await runtime.stop();
});

test("the host paints with the person's colours and repaints when they change", async () => {
  const {runtime, transport} = fixtures();
  runtime.settings = () => normalizeSettings({lights: {providers: {codex: '#00ff00'}, keys: {working: {c: '#112233', b: .4}}}});
  await runtime.start();
  const frames = () => transport.calls.filter(c => c.method === 'v.oai.thstatus').map(c => c.params);
  assert.ok(frames().flat().some(k => k.c === 0x112233 && k.b === .4), 'working keys use the chosen colour');
  const before = frames().length;
  runtime.settings = () => normalizeSettings({lights: {keys: {working: {c: '#445566'}}}});
  await runtime.tick();
  assert.ok(frames().length > before && frames().slice(before).flat().some(k => k.c === 0x445566));
  await runtime.stop();
});
