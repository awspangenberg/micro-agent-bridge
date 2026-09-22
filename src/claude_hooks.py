"""Owned, allowlisted status hooks. Never persist input, prompt, or tool contents."""
import fcntl, hashlib, json, os, re, subprocess, sys, time
from datetime import datetime
from pathlib import Path
ROOT=Path(__file__).resolve().parent
from paths import STATE, CONFIG
EVENTS=('SessionStart','SessionEnd','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop','StopFailure','Elicitation','ElicitationResult')
def atomic(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    tmp=path.with_name(path.name+'.'+str(os.getpid())+'.tmp')
    fd=os.open(tmp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as f:json.dump(value,f)
    os.replace(tmp,path)

def registry():
    out={}
    for p in (Path.home()/'.claude/sessions').glob('*.json'):
        try:
            d=json.loads(p.read_text());pid=int(d['pid']);sid=d['sessionId']
            if not re.fullmatch('[a-f0-9-]{36}',sid):continue
            if sys.platform=='linux':
                proc=Path('/proc')/str(pid);fields=(proc/'stat').read_text().rsplit(')',1)[1].split();start=fields[19]
                exe=(proc/'exe').resolve(strict=True)
                roots=[Path.home()/'.claude/remote/ccd-cli',Path.home()/'.local/share/claude/versions']
                if proc.stat().st_uid!=os.getuid() or start!=d.get('procStart') or not any(exe.is_relative_to(r) for r in roots):continue
                identity=f'{pid}:{start}'
            else:
                line=subprocess.check_output(['/bin/ps','-p',str(pid),'-o','uid=,lstart=,comm='],text=True,timeout=1).strip()
                if not line.startswith(str(os.getuid())) or 'claude' not in line.lower():continue
                identity=hashlib.sha256(line.encode()).hexdigest()
            out[sid]={'identity':identity,'pid':pid,'bridge':d.get('bridgeSessionId'),'nativeState':d.get('status'),'startedAt':d.get('startedAt',0)/1000}
        except (OSError,ValueError,KeyError,subprocess.SubprocessError):pass
    return out

def allowed():
    try:
        d=json.loads((STATE/'claude-allowlist.json').read_text())
        if time.time()-d['timestamp']>15:return []
        return [x for x in d['ids'] if re.fullmatch('[a-f0-9-]{36}',x)]
    except (OSError,ValueError,KeyError):return []

def classify(d):
    event=d.get('hook_event_name')
    if event=='SessionStart':return 'idle'
    if event=='SessionEnd':return 'disconnected'
    if event=='Stop':return 'completed'
    if event=='StopFailure':return 'error'
    if event in ('PermissionRequest','Elicitation'):return 'awaiting_input'
    if event=='PreToolUse' and d.get('tool_name')=='AskUserQuestion':return 'awaiting_input'
    if event=='Notification' and d.get('notification_type') in ('permission_prompt','elicitation_dialog','elicitation_url_dialog','agent_needs_input'):return 'awaiting_input'
    if event in ('UserPromptSubmit','PreToolUse','PostToolUse','ElicitationResult'):return 'working'

def hook():
    d=json.load(sys.stdin);sid=d.get('session_id');state=classify(d)
    if sid not in allowed() or state is None or d.get('agent_id'):return
    live=registry().get(sid)
    if not live:return
    # Reject an invocation outside the identified Claude process ancestry.
    pid=os.getppid();ancestors=set()
    for _ in range(12):
        if pid<2 or pid in ancestors:break
        ancestors.add(pid)
        if sys.platform=='linux':pid=int((Path('/proc')/str(pid)/'stat').read_text().rsplit(')',1)[1].split()[1])
        else:pid=int(subprocess.check_output(['/bin/ps','-p',str(pid),'-o','ppid='],text=True,timeout=1))
    if live['pid'] not in ancestors:return
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (STATE/'hooks.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX);path=STATE/'claude-states'/f'{sid}.json'
        try:old=json.loads(path.read_text())
        except (OSError,ValueError):old={}
        atomic(path,dict(session_id=sid,state=state,timestamp=time.time(),sequence=old.get('sequence',0)+1,identity=live['identity']))

def completion_metadata(sid, started_at):
    """Recover a real Stop event missed while a Desktop native ID was remapped.

    Only assigned session files are read. No transcript contents leave this function.
    A later user/assistant event invalidates the completion. A tail without a complete
    Stop record is unknown, never success inferred from silence or process idleness.
    """
    if not started_at:return None
    paths=list((Path.home()/'.claude/projects').glob('*/'+sid+'.jsonl'))
    if len(paths)!=1:return None
    try:
        with paths[0].open('rb') as f:
            size=f.seek(0,2);offset=max(0,size-2*1024*1024);f.seek(offset)
            if offset:f.readline()
            row=None
            for line in f:
                if not line.endswith(b'\n'):return None
                d=json.loads(line)
                if d.get('sessionId')!=sid or d.get('isSidechain'):continue
                if d.get('type') in ('user','assistant'):row=None
                if d.get('type')=='system' and d.get('subtype')=='api_error':row=None
                if d.get('type')=='system' and d.get('subtype')=='stop_hook_summary':
                    row=None
                    if d.get('preventedContinuation') is False and not d.get('hookErrors'):
                        stamp=datetime.fromisoformat(d['timestamp'].replace('Z','+00:00')).timestamp()
                        if started_at<=stamp<=time.time()+5:row=dict(session_id=sid,state='completed',timestamp=stamp,sequence=0)
            return row
    except (OSError,ValueError,KeyError):return None

def snapshot(ids):
    live=registry();out=[]
    for sid in ids:
        if not re.fullmatch('[a-f0-9-]{36}',sid):continue
        row=dict(session_id=sid,state='unknown',timestamp=time.time(),sequence=0)
        try:
            saved=json.loads((STATE/'claude-states'/f'{sid}.json').read_text())
            if live.get(sid,{}).get('identity')==saved.get('identity'):
                row={k:saved[k] for k in row}
        except (OSError,ValueError,KeyError):pass
        if sid not in live:row['state']='unknown'  # Unloaded tasks are still selectable pins.
        elif live[sid].get('nativeState')=='busy' and row['state']!='awaiting_input':row['state']='working'
        elif row['state']=='unknown':
            event=completion_metadata(sid,live[sid]['startedAt'])
            if event:row=event
        out.append(row)
    return out

def configure(remove=False):
    import shlex
    path=Path.home()/'.claude/settings.json'
    if remove and not path.exists():return
    before=path.read_bytes() if path.exists() else b'{}';d=json.loads(before)
    command=shlex.join(['/usr/bin/env','MAB_STATE='+str(STATE),'MAB_CONFIG='+str(CONFIG),sys.executable,str(ROOT/'claude_hooks.py')])
    owned_file=STATE/'hook-command.json'
    owned={command}
    if owned_file.exists():owned.add(json.loads(owned_file.read_text())['command'])
    hooks=d.setdefault('hooks',{})
    for event in list(hooks):
        entries=[]
        for entry in hooks[event]:
            own=[h for h in entry.get('hooks',[]) if h.get('command') in owned]
            if not own:entries.append(entry);continue
            remaining=[h for h in entry['hooks'] if h not in own]
            if remaining:entries.append({**entry,'hooks':remaining})
        if entries:hooks[event]=entries
        else:del hooks[event]
    if not remove:
        for event in EVENTS:hooks.setdefault(event,[]).append({'matcher':'','hooks':[{'type':'command','command':command,'timeout':3}]})
    if not hooks:d.pop('hooks',None)
    if path.exists() and path.read_bytes()!=before:raise RuntimeError('Settings changed; retry')
    backup=STATE/'settings-before-hooks.json'
    if not remove and not backup.exists():atomic(backup,json.loads(before))
    atomic(path,d)
    if remove:owned_file.unlink(missing_ok=True)
    else:atomic(owned_file,{'command':command})
    print(json.dumps({'ownedHooksRemoved':remove,'ownedHooksInstalled':0 if remove else len(EVENTS),'otherSettingsPreserved':True}))

if __name__=='__main__':
    if '--install' in sys.argv:configure()
    elif '--remove' in sys.argv:configure(True)
    else:
        try:hook()
        except Exception:pass  # Status observers never change the provider's behavior.
