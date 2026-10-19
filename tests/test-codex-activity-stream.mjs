import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexActivity} from '../src/standalone-activity.mjs';

const task = {provider: 'codex', host: 'local', hostId: 'local', nativeId: '11111111-1111-4111-8111-111111111111'};
const itemPath = ['turnHistory', 'history', 'entitiesByKey', 'turn1', 'items'];
const command = {id: 'command-native-id', type: 'commandExecution', command: 'npm test', status: 'inProgress'};
const edit = {id: 'edit-native-id', type: 'fileChange', status: 'inProgress'};

function fixture(options) {
  const client = new CodexActivity(options), sent = [];
  client.client = 'fixture-client'; client.tasks = [task]; client.send = message => sent.push(message);
  const message = change => client.message({type: 'broadcast', method: 'thread-stream-state-changed',
    params: {hostId: 'local', conversationId: task.nativeId, change}});
  const snapshot = (revision, items) => message({type: 'snapshot', revision, conversationState: {
    threadRuntimeStatus: {type: 'active'}, requests: [],
    turnHistory: {history: {entitiesByKey: {turn1: {status: 'inProgress', items}}}},
  }});
  const patches = (baseRevision, revision, changes) => message({type: 'patches', baseRevision, revision, patches: changes});
  return {client, sent, snapshot, patches};
}

test('activity forwards transport and clock options to the status reader', () => {
  const now = () => 12345;
  const {client} = fixture({endpoint: 'fixture-endpoint', now, refreshMs: 91, initializeTimeout: 81});
  assert.equal(client.endpoint, 'fixture-endpoint');
  assert.equal(client.now, now);
  assert.equal(client.refreshMs, 91);
  assert.equal(client.initializeTimeout, 81);
});

test('numeric item patches update snapshot and replacement summaries by array position', () => {
  const {client, sent, snapshot, patches} = fixture();
  assert.equal(snapshot(10, [command]), true);
  assert.equal(client.detail(task), 'testing');
  assert.equal(patches(10, 11, [{op: 'replace', path: [...itemPath, 0, 'status'], value: 'completed'}]), true);
  assert.equal(client.detail(task), 'working', 'the completed command must stop contributing testing activity');
  patches(11, 12, [{op: 'replace', path: [...itemPath, 0], value: edit}]);
  assert.equal(client.detail(task), 'editing');
  patches(12, 13, [{op: 'replace', path: [...itemPath, 0, 'status'], value: 'completed'}]);
  assert.equal(client.detail(task), 'working');
  assert.equal(sent.length, 0, 'known numeric coordinates must not trigger a snapshot request');
});

test('rejected base revisions cannot change activity or trigger an extra detail resync', () => {
  const {client, sent, snapshot, patches} = fixture();
  snapshot(20, [edit]);
  assert.equal(client.detail(task), 'editing');
  assert.equal(patches(19, 21, [
    {op: 'replace', path: [...itemPath, 0], value: command},
    {op: 'replace', path: [...itemPath, 0, 'command'], value: 'npm test'},
  ]), false);
  assert.equal(client.detail(task), 'unknown');
  assert.deepEqual(sent.map(message => message.params.following), [false, true],
    'only the base reader should request recovery for a rejected revision');
  assert.equal(patches(21, 22, [{op: 'replace', path: [...itemPath, 0, 'status'], value: 'completed'}]), false);
  assert.equal(client.detail(task), 'unknown', 'patches cannot restore authority without a new snapshot');
  assert.equal(snapshot(30, []), true);
  assert.equal(client.detail(task), 'working', 'recovery must replace the stale detail mirror');
});

test('whole item collection replacement removes superseded activity summaries', () => {
  const {client, snapshot, patches} = fixture();
  snapshot(1, [command]);
  patches(1, 2, [{op: 'replace', path: itemPath, value: [edit]}]);
  assert.equal(client.detail(task), 'editing');
  patches(2, 3, [{op: 'replace', path: itemPath, value: []}]);
  assert.equal(client.detail(task), 'working');
});

test('object item keys and whole turn replacement use patch coordinates rather than item IDs', () => {
  const {client, snapshot, patches} = fixture();
  snapshot(1, {slot: command});
  patches(1, 2, [{op: 'replace', path: [...itemPath, 'slot', 'status'], value: 'completed'}]);
  assert.equal(client.detail(task), 'working');
  patches(2, 3, [{op: 'replace', path: itemPath.slice(0, 4), value: {status: 'inProgress', items: [edit]}}]);
  assert.equal(client.detail(task), 'editing');
  patches(3, 4, [{op: 'remove', path: itemPath.slice(0, 4)}]);
  assert.equal(client.detail(task), 'working');
});
