"""Owned, allowlisted status hooks. Never persist input, prompt, or tool contents."""
import hashlib, json, os, re, subprocess, sys, time
from datetime import datetime
from pathlib import Path
ROOT=Path(__file__).resolve().parent
WINDOWS=sys.platform=='win32'
if WINDOWS:import msvcrt
else:import fcntl
# Windows hook commands pass the state directory as an argument instead of env.
if '--state' in sys.argv[:-1]:os.environ['MAB_STATE']=sys.argv[sys.argv.index('--state')+1]
from paths import STATE, CONFIG
EVENTS=('SessionStart','SessionEnd','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop','StopFailure','Elicitation','ElicitationResult')
def atomic(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    tmp=path.with_name(path.name+'.'+str(os.getpid())+'.tmp')
    fd=os.open(tmp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as f:json.dump(value,f)
    os.replace(tmp,path)

def windows_inventory():
    import importlib.util
    spec=importlib.util.spec_from_file_location('windows_inventory',ROOT/'windows-inventory.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def windows_parents():
    """Parent PID map from a Toolhelp snapshot; queried once per hook."""
    import ctypes
    from ctypes import wintypes as w
    class Entry(ctypes.Structure):
        _fields_=[('dwSize',w.DWORD),('cntUsage',w.DWORD),('th32ProcessID',w.DWORD),('th32DefaultHeapID',ctypes.c_size_t),('th32ModuleID',w.DWORD),('cntThreads',w.DWORD),('th32ParentProcessID',w.DWORD),('pcPriClassBase',ctypes.c_long),('dwFlags',w.DWORD),('szExeFile',w.WCHAR*260)]
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateToolhelp32Snapshot.restype=w.HANDLE
    snap=kernel.CreateToolhelp32Snapshot(2,0)  # TH32CS_SNAPPROCESS
    if snap in (None,w.HANDLE(-1).value):return {}
    parents={};entry=Entry();entry.dwSize=ctypes.sizeof(Entry)
    try:
        ok=kernel.Process32FirstW(snap,ctypes.byref(entry))
        while ok:
            parents[entry.th32ProcessID]=entry.th32ParentProcessID
            ok=kernel.Process32NextW(snap,ctypes.byref(entry))
    finally:kernel.CloseHandle(snap)
    return parents

def registry():
    out={}
    if WINDOWS:
        inventory=windows_inventory();home=Path.home();data=inventory.default_claude_data(home)
        for sid,row in inventory.live_registry(home,data).items():
            pid,started=row['identity'].split(':')
            out[sid]={'identity':row['identity'],'pid':int(pid),'bridge':row['bridge'],'nativeState':row['nativeState'],'startedAt':0}
        return out
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

# Commands are classified in memory only; the command text is never written.
TEST=re.compile(r'''(^|[\s;&|/\\"'(])(pytest|jest|vitest|mocha|ava|tap|phpunit|rspec|ctest|unittest|nox|tox|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|mvn\s+(?:\S+\s+)*test|gradlew?\s+(?:\S+\s+)*test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S*)?|node\s+--test|deno\s+test|swift\s+test|make\s+(?:check|test))(?=$|[\s;&|"')])''',re.I)
EDIT_TOOLS=('Edit','Write','MultiEdit','NotebookEdit')
ACTIVE=('working','planning','command','testing','editing')
SHELL_TOOLS=('Bash','PowerShell')
def detail(d,state):
    """Finer activity for lighting. `state` keeps its existing meaning for other hosts."""
    event=d.get('hook_event_name');tool=d.get('tool_name');plan=d.get('permission_mode')=='plan'
    if event=='PermissionRequest':return 'approval'
    if event=='Notification':return 'approval' if d.get('notification_type')=='permission_prompt' else 'question' if state=='awaiting_input' else None
    if event=='Elicitation' or (event=='PreToolUse' and tool=='AskUserQuestion'):return 'question'
    if event=='PreToolUse':
        if tool in SHELL_TOOLS:
            command=(d.get('tool_input') or {}).get('command')
            return 'testing' if isinstance(command,str) and len(command)<=16384 and TEST.search(command) else 'command'
        if tool in EDIT_TOOLS:return 'editing'
        if tool=='ExitPlanMode' or plan:return 'planning'
    if state=='working' and plan:return 'planning'
    return state

def ancestors_of(pid):
    seen=set();parents=windows_parents() if WINDOWS else None
    for _ in range(12):
        if pid<2 or pid in seen:break
        seen.add(pid)
        if WINDOWS:pid=parents.get(pid,0)
        elif sys.platform=='linux':pid=int((Path('/proc')/str(pid)/'stat').read_text().rsplit(')',1)[1].split()[1])
        else:pid=int(subprocess.check_output(['/bin/ps','-p',str(pid),'-o','ppid='],text=True,timeout=1))
    return seen

def hook():
    d=json.load(sys.stdin);sid=d.get('session_id');state=classify(d)
    if sid not in allowed() or state is None or d.get('agent_id'):return
    live=registry().get(sid)
    if not live:return
    # Reject an invocation outside the identified Claude process ancestry.
    if live['pid'] not in ancestors_of(os.getppid()):return
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (STATE/'hooks.lock').open('a+') as lock:
        if WINDOWS:lock.seek(0);msvcrt.locking(lock.fileno(),msvcrt.LK_LOCK,1)
        else:fcntl.flock(lock,fcntl.LOCK_EX)
        path=STATE/'claude-states'/f'{sid}.json'
        try:old=json.loads(path.read_text())
        except (OSError,ValueError):old={}
        # Notification can confirm a wait without saying which kind; keep a known kind.
        fine=detail(d,state) or (old.get('detail') if old.get('state')=='awaiting_input' else 'question')
        atomic(path,dict(session_id=sid,state=state,detail=fine,timestamp=time.time(),sequence=old.get('sequence',0)+1,identity=live['identity']))

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
                row={k:saved[k] for k in row};row['detail']=saved.get('detail',saved['state'])
        except (OSError,ValueError,KeyError):pass
        if sid not in live:row['state']='unknown'  # Unloaded tasks are still selectable pins.
        elif live[sid].get('nativeState')=='busy' and row['state']!='awaiting_input':
            # Busy is authoritative for "working"; keep only an active hook detail.
            row['state']='working'
            if row.get('detail') not in ACTIVE:row['detail']='working'
        elif row['state']=='unknown':
            event=completion_metadata(sid,live[sid]['startedAt'])
            if event:row=event
        row.setdefault('detail',row['state'])
        out.append(row)
    return out

def configure(remove=False):
    import shlex
    path=Path.home()/'.claude/settings.json'
    if remove and not path.exists():return
    before=path.read_bytes() if path.exists() else b'{}';d=json.loads(before)
    if WINDOWS:
        # Forward slashes and double quotes work whether Claude runs hooks via cmd or Git Bash.
        q=lambda p:'"'+str(p).replace('\\','/')+'"'
        command=' '.join([q(sys.executable),q(ROOT/'claude_hooks.py'),'--state',q(STATE)])
    else:command=shlex.join(['/usr/bin/env','MAB_STATE='+str(STATE),'MAB_CONFIG='+str(CONFIG),sys.executable,str(ROOT/'claude_hooks.py')])
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
