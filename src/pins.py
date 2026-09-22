"""Read native pin metadata without opening writable databases or copying their contents."""
import json, sqlite3, struct, sys
from pathlib import Path

PIN_SECTION = '01984de2-8f74-7c91-a3b2-5c5e937cf318'
PIN_KEY = bytes.fromhex('000401010123') + 'store:pin-state:dframe-starred-code'.encode('utf-16be')

def varint(b, p):
    n = 0
    for s in range(0, 70, 7):
        x = b[p]; p += 1; n |= (x & 127) << s
        if x < 128: return n, p
    raise ValueError('Invalid varint')

def string(b, p):
    n,p = varint(b,p)
    if p+n > len(b): raise ValueError('Truncated string')
    return b[p:p+n], p+n

def records(b):
    parts=[]
    for block in range(0,len(b),32768):
        p=block; end=min(block+32768,len(b))
        while p+7<=end:
            n=struct.unpack_from('<H',b,p+4)[0]; kind=b[p+6]
            if not n or p+7+n>end: break  # An in-flight final WAL record is not committed.
            value=b[p+7:p+7+n]; p+=7+n
            if kind==1: yield value; parts=[]
            elif kind==2: parts=[value]
            elif kind==3 and parts: parts.append(value)
            elif kind==4 and parts: yield b''.join(parts+[value]); parts=[]
            else: raise ValueError('Invalid log record')

def snappy(b):
    length,p=varint(b,0)
    if length>128*1024*1024: raise ValueError('Oversized table block')
    out=bytearray()
    while p<len(b):
        tag=b[p]; p+=1; kind=tag&3
        if kind==0:
            n=(tag>>2)+1
            if n>60:
                count=n-60; n=int.from_bytes(b[p:p+count],'little')+1; p+=count
            if p+n>len(b): raise ValueError('Truncated literal')
            out.extend(b[p:p+n]);p+=n
        else:
            if kind==1: n=4+((tag>>2)&7); offset=((tag&224)<<3)|b[p];p+=1
            else:
                count=2 if kind==2 else 4;n=1+(tag>>2)
                offset=int.from_bytes(b[p:p+count],'little');p+=count
            if not 0<offset<=len(out):raise ValueError('Invalid copy offset')
            for _ in range(n):out.append(out[-offset])
        if len(out)>length:raise ValueError('Invalid decompressed length')
    if len(out)!=length:raise ValueError('Truncated block')
    return bytes(out)

def entries(b):
    if len(b)<4:raise ValueError('Truncated restart table')
    count=struct.unpack_from('<I',b,len(b)-4)[0];end=len(b)-4*(count+1);p=0;key=b''
    if end<0:raise ValueError('Invalid restart table')
    while p<end:
        shared,p=varint(b,p);n,p=varint(b,p);vlen,p=varint(b,p)
        if shared>len(key) or p+n+vlen>end:raise ValueError('Invalid table entry')
        key=key[:shared]+b[p:p+n];p+=n;value=b[p:p+vlen];p+=vlen
        yield key,value

def table(path):
    with path.open('rb') as f:
        f.seek(-48,2);footer=f.read(48)
        if footer[-8:]!=bytes.fromhex('57fb808b247547db'):raise ValueError('Unsupported table format')
        _,p=varint(footer,0);_,p=varint(footer,p);index_offset,p=varint(footer,p);index_size,p=varint(footer,p)
        def block(offset,size):
            if size>128*1024*1024:raise ValueError('Oversized block')
            f.seek(offset);data=f.read(size+5)
            if len(data)!=size+5:raise ValueError('Truncated block')
            if data[size]==0:return data[:size]
            if data[size]==1:return snappy(data[:size])
            raise ValueError('Unsupported compression')
        for _,handle in entries(block(index_offset,index_size)):
            offset,p=varint(handle,0);size,p=varint(handle,p)
            yield from entries(block(offset,size))

def manifest(data):
    files=set(); log=previous=0
    for record in records(data):
        p=0
        while p<len(record):
            tag,p=varint(record,p)
            if tag in (1,): _,p=string(record,p)
            elif tag in (2,3,4,9):
                value,p=varint(record,p)
                if tag==2:log=value
                if tag==9:previous=value
            elif tag==5: _,p=varint(record,p);_,p=string(record,p)
            elif tag==6:
                _,p=varint(record,p);n,p=varint(record,p);files.discard(n)
            elif tag==7:
                _,p=varint(record,p);n,p=varint(record,p);_,p=varint(record,p)
                _,p=string(record,p);_,p=string(record,p);files.add(n)
            else:raise ValueError('Unsupported manifest field')
    return files,log,previous

def decode_json(value):
    for offset in range(min(64,len(value)-2)):
        if value[offset]!=255 or value[offset+1] not in (15,16):continue
        tag=value[offset+2]
        if tag not in (34,83,99):continue
        data,_=string(value,offset+3)
        return json.loads(data.decode('utf-16le' if tag==99 else 'latin1' if tag==34 else 'utf-8'))
    raise ValueError('Unsupported IndexedDB serialization')

