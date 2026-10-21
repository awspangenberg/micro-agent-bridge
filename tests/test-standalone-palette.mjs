import test from 'node:test';
import assert from 'node:assert/strict';
import {slotLight, ambientLight, PALETTE, normalize, normalizeLights, resolveLights, KEY_STATES, RING_STATES, DEFAULT_LIGHTS} from '../src/standalone-palette.mjs';
import {ambientConfig} from '../src/standalone-hid.mjs';
import {lightingFrame} from '../src/micro-protocol.mjs';
import {CodexActivity, isTestCommand, itemActivity} from '../src/standalone-activity.mjs';

test('every palette state passes device lighting bounds and waits flash fast', () => {
  const states = [...Object.keys(PALETTE), 'awaiting_input', 'idle', 'unknown', 'empty', 'something-new'];
  const frame = states.slice(0, 6).map((s, i) => slotLight(s, 'codex', i));
  assert.doesNotThrow(() => lightingFrame(frame, [0]));
  for (const s of states) assert.doesNotThrow(() => lightingFrame(Array.from({length: 6}, (_, i) => slotLight(s, 'claude', 6 + i)), [6]));
  assert.equal(normalize('awaiting_input'), 'approval');
  assert.equal(normalize('something-new'), 'inactive', 'unknown states never light as active');
  for (const wait of ['approval', 'question']) assert.deepEqual([PALETTE[wait].e, PALETTE[wait].s], [4, 1]);
  for (const active of ['planning', 'testing', 'command', 'editing', 'working']) assert.equal(PALETTE[active].e, 6);
  assert.equal(new Set(['approval', 'question', 'planning', 'testing', 'command', 'editing', 'completed'].map(s => PALETTE[s].c)).size, 7, 'distinct colours');
  assert.equal(slotLight('unknown', undefined, 0).c, 0x606060);
});

test('ambient ring summarizes the most urgent task and stays within bounds', () => {
  const t = (state, provider = 'codex') => ({state, provider});
  assert.equal(ambientLight([t('working'), t('question', 'claude'), t('approval')]).c, PALETTE.approval.c);
  assert.equal(ambientLight([t('working'), t('question', 'claude')]).c, PALETTE.question.c);
  assert.equal(ambientLight([t('testing', 'claude'), t('error')]).c, PALETTE.error.c);
  assert.deepEqual([ambientLight([t('editing', 'claude'), null]).c, ambientLight([t('editing', 'claude')]).e], [0xff9900, 2]);
  assert.equal(ambientLight([t('working'), t('planning', 'claude')]).c, 0xffffff, 'both providers working sweep white');
  assert.equal(ambientLight([t('idle'), t('completed'), {state: 'empty'}]).e, 0);
  for (const ring of [ambientLight([t('approval')]), ambientLight([t('working')]), ambientLight([])])
    assert.deepEqual(ambientConfig({ambient: ring}).keys, {e: 0, b: 0, s: 0, m: 0, c: 0});
  for (const bad of [{}, {ambient: {e: 3, b: .2, s: 0, c: 0}}, {ambient: {e: 1, b: .9, s: 0, c: 0}}, {ambient: {e: 1, b: .2, s: 0, c: -1}}])
    assert.throws(() => ambientConfig(bad), /Invalid ambient/);
});

test("a person's colours override the defaults, stay within device limits, and drop invalid values", () => {
  const custom = {providers: {codex: '#00FF00', claude: 'orange'},
    keys: {approval: {c: '#123456', b: .3, e: 6, s: .5}, working: {c: null, e: 1}, completed: {e: 0}, testing: {c: '#zzzzzz', b: 2, e: 3, s: -1}, error: {c: null}},
    ring: {idle: {c: '#0000ff', b: .1, e: 1, s: 0}, working: {b: .2}, both: {c: '#ff00ff', e: 6}, approval: {e: 0}}, extra: 1};
  const o = normalizeLights(custom);
  assert.deepEqual(o.providers, {codex: '#00ff00'});
  assert.deepEqual(o.keys, {approval: {c: '#123456', b: .3, e: 6, s: .5}, working: {c: null, e: 1}, completed: {e: 0}});
  assert.equal(o.ring.idle.c, '#0000ff');
  const l = resolveLights(custom);
  assert.deepEqual(slotLight('approval', 'codex', 0, l), {id: 0, c: 0x123456, b: .3, e: 6, s: .5, sk: 0, sa: 0});
  assert.equal(slotLight('working', 'codex', 1, l).c, 0x00ff00, "the app's own colour");
  assert.equal(slotLight('working', 'claude', 1, l).c, PALETTE.working.c ?? 0xff9900);
  assert.equal(slotLight('completed', 'codex', 2, l).e, 0, 'off');
  assert.deepEqual(slotLight('testing', 'codex', 3, l), slotLight('testing', 'codex', 3), 'invalid values keep the default');
  const t = (state, provider = 'codex') => ({state, provider});
  assert.deepEqual(ambientLight([t('idle')], l), {e: 1, b: .1, s: 0, m: 0, c: 0x0000ff});
  assert.deepEqual(ambientLight([t('working')], l), {e: 2, b: .2, s: .3, m: 0, c: 0x00ff00});
  assert.equal(ambientLight([t('working'), t('editing', 'claude')], l).c, 0xff00ff);
  assert.equal(ambientLight([t('approval')], l).e, 0);
  assert.deepEqual(DEFAULT_LIGHTS, resolveLights({}));
  // Every combination the settings allow passes the device's own checks.
  for (const lights of [l, resolveLights({keys: Object.fromEntries(KEY_STATES.map(k => [k, {b: .65, s: 1, e: 4, c: '#ffffff'}])),
    ring: Object.fromEntries(RING_STATES.map(k => [k, {b: .65, s: 1, e: 2, c: '#ffffff'}]))})]) {
    for (const k of KEY_STATES) assert.doesNotThrow(() => lightingFrame(Array.from({length: 6}, (_, i) => slotLight(k, 'codex', i, lights)), [0]));
    for (const st of [[t('approval')], [t('question')], [t('error')], [t('working')], [t('working'), t('testing', 'claude')], [t('idle')]])
      assert.doesNotThrow(() => ambientConfig({ambient: ambientLight(st, lights)}));
  }
});

