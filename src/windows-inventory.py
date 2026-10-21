"""Read-only, local Windows pin inventory for the standalone Micro host.

Only identity, title, archive, and process-status metadata leaves this module.
It does not install hooks, change provider settings, or retain transcript bodies.
"""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3

from claude_catalog import Catalog
from pins import PIN_SECTION, claude_pin_ids

UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
BRIDGE = re.compile(r'session_[A-Za-z0-9]{1,128}')


def native_id(value):
    return value if isinstance(value, str) and UUID.fullmatch(value) else None


def navigation_id(value):
    if not isinstance(value, str):
        return None
    if BRIDGE.fullmatch(value) or (value.startswith('local_') and native_id(value[6:])):
        return value
    return None


def bridge_id(value):
    if isinstance(value, str) and value.startswith('cse_'):
        value = 'session_' + value[4:]
    return navigation_id(value)


PACKAGE = re.compile(r'claude_[a-z0-9]{1,64}', re.I)


def has_claude_data(path):
    return (path / 'IndexedDB/https_claude.ai_0.indexeddb.leveldb/CURRENT').is_file()


def default_claude_data(home):
    standard = Path(os.environ.get('APPDATA', str(home / 'AppData/Roaming'))) / 'Claude'
    local = Path(os.environ.get('LOCALAPPDATA', str(home / 'AppData/Local')))
    # The Windows app can relocate its profile to %LOCALAPPDATA%\Claude-Data\<package>,
    # leaving an empty ".user-data-left.<package>" marker in the Roaming folder.
    moved = [local / 'Claude-Data' / marker.name[len('.user-data-left.'):]
             for marker in standard.glob('.user-data-left.*')
             if PACKAGE.fullmatch(marker.name[len('.user-data-left.'):])]
    moved = [path for path in moved if has_claude_data(path)]
    if len(moved) == 1:
        return moved[0]
    packaged = [path for path in (local / 'Packages').glob('Claude_*/LocalCache/Roaming/Claude')
                if path.is_dir()]
    populated = [path for path in [standard, *packaged, *(local / 'Claude-Data').glob('claude_*')]
                 if has_claude_data(path)]
    # Do not guess an account/profile if several locations hold data.
    if len(populated) == 1:
        return populated[0]
    if standard.is_dir():
        return standard
    return packaged[0] if len(packaged) == 1 else standard


def codex_inventory(home):
    path = home / '.codex/state_5.sqlite'
    if not path.is_file():
        return []
    # as_uri quotes #, %, spaces, and Windows drive paths before adding options.
    # Do not use immutable=1: the live desktop database may have committed WAL data.
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=.5)) as db:
        columns = {row[1] for row in db.execute('PRAGMA table_info(threads)')}
        # Newer Codex builds also flag pins with is_pinned.
        pinned = ' OR is_pinned=1' if 'is_pinned' in columns else ''
        rows = db.execute(
            f'SELECT id,title,archived FROM threads WHERE thread_section_id=?{pinned} ORDER BY section_position ASC',
            (PIN_SECTION,),
        ).fetchall()
    return codex_rows(rows)


def codex_rows(rows):
    return [dict(provider='codex', host='local', hostId='local', nativeId=sid,
                 navId=sid, title=title if isinstance(title, str) else 'Codex task',
                 archived=bool(archived))
            for sid, title, archived in rows if native_id(sid)]


def codex_recent(home, limit=12):
    """Codex's own recency order (its "recent" agent-key mode), unarchived tasks only."""
    path = home / '.codex/state_5.sqlite'
    if not path.is_file():
        return []
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=.5)) as db:
        columns = {row[1] for row in db.execute('PRAGMA table_info(threads)')}
        order = next((c for c in ('recency_at_ms', 'updated_at_ms') if c in columns), 'updated_at * 1000')
        rows = db.execute(f'SELECT id,title,archived,{order} FROM threads WHERE archived=0 ORDER BY {order} DESC LIMIT ?', (limit,)).fetchall()
    return [dict(row, activity=activity or 0) for row, (*_, activity) in zip(codex_rows([r[:3] for r in rows]), rows)]


