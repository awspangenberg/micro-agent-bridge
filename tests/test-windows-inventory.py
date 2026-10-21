"""Synthetic, read-only inventory fixtures; no desktop session data is needed."""
import importlib.util
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'src/windows-inventory.py'
sys.path.insert(0, str(ROOT / 'src'))
SID_A = '11111111-1111-4111-8111-111111111111'
SID_B = '22222222-2222-4222-8222-222222222222'
SID_C = '33333333-3333-4333-8333-333333333333'
PIN_SECTION = '01984de2-8f74-7c91-a3b2-5c5e937cf318'


def varint(n):
    data = bytearray()
    while n >= 128:
        data.append((n & 127) | 128)
        n >>= 7
    data.append(n)
    return bytes(data)


def log_record(data):
    return bytes(4) + struct.pack('<HB', len(data), 1) + data


class WindowsInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # URI metacharacters must remain filename characters in SQLite's ro URI.
        self.home = Path(self.temp.name) / 'home # % encoded'
        self.home.mkdir()
        self.claude = self.home / 'Claude data'
        self.assertTrue(SCRIPT.is_file(), 'Windows inventory adapter is not implemented')
        spec = importlib.util.spec_from_file_location('windows_inventory', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def codex_db(self, rows):
        path = self.home / '.codex/state_5.sqlite'
        path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(path)) as db, db:
            db.execute('CREATE TABLE threads (id TEXT, title TEXT, archived INTEGER, thread_section_id TEXT, section_position INTEGER)')
            db.executemany('INSERT INTO threads VALUES (?,?,?,?,?)', rows)
        return path

    def pins(self, ids, databases=(4,)):
        root = self.claude / 'IndexedDB/https_claude.ai_0.indexeddb.leveldb'
        root.mkdir(parents=True, exist_ok=True)
        (root / 'CURRENT').write_text('MANIFEST-000001\n', encoding='utf-8')
        (root / 'MANIFEST-000001').write_bytes(log_record(b'\x02\x01'))
        data = json.dumps({'state': {'starredIds': ids}}).encode('ascii')
        value = b'\xff\x0f\x22' + varint(len(data)) + data
        records = b''
        for sequence, database in enumerate(databases, 1):
            key = bytes([0, database, 1, 1, 1, 0x23]) + 'store:pin-state:dframe-starred-code'.encode('utf-16be')
            # The exists-entry index (2) carries the same key text but no pin value.
            exists = bytes([0, database, 1, 2]) + key[4:]
            batch = struct.pack('<QI', sequence * 2, 2) + b'\x01' + varint(len(exists)) + exists + b'\x01\x00'
            batch += b'\x01' + varint(len(key)) + key + varint(len(value)) + value
            records += log_record(batch)
        (root / '000001.log').write_bytes(records)

    def metadata(self, sid, nav=None, **fields):
        nav = nav or 'local_' + sid
        path = self.claude / 'claude-code-sessions/account/project' / (nav + '.json')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'sessionId': nav, 'cliSessionId': sid, 'title': 'Local task', 'isArchived': False, **fields}), encoding='utf-8')
        return path

    def catalog(self, sid, rows):
        path = self.home / '.claude/projects/project' / (sid + '.jsonl')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(json.dumps({**row, 'sessionId': sid}) + '\n' for row in rows), encoding='utf-8')

    def registry(self, sid, **fields):
        path = self.home / '.claude/sessions' / (sid + '.json')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'pid': 42, 'sessionId': sid, 'procStart': '134367361104072606', 'startedAt': 1792262511187, 'status': 'busy', 'bridgeSessionId': 'session_live', **fields}), encoding='utf-8')

    def inventory(self):
        return self.module.inventory(self.home, self.claude)

    def test_codex_keeps_sidebar_order_and_uses_a_read_only_uri(self):
        path = self.codex_db([
            (SID_A, 'Last', 0, PIN_SECTION, 2),
            (SID_B, 'First', 0, PIN_SECTION, 0),
            (SID_C, 'Archived', 1, PIN_SECTION, 1),
            ('not-an-id', 'Invalid', 0, PIN_SECTION, -1),
            ('44444444-4444-4444-8444-444444444444', 'Unpinned', 0, None, 0),
        ])
        before = path.read_bytes()
        rows = self.inventory()['codex']
        self.assertEqual([row['nativeId'] for row in rows], [SID_B, SID_C, SID_A])
        self.assertEqual(rows[0], {'provider': 'codex', 'host': 'local', 'hostId': 'local', 'nativeId': SID_B, 'navId': SID_B, 'title': 'First', 'archived': False})
        self.assertTrue(rows[1]['archived'])
        self.assertEqual(path.read_bytes(), before)

    def test_starred_metadata_preserves_pin_order_and_omits_private_fields(self):
        self.pins(['local_' + SID_B, 'local_' + SID_A])
        self.metadata(SID_A, title='Task A', promptAppendSnapshot={'text': 'PRIVATE PROMPT'}, enabledMcpTools={'tool': 'PRIVATE TOOL'})
        self.metadata(SID_B, title='Task B', isArchived=True)
        rows = self.inventory()['claude']
        self.assertEqual([row['nativeId'] for row in rows], [SID_B, SID_A])
        self.assertTrue(rows[0]['archived'])
        self.assertEqual(rows[1]['state'], 'unknown')
        self.assertEqual(rows[1]['title'], 'Task A')
        self.assertNotIn('PRIVATE', json.dumps(rows))
        self.assertEqual(set(rows[1]), {'provider', 'host', 'nativeId', 'navId', 'title', 'archived', 'state'})

    def test_pin_record_is_found_in_a_profile_specific_database_id(self):
        self.pins(['local_' + SID_A], databases=(5,))
        self.metadata(SID_A, title='Task A')
        result = self.inventory()
        self.assertNotIn('claude', result['errors'])
        self.assertEqual([row['nativeId'] for row in result['claude']], [SID_A])

    def test_pin_records_in_multiple_databases_are_refused_as_ambiguous(self):
        self.pins(['local_' + SID_A], databases=(4, 5))
        from pins import claude_pin_ids
        with self.assertRaisesRegex(ValueError, 'Ambiguous pin databases'):
            claude_pin_ids(self.claude / 'IndexedDB/https_claude.ai_0.indexeddb.leveldb')
        self.assertEqual(self.inventory()['errors']['claude'], 'pin-metadata-unavailable')

    def test_missing_and_invalid_native_ids_remain_selectable_unknown_pins(self):
        self.pins(['session_unmapped', 'local_' + SID_A])
        self.metadata('../../escape', nav='local_' + SID_A)
        rows = self.inventory()['claude']
        self.assertEqual([row['navId'] for row in rows], ['session_unmapped', 'local_' + SID_A])
        self.assertEqual([row['nativeId'] for row in rows], [None, None])
        self.assertEqual([row['state'] for row in rows], ['unknown', 'unknown'])

    def test_invalid_duplicate_and_explicit_remote_pins_are_excluded(self):
        self.pins(['session_good', 'session_good', 'local_' + SID_B, '../../escape', 'session_bad?x', 'local_unsafe'])
        self.metadata(SID_A, bridgeSessionIds=['session_good'])
        self.metadata(SID_B, sshConfig={'sshHost': 'remote'})
        rows = self.inventory()['claude']
        self.assertEqual([row['navId'] for row in rows], ['session_good'])
        self.assertEqual(rows[0]['nativeId'], SID_A)

    def test_catalog_continuation_resolves_stopped_tasks_without_transcript_output(self):
        self.pins(['session_history'])
        self.catalog(SID_A, [{'type': 'bridge-session', 'bridgeSessionId': 'cse_history'}, {'type': 'continued-in', 'continuedInSessionId': SID_B}])
        self.catalog(SID_B, [{'type': 'ai-title', 'aiTitle': 'Continued task'}, {'type': 'user', 'message': 'PRIVATE PROMPT'}, {'type': 'tool', 'body': 'PRIVATE TOOL'}])
        rows = self.inventory()['claude']
        # The history names the task, but no local session or process owns the bridge pin any
        # more, so Claude hides it: it stays a remote candidate with no local session.
        self.assertEqual(rows[0]['title'], 'Continued task')
        self.assertEqual(rows[0]['state'], 'unknown')
        self.assertIs(rows[0]['remoteCandidate'], True)
        self.assertIsNone(rows[0]['nativeId'])
        self.assertNotIn('PRIVATE', json.dumps(rows))

    def test_ambiguous_catalog_ids_do_not_select_an_arbitrary_session(self):
        self.pins(['session_ambiguous'])
        for sid in (SID_A, SID_B):
            self.catalog(sid, [{'type': 'bridge-session', 'bridgeSessionId': 'session_ambiguous'}])
        self.assertIsNone(self.inventory()['claude'][0]['nativeId'])

    def test_validated_busy_process_overrides_history_but_idle_never_completes(self):
        self.pins(['session_live'])
        self.catalog(SID_A, [{'type': 'bridge-session', 'bridgeSessionId': 'cse_live'}])
        self.registry(SID_B)
        info = {'procStart': '134367361104072606', 'executable': str(self.claude / 'claude-code/2.1.299/hash/claude.exe'), 'sameUser': True}
        with patch.object(self.module, 'process_info', return_value=info):
            row = self.inventory()['claude'][0]
            self.assertEqual((row['nativeId'], row['state']), (SID_B, 'working'))
            self.registry(SID_B, status='idle')
            self.assertEqual(self.inventory()['claude'][0]['state'], 'unknown')

    def test_hook_detail_requires_live_identity_and_never_reports_stale_activity(self):
        state = self.home / 'host state'
        (state / 'claude-states').mkdir(parents=True)
        record = lambda **r: (state / 'claude-states' / f'{SID_A}.json').write_text(json.dumps({'session_id': SID_A, 'identity': '42:134367361104072606', **r}), encoding='utf-8')
        live = {SID_A: {'identity': '42:134367361104072606', 'nativeState': 'busy'}}
        record(state='working', detail='testing')
        self.assertEqual(self.module.hook_detail(state, SID_A, live), 'testing')
        record(state='awaiting_input', detail='approval')
        self.assertEqual(self.module.hook_detail(state, SID_A, live), 'approval')
        record(state='working', detail='editing')
        live[SID_A]['nativeState'] = 'idle'
        self.assertEqual(self.module.hook_detail(state, SID_A, live), 'unknown', 'activity without a busy process is stale')
        record(state='completed', detail='completed')
        self.assertEqual(self.module.hook_detail(state, SID_A, live), 'completed')
        live[SID_A]['nativeState'] = 'waiting'
        record(state='working', detail='editing')
        self.assertEqual(self.module.hook_detail(state, SID_A, live), 'awaiting_input', 'a waiting process needs the user')
        live[SID_A]['nativeState'] = 'idle'
        record(state='completed', detail='completed', identity='42:other')
        self.assertEqual(self.module.hook_detail(state, SID_A, live), 'unknown', 'a reused PID never inherits a record')
        self.assertEqual(self.module.hook_detail(state, SID_B, live), 'unknown')

    def test_inventory_adds_detail_only_when_a_state_directory_is_given(self):
        self.pins(['local_' + SID_A])
        self.metadata(SID_A)
        self.assertNotIn('detail', self.inventory()['claude'][0])
        self.metadata(SID_A, bridgeSessionIds=['cse_bridged', '../bad'])
        row = self.module.inventory(self.home, self.claude, self.home / 'missing-state')['claude'][0]
        self.assertEqual(row['detail'], 'unknown')
        self.assertEqual(row['bridges'], ['session_bridged'])

    def test_reused_pid_foreign_user_and_untrusted_executables_cannot_report_working(self):
        self.pins(['local_' + SID_A])
        self.metadata(SID_A)
        self.registry(SID_A)
        trusted = {'procStart': '134367361104072606', 'executable': str(self.claude / 'claude-code/version/hash/claude.exe'), 'sameUser': True}
        for changes in ({'procStart': 'other'}, {'sameUser': False}, {'executable': str(self.home / 'Downloads/claude.exe')}, {'executable': str(self.claude / 'claude-code/version/hash/python.exe')}):
            with self.subTest(changes=changes), patch.object(self.module, 'process_info', return_value={**trusted, **changes}):
                self.assertEqual(self.inventory()['claude'][0]['state'], 'unknown')

    def test_source_error_is_bounded_and_does_not_hide_other_provider(self):
        self.codex_db([(SID_A, 'Codex task', 0, PIN_SECTION, 0)])
        self.pins(['local_' + SID_B])
        self.metadata(SID_B).write_text('PRIVATE BROKEN JSON', encoding='utf-8')
        result = self.inventory()
        self.assertEqual(result['codex'][0]['nativeId'], SID_A)
        self.assertIsNone(result['claude'][0]['nativeId'])
        self.assertIn('claude', result['errors'])
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_cli_accepts_fixture_paths_and_emits_one_json_document_without_writes(self):
        self.pins(['local_' + SID_A])
        self.metadata(SID_A, title='Unicode task \u2713')
        before = {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
        completed = subprocess.run([sys.executable, str(SCRIPT), '--home', str(self.home), '--claude-data', str(self.claude), '--json'], capture_output=True, text=True, encoding='utf-8', timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual(set(result), {'codex', 'claude', 'codexRecent', 'claudeRecent', 'errors'})
        self.assertEqual(result['claude'][0]['title'], 'Unicode task \u2713')
        self.assertEqual(completed.stderr, '')
        after = {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
        self.assertEqual(after, before)

    def test_default_claude_data_uses_appdata_and_missing_home_is_not_created(self):
        missing = self.home / 'missing'
        with patch.dict(os.environ, {'APPDATA': str(self.home / 'roaming'), 'LOCALAPPDATA': str(self.home / 'local')}):
            self.assertEqual(self.module.default_claude_data(self.home), self.home / 'roaming/Claude')
        result = self.module.inventory(missing, missing / 'Claude')
        self.assertEqual(result['codex'], [])
        self.assertEqual(result['claude'], [])
        self.assertFalse(missing.exists())

    def test_default_claude_data_discovers_one_packaged_root_and_prefers_standard_root(self):
        standard = self.home / 'roaming/Claude'
        packaged = self.home / 'local/Packages/Claude_fixture/LocalCache/Roaming/Claude'
        packaged.mkdir(parents=True)
        with patch.dict(os.environ, {'APPDATA': str(self.home / 'roaming'), 'LOCALAPPDATA': str(self.home / 'local')}):
            self.assertEqual(self.module.default_claude_data(self.home), packaged)
            standard.mkdir(parents=True)
            self.assertEqual(self.module.default_claude_data(self.home), standard)

    def test_default_claude_data_follows_relocated_profile_marker_and_populated_root(self):
        standard = self.home / 'roaming/Claude'
        standard.mkdir(parents=True)
        moved = self.home / 'local/Claude-Data/claude_fixture'
        (moved / 'IndexedDB/https_claude.ai_0.indexeddb.leveldb').mkdir(parents=True)
        (moved / 'IndexedDB/https_claude.ai_0.indexeddb.leveldb/CURRENT').write_text('MANIFEST-000001\n', encoding='utf-8')
        env = {'APPDATA': str(self.home / 'roaming'), 'LOCALAPPDATA': str(self.home / 'local')}
        with patch.dict(os.environ, env):
            # Only one location holds data, even without the marker.
            self.assertEqual(self.module.default_claude_data(self.home), moved)
            (standard / '.user-data-left.claude_fixture').write_text('', encoding='utf-8')
            self.assertEqual(self.module.default_claude_data(self.home), moved)
            # A marker naming a path outside Claude-Data is never followed.
            (standard / '.user-data-left.claude_fixture').unlink()
            (standard / '.user-data-left.claude_..').write_text('', encoding='utf-8')
            (standard / 'IndexedDB/https_claude.ai_0.indexeddb.leveldb').mkdir(parents=True)
            (standard / 'IndexedDB/https_claude.ai_0.indexeddb.leveldb/CURRENT').write_text('x', encoding='utf-8')
            # Two populated locations without a valid marker fall back to the standard root.
            self.assertEqual(self.module.default_claude_data(self.home), standard)

    @unittest.skipUnless(os.name == 'nt', 'Windows process API')
    def test_windows_process_probe_returns_same_user_identity_and_rejects_missing_pid(self):
        result = self.module.process_info(os.getpid())
        self.assertTrue(result['sameUser'])
        self.assertTrue(result['procStart'].isdigit())
        self.assertEqual(Path(result['executable']).resolve(), Path(sys.executable).resolve())
        self.assertIsNone(self.module.process_info(0))


if __name__ == '__main__':
    unittest.main()
