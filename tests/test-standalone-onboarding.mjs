import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {parseArguments, reporter, transportOf, keyTest, KEY_TEST, waitForDevice} from '../src/standalone-control.mjs';
import {lightingFrame} from '../src/micro-protocol.mjs';

class FakeTransport extends EventEmitter {
  constructor() { super(); this.calls = []; this.closed = false; }
  async rpc(method, params) { if (method === 'v.oai.thstatus') lightingFrame(params, [0, 6, 12]); this.calls.push({method, params}); return {}; }
}

test('onboarding options are limited to start and test-keys', () => {
  assert.deepEqual(parseArguments(['test-keys', '--ndjson', '--stdin-control']), {command: 'test-keys', ndjson: true, stdinControl: true});
  assert.equal(parseArguments(['start', '--supervise', '--ndjson']).ndjson, true);
  assert.throws(() => parseArguments(['doctor', '--ndjson']), /only valid with start, test-keys or watch-input/);
  assert.throws(() => parseArguments(['status', '--stdin-control']), /only valid with start, test-keys or watch-input/);
});

test('ndjson reporter writes one typed event per line; text mode keeps the human message', () => {
  const lines = [];
  reporter(true, line => lines.push(line))('press', {key: 'AG07', layer: 2}, 'Layer 2 works');
  assert.deepEqual(lines.map(l => JSON.parse(l)), [{type: 'press', key: 'AG07', layer: 2}]);
});

test('transport is derived from the HID path without exposing it', () => {
  assert.equal(transportOf('\\\\?\\HID#{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&02303a_PID&8360&Col02#a&1&0001#{4d1e55b2-f16f-11cf-88cb-001111000030}'), 'bluetooth');
  assert.equal(transportOf('\\\\?\\HID#VID_303A&PID_8360&MI_02&Col02#8&2&0001#{4d1e55b2-f16f-11cf-88cb-001111000030}'), 'usb');
  assert.equal(transportOf(undefined), 'unknown');
});

test('key test lights every task key, marks presses, finishes after all layers and clears', async () => {
  const transport = new FakeTransport(), signals = new EventEmitter();
  const running = keyTest(transport, {signals, timeoutMs: 5000});
  await new Promise(r => setImmediate(r));
  assert.equal(transport.calls.length, 3);
  assert.ok(transport.calls.every(c => c.params.every(s => s.c === KEY_TEST.waiting.c)));
  transport.emit('input', {key: 'ACT14', act: 1});   // lower controls are ignored
  transport.emit('input', {key: 'AG02', act: 0});    // releases are ignored
  transport.emit('input', {key: 'AG02', act: 1});
  await new Promise(r => setImmediate(r));
  const repaint = transport.calls.at(-1).params;
  assert.equal(repaint.find(s => s.id === 2).c, KEY_TEST.pressed.c);
  assert.equal(repaint.find(s => s.id === 3).c, KEY_TEST.waiting.c);
  transport.emit('input', {key: 'AG08', act: 1});
  transport.emit('input', {key: 'AG17', act: 1});
  assert.equal(await running, 'complete');
  assert.deepEqual(transport.calls.slice(-3).map(c => c.params.every(s => s.b === 0)), [true, true, true]);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(transport.listenerCount('input'), 0);
});

test('waiting for a device returns exactly one connection, or null once stopped', async () => {
  const signals = new EventEmitter();
  const seen = [[], [{key: 'a'}, {key: 'b'}], [{key: 'a'}]];
  const found = await waitForDevice([], {signals, wait: async () => {}, enumerate: async () => seen.shift()});
  assert.deepEqual(found, [{key: 'a'}]);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  const stopped = await waitForDevice([], {signals, wait: async () => signals.emit('SIGINT'), enumerate: async () => [{key: 'a'}]});
  assert.equal(stopped, null);
  assert.equal(parseArguments(['start', '--wait-for-device']).waitForDevice, true);
  assert.throws(() => parseArguments(['status', '--wait-for-device']), /only valid with start/);
});

test('watch-input reports every notification and writes only blank key lights', async () => {
  const {watchInput} = await import('../src/standalone-control.mjs');
  const transport = new FakeTransport(), signals = new EventEmitter();
  const running = watchInput(transport, {seconds: 5, signals});
  await new Promise(r => setImmediate(r));
  transport.emit('notification', {method: 'v.oai.rad', params: {x: 1}});
  signals.emit('SIGINT');
  assert.equal(await running, 'stopped');
  assert.deepEqual(transport.calls.map(c => c.method), ['device.status', 'v.oai.thstatus', 'v.oai.thstatus', 'v.oai.thstatus']);
  assert.ok(transport.calls.slice(1).every(c => c.params.every(s => s.b === 0)));
  assert.equal(transport.listenerCount('notification'), 0);
  assert.equal(parseArguments(['watch-input', '--seconds', '30']).seconds, 30);
  assert.throws(() => parseArguments(['start', '--seconds', '30']), /only valid with watch-input/);
});

test('key test stops on a signal, a disconnect or the deadline without further writes', async () => {
  const signals = new EventEmitter();
  let transport = new FakeTransport();
  let running = keyTest(transport, {signals, timeoutMs: 5000});
  await new Promise(r => setImmediate(r));
  signals.emit('SIGINT');
  assert.equal(await running, 'stopped');

  transport = new FakeTransport();
  running = keyTest(transport, {signals, timeoutMs: 5000});
  await new Promise(r => setImmediate(r));
  transport.closed = true; transport.emit('closed', null);
  assert.equal(await running, 'disconnected');
  assert.equal(transport.calls.length, 3);

  transport = new FakeTransport();
  assert.equal(await keyTest(transport, {signals, timeoutMs: 20}), 'timeout');
});
