import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CodexStatus} from '../src/codex-ipc.mjs';

const task = {
  provider: 'codex', host: 'local', hostId: 'local',
  nativeId: '11111111-1111-4111-8111-111111111111',
};

async function until(condition, message, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function write(socket, value) {
  const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  socket.write(Buffer.concat([header, bytes]));
}

function streamChange(socket, change, thread = task, sourceClientId = 'renderer-1') {
  write(socket, {
    type: 'broadcast', version: 1, sourceClientId, method: 'thread-stream-state-changed',
    params: {
      hostId: thread.hostId, conversationId: thread.nativeId, change,
    },
  });
}

function snapshot(socket, type = 'active', thread = task, sourceClientId = 'renderer-1') {
  streamChange(socket, {
    type: 'snapshot', revision: 1,
    conversationState: {
      threadRuntimeStatus: {type, activeFlags: []}, requests: [],
      turnHistory: {history: {entitiesByKey: {}}},
    },
  }, thread, sourceClientId);
}

function broadcast(socket, method, params = {}) {
  write(socket, {type: 'broadcast', version: 1, sourceClientId: 'renderer-1', method, params});
}

async function fixture(t, {onFollow, onInitialize, initializeTimeout = 1000, tasks = [task]} = {}) {
  const id = `micro-codex-connection-${process.pid}-${randomUUID()}`;
  const endpoint = process.platform === 'win32' ? path.win32.join(String.raw`\\.\pipe`, id) : path.join(os.tmpdir(), `${id}.sock`);
  const f = {now: 100000, follows: [], followMessages: [], initializes: [], sockets: new Set(), errors: [], closed: 0};
  const server = net.createServer(socket => {
    f.sockets.add(socket);
    socket.on('close', () => { f.sockets.delete(socket); f.closed++; });
    socket.on('error', error => f.errors.push(error));
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      try {
        while (buffer.length >= 4) {
          const size = buffer.readUInt32LE();
          assert.ok(size > 0 && size <= 1024 * 1024);
          if (buffer.length < size + 4) return;
          const message = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
          buffer = buffer.subarray(size + 4);
          if (message.type === 'request' && message.method === 'initialize') {
            f.initializes.push(message);
            if (onInitialize?.(socket, message, f) === false) continue;
            write(socket, {
              type: 'response', requestId: message.requestId, method: 'initialize',
              resultType: 'success', result: {clientId: `test-client-${f.initializes.length}`},
            });
          } else if (message.type === 'broadcast' && message.method === 'thread-stream-following-changed') {
            assert.ok(tasks.some(thread => thread.hostId === message.params.hostId && thread.nativeId === message.params.conversationId));
            assert.equal(typeof message.params.following, 'boolean');
            f.follows.push(message.params.following);
            f.followMessages.push(message.params);
            onFollow?.(socket, message, f);
          } else assert.fail(`Unexpected IPC message: ${message.type}/${message.method}`);
        }
      } catch (error) { f.errors.push(error); socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  f.client = new CodexStatus({endpoint, now: () => f.now, refreshMs: 5000, initializeTimeout});
  f.client.update(tasks);
  const connect = net.connect;
  // Fail before opening a connection if endpoint injection ever regresses.
  net.connect = (...args) => {
    assert.equal(typeof args[0] === 'object' ? args[0].path : args[0], endpoint,
      'CodexStatus must use the synthetic endpoint');
    return connect.apply(net, args);
  };
  t.after(async () => {
    net.connect = connect;
    f.client.close();
    f.client.socket?.destroy();
    for (const socket of f.sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(f.errors, [], 'fake Codex server must receive valid IPC');
  });
  return f;
}

test('a follow sent before the renderer is ready retries and obtains an active snapshot', async t => {
  const f = await fixture(t, {onFollow(socket, message, state) {
    if (message.params.following && state.follows.filter(Boolean).length === 2) snapshot(socket);
  }});
  f.client.connect();
  await until(() => f.follows.length === 1, 'initial subscription was not sent');
  assert.equal(f.client.state(task), 'unknown');
  f.now += 5001;
  f.client.connect();
  await until(() => f.client.state(task) === 'working', 'missing-snapshot subscription did not recover');
  assert.deepEqual(f.follows, [true, false, true]);
  assert.equal(f.initializes.length, 1, 'refresh should reuse the healthy IPC connection');
});

test('a notLoaded snapshot is refreshed until the chat becomes active', async t => {
  const f = await fixture(t, {onFollow(socket, message, state) {
    if (message.params.following) snapshot(socket, state.follows.filter(Boolean).length === 1 ? 'notLoaded' : 'active');
  }});
  f.client.connect();
  await until(() => f.client.live.size === 1, 'initial notLoaded snapshot was not received');
  assert.equal(f.client.state(task), 'unknown');
  f.now += 5001;
  f.client.connect();
  await until(() => f.client.state(task) === 'working', 'notLoaded subscription did not recover');
  assert.deepEqual(f.follows, [true, false, true]);
});

test('repeated connect calls throttle missing-snapshot subscription refreshes', async t => {
  const f = await fixture(t);
  f.client.connect();
  await until(() => f.follows.length === 1, 'initial subscription was not sent');
  for (const step of [1, 10, 100, 1000, 3000]) { f.now += step; f.client.connect(); }
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(f.follows, [true], 'subscription was retried inside refreshMs');
  f.now = 105001;
  f.client.connect();
  await until(() => f.follows.length === 3, 'subscription did not retry after refreshMs');
  for (let i = 0; i < 5; i++) { f.now += 100; f.client.connect(); }
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(f.follows, [true, false, true], 'recovery attempts must also be throttled');
});

test('an unanswered initialize request times out and the next connect retries', async t => {
  const f = await fixture(t, {
    initializeTimeout: 40,
    onInitialize(_socket, _message, state) { return state.initializes.length !== 1; },
    onFollow(socket, message) { if (message.params.following) snapshot(socket); },
  });
  f.client.connect();
  await until(() => f.initializes.length === 1, 'initialize request was not sent');
  await until(() => f.closed === 1 && f.client.client === null && (!f.client.socket || f.client.socket.destroyed),
    'unanswered initialize did not disconnect by its deadline');
  assert.deepEqual(f.follows, [], 'uninitialized connections must not subscribe');
  f.client.connect();
  await until(() => f.client.state(task) === 'working', 'client did not recover after initialization timeout');
  assert.equal(f.initializes.length, 2);
  assert.deepEqual(f.follows, [true]);
});

test('a matching initialize response can omit its method field', async t => {
  const f = await fixture(t, {
    onInitialize(socket, message) {
      write(socket, {type: 'response', requestId: message.requestId, resultType: 'success', result: {clientId: 'methodless-client'}});
      return false;
    },
    onFollow(socket, message) { if (message.params.following) snapshot(socket); },
  });
  f.client.connect();
  await until(() => f.client.state(task) === 'working', 'matching method-less initialization was ignored');
  assert.equal(f.client.client, 'methodless-client');
  assert.deepEqual(f.follows, [true]);
});

test('an initialize response with a mismatched requestId cannot authorize subscriptions', async t => {
  const f = await fixture(t, {
    onInitialize(socket) {
      write(socket, {type: 'response', requestId: randomUUID(), method: 'initialize', resultType: 'success', result: {clientId: 'wrong-client'}});
      return false;
    },
    onFollow(socket, message) { if (message.params.following) snapshot(socket); },
  });
  f.client.connect();
  await until(() => f.initializes.length === 1, 'initialize request was not sent');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.client.client, null);
  assert.deepEqual(f.follows, []);
  write([...f.sockets][0], {
    type: 'response', requestId: f.initializes[0].requestId, method: 'initialize',
    resultType: 'success', result: {clientId: 'matching-client'},
  });
  await until(() => f.client.state(task) === 'working', 'matching initialization could not recover after an unrelated response');
  assert.equal(f.client.client, 'matching-client');
});

test('following-status requests reannounce only a matching subscribed chat', async t => {
  const f = await fixture(t);
  f.client.connect();
  await until(() => f.follows.length === 1, 'initial subscription was not sent');
  const [socket] = f.sockets;
  broadcast(socket, 'thread-stream-following-status-requested', {hostId: 'local', conversationId: 'different-chat'});
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(f.follows, [true]);
  broadcast(socket, 'thread-stream-following-status-requested', {hostId: task.hostId, conversationId: task.nativeId});
  await until(() => f.follows.length === 2, 'renderer subscription discovery was not answered');
  assert.deepEqual(f.follows, [true, true]);
});

test('a newly connected renderer receives every existing subscription', async t => {
  const second = {...task, nativeId: '22222222-2222-4222-8222-222222222222'};
  const f = await fixture(t, {tasks: [task, second]});
  f.client.connect();
  await until(() => f.follows.length === 2, 'initial subscriptions were not sent');
  broadcast([...f.sockets][0], 'client-status-changed', {clientId: 'renderer-2', isSelf: false, status: 'connected'});
  await until(() => f.follows.length === 4, 'new renderer did not receive subscriptions');
  assert.deepEqual(f.followMessages.slice(2).map(value => [value.conversationId, value.following]),
    [[task.nativeId, true], [second.nativeId, true]]);
});

test('IPC reset invalidates live state and reannounces subscriptions', async t => {
  const f = await fixture(t, {onFollow(socket, message, state) {
    if (message.params.following && state.follows.length === 1) snapshot(socket);
  }});
  f.client.connect();
  await until(() => f.client.state(task) === 'working', 'initial snapshot was not received');
  broadcast([...f.sockets][0], 'ipc-connection-reset');
  await until(() => f.follows.filter(Boolean).length === 2, 'reset did not reannounce the subscription');
  assert.equal(f.client.state(task), 'unknown');
  assert.equal(f.follows.at(-1), true);
});

test('a disconnected renderer invalidates only the state it supplied', async t => {
  const second = {...task, nativeId: '22222222-2222-4222-8222-222222222222'};
  const f = await fixture(t, {tasks: [task, second], onFollow(socket, message, state) {
    if (!message.params.following || state.follows.length > 2) return;
    const thread = message.params.conversationId === task.nativeId ? task : second;
    snapshot(socket, 'active', thread, thread === task ? 'renderer-1' : 'renderer-2');
  }});
  f.client.connect();
  await until(() => f.client.live.size === 2, 'both renderers did not supply snapshots');
  broadcast([...f.sockets][0], 'client-status-changed', {clientId: 'renderer-1', isSelf: false, status: 'disconnected'});
  await until(() => f.client.state(task) === 'unknown', 'disconnected renderer state remained active');
  assert.equal(f.client.state(second), 'working');
});

test('matching baseRevision accepts a coalesced patch batch with a revision jump', async t => {
  const f = await fixture(t, {onFollow(socket, message) { if (message.params.following) snapshot(socket); }});
  f.client.connect();
  await until(() => f.client.state(task) === 'working', 'initial snapshot was not received');
  streamChange([...f.sockets][0], {
    type: 'patches', baseRevision: 1, revision: 8,
    patches: [{op: 'replace', path: ['threadRuntimeStatus'], value: {type: 'idle'}}],
  });
  await until(() => f.client.state(task) === 'idle', 'matching baseRevision revision jump was rejected');
  assert.equal(f.client.live.get(`local:${task.nativeId}`).revision, 8);
  assert.deepEqual(f.follows, [true], 'a valid coalesced batch must not resubscribe');
});

test('mismatched baseRevision invalidates state and requests a fresh snapshot', async t => {
  const f = await fixture(t, {onFollow(socket, message, state) {
    if (message.params.following && state.follows.length === 1) snapshot(socket);
  }});
  f.client.connect();
  await until(() => f.client.state(task) === 'working', 'initial snapshot was not received');
  streamChange([...f.sockets][0], {
    type: 'patches', baseRevision: 0, revision: 2,
    patches: [{op: 'replace', path: ['threadRuntimeStatus'], value: {type: 'idle'}}],
  });
  await until(() => f.follows.length === 3, 'baseRevision mismatch did not request a snapshot');
  assert.equal(f.client.state(task), 'unknown');
  assert.deepEqual(f.follows, [true, false, true]);
});

test('legacy patch batches without baseRevision still require the next revision', async t => {
  const f = await fixture(t, {onFollow(socket, message, state) {
    if (message.params.following && state.follows.length === 1) snapshot(socket);
  }});
  f.client.connect();
  await until(() => f.client.state(task) === 'working', 'initial snapshot was not received');
  const [socket] = f.sockets;
  streamChange(socket, {
    type: 'patches', revision: 2,
    patches: [{op: 'replace', path: ['threadRuntimeStatus'], value: {type: 'idle'}}],
  });
  await until(() => f.client.state(task) === 'idle', 'legacy next-revision patch was rejected');
  streamChange(socket, {type: 'patches', revision: 4, patches: []});
  await until(() => f.follows.length === 3, 'legacy skipped revision did not request a snapshot');
  assert.equal(f.client.state(task), 'unknown');
});