def claude_pin_ids(root):
    current=(root/'CURRENT').read_bytes();name=current.decode().strip()
    if not name.startswith('MANIFEST-') or '/' in name:raise ValueError('Invalid manifest')
    snapshot=(root/name).read_bytes();files,log,previous=manifest(snapshot);best=(-1,None)
    for number in files:
        path=root/f'{number:06d}.ldb'
        if not path.exists():path=root/f'{number:06d}.sst'
        for key,value in table(path):
            if len(key)>8 and key[:-8]==PIN_KEY:
                trailer=int.from_bytes(key[-8:],'little');seq=trailer>>8
                if seq>best[0]:best=(seq,value if trailer&255 else None)
    for path in root.glob('*.log'):
        if int(path.stem)<log and int(path.stem)!=previous:continue
        for batch in records(path.read_bytes()):
            if len(batch)<12:raise ValueError('Truncated batch')
            sequence,count=struct.unpack_from('<QI',batch);p=12
            for i in range(count):
                tag=batch[p];p+=1;key,p=string(batch,p)
                if tag==1:value,p=string(batch,p)
                elif tag==0:value=None
                else:raise ValueError('Invalid batch tag')
                if key==PIN_KEY and sequence+i>best[0]:best=(sequence+i,value)
    if (root/'CURRENT').read_bytes()!=current or (root/name).read_bytes()!=snapshot:raise ValueError('Compaction during read; retry')
    if best[0]<0:raise ValueError('Pin record unavailable')
    if best[1] is None:return []
    ids=decode_json(best[1])['state']['starredIds']
    if not isinstance(ids,list) or any(not isinstance(x,str) for x in ids):raise ValueError('Unsupported pin schema')
    return ids

def codex_pins(home,host,host_id='local'):
    path=home/'.codex/state_5.sqlite'
    if not path.exists():return []
    with sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True,timeout=.5) as db:
        rows=db.execute('SELECT id,title,archived FROM threads WHERE thread_section_id=? ORDER BY section_position ASC',(PIN_SECTION,)).fetchall()
    return [dict(provider='codex',host=host,nativeId=id,navId=id,title=title,archived=bool(archived),hostId=host_id) for id,title,archived in rows]

def codex_presence(home,ids):
    with sqlite3.connect('file:'+str(home/'.codex/state_5.sqlite')+'?mode=ro',uri=True,timeout=.5) as db:
        return [sid for sid in ids if db.execute('SELECT 1 FROM threads WHERE id=?',(sid,)).fetchone()]

def desktop_inventory():
    from claude_catalog import Catalog
    from claude_hooks import registry
    from paths import config
    c=config(); home=Path.home()
    base=Path(c.get('claudeData',str(home/'Library/Application Support/Claude' if sys.platform=='darwin' else home/'.config/Claude')))
    result={'codex':[], 'claude':[], 'claudePins':[], 'errors':{}}
    try:result['codex']=codex_pins(home,'local')
    except Exception as e:result['errors']['codex']=type(e).__name__
    try:result['claudePins']=claude_pin_ids(base/'IndexedDB/https_claude.ai_0.indexeddb.leveldb')
    except Exception as e:result['errors']['claude']=type(e).__name__
    ids=json.loads(sys.argv[1]) if len(sys.argv)>1 else []
    try:result['codexPresence']=codex_presence(home,ids)
    except Exception:result['codexPresence']=[]
    try:native=json.loads((home/'.codex/.codex-global-state.json').read_text())
    except (OSError,ValueError):native={}
    known=['local']+[x for h in c['hosts'] for x in h['codexHostIds']]
    result['knownHostsComplete']=all(h in known for h in native.get('remote-connection-auto-connect-by-host-id',{}))
    for file in (base/'claude-code-sessions').glob('*/*/local_*.json'):
        try:
            d=json.loads(file.read_text());ssh=d.get('sshConfig');host='local'
            if ssh:
                matches=[h for h in c['hosts'] if ssh.get('sshHost') in h['claudeTargets']]
                if len(matches)!=1:continue
                host=matches[0]['id']
            result['claude'].append(dict(provider='claude',host=host,nativeId=d.get('cliSessionId'),navId=d['sessionId'],title=d.get('title','Claude task'),archived=bool(d.get('isArchived')),bridgeIds=d.get('bridgeSessionIds',[])))
        except (OSError,ValueError,KeyError):result['errors']['claude']='session-metadata-unavailable'
    result['claudeMappings']=Catalog().pins(result['claudePins'],'local',registry())
    return result

if __name__=='__main__':
    try:print(json.dumps(desktop_inventory()))
    except Exception as e:print(json.dumps({'error':str(e)}));sys.exit(1)
