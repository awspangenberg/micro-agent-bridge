import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {MicroHidTransport, microDevice, connectionGuard, collectionInstance} from '../src/standalone-hid.mjs';
import {frame} from '../src/slots.mjs';

function emit(handle, value, size = 61) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  for (let offset = 0; offset < bytes.length; offset += size) {
    const part = bytes.subarray(offset, offset + size), report = Buffer.alloc(64);
    report[0] = 6; report[1] = 2; report[2] = part.length; part.copy(report, 3);
    handle.emit('data', report);
  }
}
function fake(respond = (h, request) => emit(h, {id: request.id, result: {ok: true}})) {
  const h = new EventEmitter(); h.bytes = ''; h.requests = []; h.reports = []; h.closed = 0;
  h.write = async bytes => {
    h.reports.push(Buffer.from(bytes)); h.bytes += bytes.subarray(3, 3 + bytes[2]).toString('ascii');
    let request;
    try { request = JSON.parse(h.bytes); } catch { return; }
    h.bytes = ''; h.requests.push(request); await respond(h, request);
  };
  h.close = async () => { h.closed++; };
  return h;
}

test('serializes complete multipart RPCs, preserves id zero, and uses one data listener', async () => {
  let active = 0, highest = 0;
  const h = fake(async (h, r) => {
    highest = Math.max(highest, ++active);
    await new Promise(resolve => setTimeout(resolve, 2));
    emit(h, {id: r.id, result: r.method}, 7); active--;
  });
  const t = new MicroHidTransport(h, {cooldownMs: 0});
  assert.equal(h.listenerCount('data'), 1);
  assert.deepEqual(await Promise.all([t.rpc('v.oai.thstatus', frame(Array(6).fill('working'))), t.rpc('device.status')]), ['v.oai.thstatus', 'device.status']);
  assert.equal(h.requests[0].id, 0); assert.equal(h.requests[1].id, 1); assert.equal(highest, 1);
  assert.ok(h.reports.length > 2);
  assert.ok(h.reports.every(b => b.length === 64 && b[0] === 6 && b[1] === 2 && b[2] <= 61));
  await t.close(); assert.equal(h.closed, 1); assert.equal(h.listenerCount('data'), 0);
});

test('reply does not release queue before the write operation finishes', async () => {
  let writing = false;
  const h = fake(async (h, r) => {
    assert.equal(writing, false); writing = true;
    emit(h, {id: r.id, result: 'ok'});
    await new Promise(resolve => setTimeout(resolve, 5)); writing = false;
  });
  const t = new MicroHidTransport(h, {cooldownMs: 0});
  await Promise.all([t.rpc('device.status'), t.rpc('sys.version')]); await t.close();
});

test('fragmented UTF-8, compact notifications, and unrelated IDs are handled', async () => {
  const h = fake((h, r) => {
    emit(h, {id: 700, result: 'wrong'});
    emit(h, {m: 'v.oai.hid', p: {k: 'AG00', act: 1, private: 'discard'}});
    emit(h, {method: 'kb.radial', params: {layer_index: 2}});
    emit(h, {i: r.id, result: {label: '你好 🎹'}}, 1);
  });
  const t = new MicroHidTransport(h, {cooldownMs: 0});
  const events = []; t.on('input', x => events.push(x)); t.on('layer', x => events.push(x));
  assert.deepEqual(await t.rpc('device.status'), {label: '你好 🎹'});
  assert.deepEqual(events, [{event: 'input', key: 'AG00', act: 1}, {event: 'layer', layerIndex: 2}]); await t.close();
});

test('deadline cancels a hung write even after an early device reply', async () => {
  const h = fake((h, r) => { emit(h, {id: r.id, result: 'early'}); return new Promise(() => {}); });
  const t = new MicroHidTransport(h, {timeoutMs: 15, cooldownMs: 0});
  await assert.rejects(t.rpc('device.status'), /timed out/);
  await t.close(); assert.equal(h.closed, 1);
});

test('timeout rejects current and queued RPCs, closes once, and never replays writes', async () => {
  const h = fake(() => {}), t = new MicroHidTransport(h, {timeoutMs: 15, cooldownMs: 0});
  const results = await Promise.allSettled([t.rpc('device.status'), t.rpc('sys.version')]);
  assert.ok(results.every(r => r.status === 'rejected' && /timed out/.test(r.reason.message)));
  await t.close(); assert.equal(h.closed, 1); assert.equal(h.requests.length, 1);
  await assert.rejects(t.rpc('device.status'), /closed/);
});

test('malformed reports and RPC errors close transport and cancel queued writes', async () => {
  for (const respond of [
    h => { const bad = Buffer.alloc(64); bad[0] = 6; bad[1] = 2; bad[2] = 62; h.emit('data', bad); },
    (h, r) => emit(h, {id: r.id, error: {message: 'denied'}}),
    (h, r) => emit(h, {id: r.id}),
    h => h.emit('error', Error('unplugged')),
  ]) {
    const h = fake(respond), t = new MicroHidTransport(h, {cooldownMs: 0});
    await assert.rejects(t.rpc('device.status')); await t.close(); assert.equal(h.closed, 1);
  }
});