def process_info(pid):
    """Query a Windows process without executing it or reading its command line."""
    if os.name != 'nt':
        return None
    import ctypes
    from ctypes import wintypes as w

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    security = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.OpenProcess.restype = w.HANDLE
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.CloseHandle.restype = w.BOOL
    kernel.GetProcessTimes.argtypes = [w.HANDLE] + [ctypes.POINTER(w.FILETIME)] * 4
    kernel.GetProcessTimes.restype = w.BOOL
    kernel.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
    kernel.GetExitCodeProcess.restype = w.BOOL
    kernel.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
    kernel.QueryFullProcessImageNameW.restype = w.BOOL
    security.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
    security.OpenProcessToken.restype = w.BOOL
    security.GetTokenInformation.argtypes = [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD)]
    security.GetTokenInformation.restype = w.BOOL
    security.EqualSid.argtypes = [w.LPVOID, w.LPVOID]
    security.EqualSid.restype = w.BOOL

    process = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not process:
        return None
    tokens = []
    try:
        creation, exit_time, kernel_time, user_time = (w.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(process, ctypes.byref(creation), ctypes.byref(exit_time), ctypes.byref(kernel_time), ctypes.byref(user_time)):
            return None
        exit_code = w.DWORD()
        if not kernel.GetExitCodeProcess(process, ctypes.byref(exit_code)) or exit_code.value != 259:
            return None
        capacity = w.DWORD(32768)
        executable = ctypes.create_unicode_buffer(capacity.value)
        if not kernel.QueryFullProcessImageNameW(process, 0, executable, ctypes.byref(capacity)):
            return None
        users = []
        for handle in (process, kernel.GetCurrentProcess()):
            token = w.HANDLE()
            if not security.OpenProcessToken(handle, 0x0008, ctypes.byref(token)):  # TOKEN_QUERY
                return None
            tokens.append(token)
            required = w.DWORD()
            security.GetTokenInformation(token, 1, None, 0, ctypes.byref(required))  # TokenUser
            if not 0 < required.value <= 65536:
                return None
            user = ctypes.create_string_buffer(required.value)
            if not security.GetTokenInformation(token, 1, user, required.value, ctypes.byref(required)):
                return None
            users.append(user)
        same_user = bool(security.EqualSid(ctypes.c_void_p.from_buffer(users[0]).value,
                                          ctypes.c_void_p.from_buffer(users[1]).value))
        started = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
        return {'procStart': str(started), 'executable': executable.value, 'sameUser': same_user}
    finally:
        for token in tokens:
            kernel.CloseHandle(token)
        kernel.CloseHandle(process)


def trusted_claude_executable(executable, home, claude_data):
    if not isinstance(executable, str):
        return False
    path = Path(executable)
    if not path.is_absolute() or path.name.lower() != 'claude.exe':
        return False
    roots = [claude_data / 'claude-code', home / 'AppData/Roaming/Claude/claude-code',
             home / '.local/bin', home / '.local/share/claude/versions',
             home / '.claude/versions', home / '.claude/remote/ccd-cli']
    path = path.resolve()
    return any(path.is_relative_to(root.resolve()) for root in roots)


def live_registry(home, claude_data):
    live, ambiguous = {}, set()
    for path in (home / '.claude/sessions').glob('*.json'):
        try:
            if path.stat().st_size > 65536:
                continue
            data = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(data, dict):
                continue
            sid, pid, started = native_id(data.get('sessionId')), data.get('pid'), data.get('procStart')
            if not sid or type(pid) is not int or not 0 < pid <= 0xffffffff:
                continue
            if not isinstance(started, str) or not re.fullmatch(r'[0-9]{1,20}', started):
                continue
            info = process_info(pid)
            if not info or info.get('sameUser') is not True or info.get('procStart') != started:
                continue
            if not trusted_claude_executable(info.get('executable'), home, claude_data):
                continue
            row = {'bridge': bridge_id(data.get('bridgeSessionId')), 'nativeState': data.get('status'),
                   'identity': f'{pid}:{started}', 'activity': path.stat().st_mtime * 1000}
            if sid in live and live[sid]['identity'] != row['identity']:
                ambiguous.add(sid)
            live[sid] = row
        except (OSError, ValueError, TypeError, OverflowError):
            continue
    return {sid: row for sid, row in live.items() if sid not in ambiguous}


def local_metadata(base, errors):
    rows, remote = [], set()
    for path in (base / 'claude-code-sessions').glob('*/*/local_*.json'):
        try:
            if path.stat().st_size > 8 * 1024 * 1024:
                raise ValueError('Oversized metadata')
            data = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(data, dict):
                raise ValueError('Unsupported metadata')
            nav = navigation_id(data.get('sessionId'))
            if not nav or nav != path.stem:
                raise ValueError('Invalid navigation identity')
            bridges = data.get('bridgeSessionIds', [])
            if not isinstance(bridges, list):
                bridges = []
            ids = {nav, *(value for item in bridges if (value := bridge_id(item)))}
            if data.get('sshConfig'):
                remote.update(ids)
                continue
            title = data.get('title')
            activity = data.get('lastActivityAt')
            rows.append({'nativeId': native_id(data.get('cliSessionId')), 'ids': ids, 'nav': nav,
                         'title': title[:256] if isinstance(title, str) else 'Claude task',
                         'archived': bool(data.get('isArchived')),
                         'activity': activity if isinstance(activity, (int, float)) else 0})
        except (OSError, ValueError, TypeError):
            errors['claude'] = 'session-metadata-unavailable'
    return rows, remote


ACTIVE = ('working', 'planning', 'command', 'testing', 'editing')
WAITS = ('approval', 'question')
FINAL = ('completed', 'error')


def hook_detail(state_dir, sid, live):
    """Lighting detail from the owned hooks, trusted only for the same live process."""
    row = live.get(sid)
    if not row:
        return 'unknown'
    busy = row.get('nativeState') == 'busy'
    saved = {}
    if state_dir is not None:
        try:
            path = Path(state_dir) / 'claude-states' / f'{sid}.json'
            if path.stat().st_size <= 65536:
                saved = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            saved = {}
    fine = saved.get('detail') if isinstance(saved, dict) and saved.get('identity') == row['identity'] else None
    if fine in WAITS:
        return fine
    if row.get('nativeState') == 'waiting':
        return 'awaiting_input'
    if busy:
        return fine if fine in ACTIVE else 'working'
    return fine if fine in FINAL else 'unknown'


def claude_inventory(home, base, errors, state_dir=None, recent_limit=0):
    """Pinned Claude tasks, and with recent_limit the most recently active local tasks."""
    pins = list(dict.fromkeys(pin for pin in claude_pin_ids(
        base / 'IndexedDB/https_claude.ai_0.indexeddb.leveldb') if navigation_id(pin)))
    metadata, remote = local_metadata(base, errors)
    live = live_registry(home, base)
    # Recent: desktop sessions by their last activity, plus running terminal sessions that
    # Claude lists through Remote Control (navigable by their bridge ID).
    candidates = [(r['activity'], r['nav']) for r in metadata if not r['archived']]
    owned = {i for r in metadata for i in r['ids']}
    candidates += [(row['activity'], row['bridge']) for row in live.values() if row.get('bridge') and row['bridge'] not in owned]
    ordered = sorted(candidates, key=lambda c: -c[0])
    recent_navs = list(dict.fromkeys(nav for _, nav in ordered))[:recent_limit]
    activity = {}
    for when, nav in ordered: activity.setdefault(nav, when)
    mappings = Catalog(home).pins(list(dict.fromkeys(pins + recent_navs)), 'local', live)
    pinned = [row for nav in pins if nav not in remote
              if (row := claude_row(nav, metadata, mappings, live, state_dir))]
    recent = [dict(claude_row(nav, metadata, mappings, live, state_dir), activity=activity[nav]) for nav in recent_navs]
    return pinned, recent


def claude_row(nav, metadata, mappings, live, state_dir):
    if True:
        matches = [row for row in metadata if nav in row['ids']]
        meta = matches[0] if len(matches) == 1 else {}
        mapped = [row for row in mappings if row['navId'] == nav and native_id(row.get('nativeId'))]
        # Catalog resolves validated live mappings before historical continuations.
        # Multiple plausible sessions remain unknown rather than picking one by order.
        mapped_ids = {row['nativeId'] for row in mapped}
        sid = next(iter(mapped_ids)) if len(mapped_ids) == 1 else None
        if not mapped_ids:
            sid = meta.get('nativeId')
        title = meta.get('title')
        if not title and len(mapped_ids) == 1:
            title = mapped[0].get('title')
        # Claude keeps stars on Remote Control sessions after they end but hides them. A bridge
        # pin is shown only when a local session or running process owns it; otherwise it is a
        # remote candidate, shown only while another machine reports it live.
        remote_candidate = (nav.startswith('session_') and not meta and
                            not (sid and live.get(sid, {}).get('bridge') == nav))
        if remote_candidate:
            sid = None
        row = dict(provider='claude', host='local', nativeId=sid, navId=nav,
                   title=title or 'Claude task ' + nav[-8:],
                   archived=meta.get('archived', False),
                   state={'busy': 'working', 'waiting': 'awaiting_input'}.get(live.get(sid, {}).get('nativeState'), 'unknown'))
        if remote_candidate:
            row['remoteCandidate'] = True
        if state_dir is not None:
            row['detail'] = hook_detail(state_dir, sid, live) if sid else 'unknown'
            # Bridge IDs let task-bound actions match the session in Claude's window URL.
            bridges = {i for i in meta.get('ids', set()) if i.startswith('session_')}
            if live.get(sid, {}).get('bridge'):
                bridges.add(live[sid]['bridge'])
            row['bridges'] = sorted(bridges)[:16]
        return row


def inventory(home=None, claude_data=None, state_dir=None, recent=12):
    home = Path(home) if home is not None else Path.home()
    base = Path(claude_data) if claude_data is not None else default_claude_data(home)
    result = {'codex': [], 'claude': [], 'codexRecent': [], 'claudeRecent': [], 'errors': {}}
    try:
        result['codex'] = codex_inventory(home)
        result['codexRecent'] = codex_recent(home, recent)
    except (OSError, sqlite3.Error, ValueError):
        result['errors']['codex'] = 'pin-metadata-unavailable'
    try:
        result['claude'], result['claudeRecent'] = claude_inventory(home, base, result['errors'], state_dir, recent)
    except (OSError, ValueError, TypeError, KeyError, IndexError):
        result['errors']['claude'] = 'pin-metadata-unavailable'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home(), help='User profile directory')
    parser.add_argument('--claude-data', type=Path, help='Claude data directory (default: %%APPDATA%%/Claude, then a single Store profile)')
    parser.add_argument('--state', type=Path, help='Host state directory holding owned hook records')
    parser.add_argument('--json', action='store_true', help='Emit JSON (the default)')
    args = parser.parse_args()
    # ASCII escaping keeps redirected Windows stdout valid in every console code page.
    print(json.dumps(inventory(args.home, args.claude_data, args.state)))


if __name__ == '__main__':
    main()
