"""Read only native identity/title/continuation metadata, including stopped sessions.

No message, prompt or tool bodies are parsed or retained. The index lives in memory.
"""
import json, re
from pathlib import Path

UUID = re.compile(r'^[a-f0-9-]{36}$')
META = re.compile(rb'^\{\s*"type"\s*:\s*"(bridge-session|continued-in|ai-title|custom-title)"')

class Catalog:
    def __init__(self, home=None):
        self.home = home or Path.home()
        self.files = {}

    def refresh(self):
        present = set()
        for path in (self.home / '.claude/projects').glob('*/*.jsonl'):
            if not UUID.fullmatch(path.stem):
                continue
            present.add(str(path))
            try:
                stat = path.stat()
                cached = self.files.get(str(path), {})
                if cached.get('inode') != stat.st_ino or cached.get('offset', 0) > stat.st_size:
                    cached = {'inode': stat.st_ino, 'offset': 0, 'nativeId': path.stem, 'bridges': []}
                with path.open('rb') as stream:
                    stream.seek(cached['offset'])
                    while True:
                        line = stream.readline()
                        if not line or not line.endswith(b'\n'):
                            break
                        cached['offset'] = stream.tell()
                        if len(line) > 16384 or not META.match(line):
                            continue
                        d = json.loads(line)
                        if d.get('sessionId') != path.stem:
                            continue
                        kind = d['type']
                        if kind == 'bridge-session':
                            nav = d.get('bridgeSessionId', '')
                            if nav.startswith('cse_'):
                                nav = 'session_' + nav[4:]
                            if re.fullmatch(r'session_[A-Za-z0-9]+', nav) and nav not in cached['bridges']:
                                cached['bridges'].append(nav)
                        elif kind == 'continued-in':
                            successor = d.get('continuedInSessionId', '')
                            if UUID.fullmatch(successor):
                                cached['successor'] = successor
                        else:
                            title = d.get('customTitle') or d.get('aiTitle')
                            if isinstance(title, str):
                                cached['title'] = title[:256]
                self.files[str(path)] = cached
            except (OSError, ValueError):
                continue
        self.files = {p: row for p, row in self.files.items() if p in present}

    def pins(self, requested, host, live):
        self.refresh()
        rows = {v['nativeId']: v for v in self.files.values()}
        result = []
        for nav in requested:
            current = [sid for sid, row in live.items() if row.get('bridge') == nav]
            if not current:
                historical = set()
                for sid, row in rows.items():
                    if nav not in row.get('bridges', []):
                        continue
                    visited = set()
                    while sid not in visited and rows.get(sid, {}).get('successor') in rows:
                        visited.add(sid)
                        sid = rows[sid]['successor']
                    if sid not in visited:
                        historical.add(sid)
                current = sorted(historical)
            for sid in current:
                row = rows.get(sid, {})
                result.append(dict(provider='claude', host=host, nativeId=sid, navId=nav,
                                   title=row.get('title', 'Claude task ' + nav[-8:]), archived=False))
        return result