test('test commands are recognized by runner, not by substring', () => {
  for (const c of ['npm test', 'pnpm run test:unit', 'python -m pytest -q', 'cargo test --all', 'go test ./...', 'node --test tests/*.mjs', 'dotnet test', 'npx vitest run'])
    assert.ok(isTestCommand(c), c);
  for (const c of ['git status', 'cat attestation.md', 'echo contest', 'ls tests', null]) assert.ok(!isTestCommand(c), String(c));
  assert.equal(itemActivity({type: 'commandExecution', command: ['bash', '-lc', 'npm test']}), 'testing');
  assert.equal(itemActivity({type: 'fileChange'}), 'editing');
  assert.equal(itemActivity({type: 'reasoning'}), 'planning');
  assert.equal(itemActivity({type: 'agentMessage'}), null);
});

function codexWith(task) {
  const c = new CodexActivity(); c.client = 'client'; c.send = () => {}; c.tasks = [task];
  const emit = change => c.message({type: 'broadcast', method: 'thread-stream-state-changed', params: {hostId: task.hostId, conversationId: task.nativeId, change}});
  return {c, emit};
}
const task = {provider: 'codex', host: 'local', hostId: 'local', nativeId: '11111111-1111-4111-8111-111111111111'};
const snapshot = (items, runtime = {type: 'active'}, extra = {}) => ({type: 'snapshot', revision: 1, conversationState: {threadRuntimeStatus: runtime, requests: [], ...extra,
  turnHistory: {history: {entitiesByKey: {turn1: {status: 'inProgress', items}}}}}});

test('Codex detail follows the running item and never invents activity when idle', () => {
  const {c, emit} = codexWith(task);
  emit(snapshot({a: {id: 'a', type: 'reasoning', status: 'completed'}, b: {id: 'b', type: 'commandExecution', command: 'npm test', status: 'inProgress'}}));
  assert.equal(c.detail(task), 'testing');
  emit({type: 'patches', revision: 2, patches: [{op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn1', 'items', 'b', 'status'], value: 'completed'},
    {op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'turn1', 'items', 'c'], value: {id: 'c', type: 'fileChange', status: 'inProgress'}}]});
  assert.equal(c.detail(task), 'editing');
  emit({type: 'patches', revision: 3, patches: [{op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn1', 'items', 'c', 'status'], value: 'completed'}]});
  assert.equal(c.detail(task), 'working');
  emit({type: 'patches', revision: 4, patches: [{op: 'replace', path: ['threadRuntimeStatus'], value: {type: 'idle'}}]});
  assert.equal(c.detail(task), 'idle');
});

test('Codex plan mode, approvals and questions map to distinct details', () => {
  const {c, emit} = codexWith(task);
  emit(snapshot({}, {type: 'active'}, {latestCollaborationMode: {mode: 'plan'}}));
  assert.equal(c.detail(task), 'planning');
  emit(snapshot({}, {type: 'active', activeFlags: ['waitingOnUserInput']}));
  assert.equal(c.detail(task), 'question');
  emit(snapshot({}, {type: 'active', activeFlags: ['waitingOnApproval']}));
  assert.equal(c.detail(task), 'approval');
  // A partial update to a category field asks for a fresh snapshot, rate limited.
  let follows = 0; c.follow = () => { follows++; };
  emit({type: 'patches', revision: 2, patches: [{op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn1', 'items', 'z', 'command'], value: 'npm test'}]});
  emit({type: 'patches', revision: 3, patches: [{op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn1', 'items', 'z', 'command'], value: 'npm test'}]});
  assert.equal(follows, 2, 'one unfollow/follow pair within the rate limit');
});
