// Messages to and from the app shell. Outside the app (a plain browser) a simulator answers,
// so the pages can be previewed without a device.
const native = window.chrome?.webview;
const pending = new Map(), listeners = new Set();
let seq = 0, simulator;

if (native) {
  native.addEventListener('message', ({data}) => {
    if (data?.id && pending.has(data.id)) {
      const {resolve, reject} = pending.get(data.id); pending.delete(data.id);
      data.ok ? resolve(data.data) : reject(new Error(data.error));
    } else listeners.forEach(f => f(data));
  });
}

export async function call(cmd, args = {}) {
  if (!native) {
    simulator ??= await import('./simulator.js');
    return simulator.call(cmd, args, message => listeners.forEach(f => f(message)));
  }
  const id = String(++seq);
  native.postMessage({id, cmd, args});
  return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
}
export const on = f => { listeners.add(f); return () => listeners.delete(f); };

// CLI replies carry stdout/stderr; the commands print JSON on success.
export function parse(result) {
  try { return JSON.parse(result.stdout); } catch { return null; }
}
export function failure(result) {
  const text = (result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).at(-1) ?? 'Unknown error';
  if (/Exclusive Micro open failed/.test(text)) return {code: 'busy', text};
  if (/found 0\b/.test(text)) return {code: 'no-device', text};
  if (/found \d+/.test(text)) return {code: 'multiple', text};
  if (/linkedApps/.test(text)) return {code: 'linked-apps', text};
  if (/pending/i.test(text)) return {code: 'pending', text};
  if (/identity mismatch/i.test(text)) return {code: 'identity', text};
  if (/already owns|helper process/i.test(text)) return {code: 'host-running', text};
  return {code: 'other', text};
}