test('only intended device IDs and bounded profile/light methods accepted', async () => {
  assert.equal(microDevice({vendorId: 0x303a, productId: 0x8360, usagePage: 0xff00}), true);
  assert.equal(microDevice({vendorId: 0x303a, productId: 0x8360, usagePage: 1}), false);
  const h = fake(), t = new MicroHidTransport(h, {cooldownMs: 0});
  await assert.rejects(t.rpc('sys.reboot'), /Unsupported/);
  await assert.rejects(t.rpc('fs.readbin', {file: '../private', offset: 0, len: 10}), /Invalid/);
  await assert.rejects(t.rpc('v.oai.thstatus', [{id: 0}]), /six/);
  for (const [data, offset] of [[Buffer.alloc(129).toString('base64'), 0], ['!!!!', 0], ['', 0], [Buffer.alloc(128).toString('base64'), 100000]])
    await assert.rejects(t.rpc('fs.writebin', {file: 'keymap.json', data, offset, append: true, completed: true}), /Invalid/);
  await t.rpc('v.oai.thstatus', frame(Array(6).fill('idle'), 6).map((x, i) => ({...x, id: i})));
  assert.equal(h.requests.length, 1); await t.close();
});

test('connection guard refuses changed interfaces and resume, with bounded enumeration frequency', async () => {
  let time = 100, devices = [{path: 'original'}], calls = 0;
  const guard = connectionGuard(async () => { calls++; return devices; }, 'original', {now: () => time});
  await guard(); await guard(); assert.equal(calls, 1);
  time += 2100; devices = [{path: 'other'}]; await assert.rejects(guard(), /connection changed/);
  devices = [{path: 'original'}]; time += 16000; await assert.rejects(guard(), /resumed/);
});

test('an exclusively held RPC collection hidden from enumeration keeps its own sibling instance', async () => {
  const path = (col, n, suffix = '') => `\\\\?\\HID#{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&02303a_PID&8360_REV&0001_f3995c46da2a&Col${col}#9&1ff1911d&0&000${n}#{4d1e55b2-f16f-11cf-88cb-001111000030}${suffix}`;
  const held = path('04', 3), siblings = [path('01', 0, '\\KBD'), path('02', 1), path('03', 2)];
  assert.equal(collectionInstance(held), collectionInstance(siblings[0]));
  assert.equal(collectionInstance('\\\\?\\HID#VID_303A&PID_8360#7&abc&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}'), null);
  let time = 0, topology = {rpc: [], collections: siblings};
  const guard = connectionGuard(async () => topology, held, {now: () => time});
  await guard();
  for (const changed of [
    {rpc: [], collections: []},
    {rpc: [], collections: siblings.map(p => p.replace('1ff1911d', '2aa2a22a'))},
    {rpc: [{path: path('04', 3).replace('1ff1911d', '2aa2a22a')}], collections: siblings},
    {rpc: [{path: held}, {path: 'usb'}], collections: siblings},
  ]) { time += 2100; topology = changed; await assert.rejects(guard(), /connection changed/); }
  time += 2100; topology = {rpc: [{path: held}], collections: [held, ...siblings]}; await guard();
  // Without sibling evidence a plain list cannot prove a hidden interface is unchanged.
  const legacy = connectionGuard(async () => [], held, {now: () => 0});
  await assert.rejects(legacy(), /connection changed/);
});

test('every queued RPC checks ownership before its first fragment', async () => {
  const h = fake(); let checks = 0;
  const t = new MicroHidTransport(h, {cooldownMs: 0, beforeRequest: async () => { if (++checks === 2) throw Error('ownership lost'); }});
  const results = await Promise.allSettled([t.rpc('sys.version'), t.rpc('device.status')]);
  assert.equal(results[0].status, 'fulfilled'); assert.match(results[1].reason.message, /ownership lost/);
  assert.equal(h.requests.length, 1); await t.close();
});

test('pause during a multipart profile write cancels before the next fragment', async () => {
  let time = 100;
  const guard = connectionGuard(async () => [{path: 'one'}], 'one', {now: () => time});
  const h = fake(), write = h.write;
  h.write = async report => { await write(report); if (h.reports.length === 1) time += 16000; };
  const t = new MicroHidTransport(h, {cooldownMs: 0, beforeRequest: guard});
  await assert.rejects(t.rpc('fs.writebin', {file: 'keymap.json', data: Buffer.alloc(128).toString('base64'), offset: 0, append: true, completed: false}), /resumed/);
  await t.close(); assert.equal(h.reports.length, 1); assert.equal(h.requests.length, 0); assert.equal(h.closed, 1);
});
