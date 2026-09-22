export const identity = t => `${t.provider}:${t.host}:${t.nativeId??'pending/'+t.navId}`;
// A Desktop task can resume under a new native process/session ID without being repinned.
export const pinIdentity = t => `${t.provider}:${t.host}:${t.navId??t.nativeId}`;
export function agentSlot(key){const match=/^AG(\d{2})$/.exec(key??'');if(!match)return null;const id=Number(match[1]);return id>=6&&id<18?{layer:id<12?2:3,index:id%6}:null;}
export function assignedClaude(...views){return [...new Map(views.flatMap(v=>v.slots).filter(t=>t?.provider==='claude'&&typeof t.nativeId==='string').map(t=>[identity(t),t])).values()];}
export function allocate(previous, inventories) {
  const old = previous ?? {slots:Array(6).fill(null),waiting:[]};
  const available=new Map(), authoritative=new Set();
  for (const source of inventories) {
    if (!source.available) continue;
    authoritative.add(`${source.provider}:${source.host}`);
    for (const t of source.tasks) if (!t.archived) available.set(pinIdentity(t),t);
  }
  const retained = t => t && (!authoritative.has(`${t.provider}:${t.host}`) || available.has(pinIdentity(t)));
  const existing=[...old.slots,...(old.waiting??[])].filter(retained);
  const candidates=new Map(existing.map(t=>[pinIdentity(t),available.get(pinIdentity(t))??t]));
  const additions=[];
  const groups=['codex','claude'].map(p=>[...available.values()].filter(t=>t.provider===p));
  for(let i=0;i<Math.max(...groups.map(x=>x.length));i++) for(const group of groups) {
    const t=group[i];if(t&&!candidates.has(pinIdentity(t))){additions.push(t);candidates.set(pinIdentity(t),t);}
  }
  // No native cross-app pin timestamps exist. Seed existing pins from sidebar order,
  // then persist observed pin additions. Task activity never changes pin recency.
  const ranks={...old.pinRanks};let serial=old.pinSerial??0;
  if(!old.pinRanks){for(const t of existing.toReversed())ranks[pinIdentity(t)]=++serial;}
  for(const t of additions.toReversed())ranks[pinIdentity(t)]=++serial;
  for(const key of Object.keys(ranks))if(!candidates.has(key))delete ranks[key];
  const recent=[...candidates.values()].sort((a,b)=>ranks[pinIdentity(b)]-ranks[pinIdentity(a)]);
  const chosen=new Set(recent.slice(0,6).map(pinIdentity));
  const slots=old.slots.map(t=>t&&chosen.has(pinIdentity(t))?candidates.get(pinIdentity(t)):null);
  const occupied=new Set(slots.filter(Boolean).map(pinIdentity));
  const incoming=recent.slice(0,6).filter(t=>!occupied.has(pinIdentity(t)));
  for(let i=0;i<6;i++)if(!slots[i])slots[i]=incoming.shift()??null;
  return {slots,waiting:recent.slice(6),pinRanks:ranks,pinSerial:serial};
}
export const colors={empty:[0,0,0],unknown:[0x606060,.2,1],idle:[0xffffff,.45,1],working:[0x0066ff,.55,6],awaiting_input:[0xff9900,.55,4],completed:[0x00ff00,.5,1],error:[0xff0000,.5,1],disconnected:[0xff0000,.5,1]};
export function frame(states,bank=12){if(![6,12].includes(bank))throw Error('Unowned lighting bank');return states.map((state,i)=>{const [c,b,e]=colors[state]??colors.unknown;return {id:bank+i,c,b,e,s:.3,sk:0,sa:0};});}
