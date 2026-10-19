// Colour says what a task is doing; animation says how urgent it is.
// Effects: 1 solid, 2 snake (ambient only), 4 breath, 6 shallow breath.
export const PROVIDER = {codex: 0x0066ff, claude: 0xff9900};
const FAST = {e: 4, s: 1}, SLOW = {e: 6, s: .3}, SOLID = {e: 1, s: 0};
export const PALETTE = {
  approval: {c: 0xff3300, b: .6, ...FAST},
  question: {c: 0xff00ff, b: .6, ...FAST},
  planning: {c: 0x8a2be2, b: .5, ...SLOW},
  testing: {c: 0xffd000, b: .5, ...SLOW},
  command: {c: 0x00ccff, b: .5, ...SLOW},
  editing: {c: 0x00ffaa, b: .5, ...SLOW},
  working: {c: null, b: .55, ...SLOW},
  completed: {c: 0x00ff00, b: .5, ...SOLID},
  error: {c: 0xff0000, b: .5, ...SOLID},
  disconnected: {c: 0xff0000, b: .35, ...SLOW},
  inactive: {c: null, b: .15, ...SOLID},
};
const ALIAS = {awaiting_input: 'approval', idle: 'inactive', unknown: 'inactive'};
export const ACTIVE = ['planning', 'testing', 'command', 'editing', 'working'];
export const WAITS = ['approval', 'question'];
export const normalize = state => ALIAS[state] ?? (PALETTE[state] ? state : state === 'empty' ? 'empty' : 'inactive');

export function slotLight(state, provider, id) {
  const kind = normalize(state);
  if (kind === 'empty') return {id, c: 0, b: 0, e: 0, s: 0, sk: 0, sa: 0};
  const style = PALETTE[kind];
  // Provider colour for working/inactive; gray if a slot has no known provider.
  const c = style.c ?? PROVIDER[provider] ?? 0x606060;
  return {id, c, b: kind === 'inactive' && !PROVIDER[provider] ? .2 : style.b, e: style.e, s: style.s, sk: 0, sa: 0};
}

// The ring summarizes the most urgent task across every owned slot.
export function ambientLight(tasks) {
  const kinds = tasks.filter(t => t && t.state !== 'empty').map(t => ({kind: normalize(t.state), provider: t.provider}));
  for (const wait of WAITS) if (kinds.some(k => k.kind === wait)) return {e: 4, b: .6, s: 1, m: 0, c: PALETTE[wait].c};
  if (kinds.some(k => k.kind === 'error')) return {e: 4, b: .45, s: .3, m: 0, c: PALETTE.error.c};
  const working = [...new Set(kinds.filter(k => ACTIVE.includes(k.kind)).map(k => k.provider))];
  if (working.length) return {e: 2, b: .45, s: .3, m: 0, c: working.length === 1 ? PROVIDER[working[0]] ?? 0xffffff : 0xffffff};
  return {e: 0, b: 0, s: 0, m: 0, c: 0};
}
