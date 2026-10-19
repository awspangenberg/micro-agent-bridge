"""Synthetic hook payloads; no Claude settings or sessions are touched."""
import json, os, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import claude_hooks as hooks

SID = '33333333-3333-4333-8333-333333333333'


def detail(**d):
    return hooks.detail(d, hooks.classify(d))


class HookDetailTests(unittest.TestCase):
    def test_activity_categories_follow_tools_and_plan_mode(self):
        self.assertEqual(detail(hook_event_name='PreToolUse', tool_name='Bash', tool_input={'command': 'npm test -- --watch=false'}), 'testing')
        self.assertEqual(detail(hook_event_name='PreToolUse', tool_name='PowerShell', tool_input={'command': 'python -m pytest tests'}), 'testing')
        self.assertEqual(detail(hook_event_name='PreToolUse', tool_name='Bash', tool_input={'command': 'git status'}), 'command')
        self.assertEqual(detail(hook_event_name='PreToolUse', tool_name='Bash', tool_input={'command': 'cat attestation.txt'}), 'command', 'substrings are not tests')
        self.assertEqual(detail(hook_event_name='PreToolUse', tool_name='Edit'), 'editing')
        self.assertEqual(detail(hook_event_name='PreToolUse', tool_name='Read', permission_mode='plan'), 'planning')
        self.assertEqual(detail(hook_event_name='UserPromptSubmit', permission_mode='plan'), 'planning')
        self.assertEqual(detail(hook_event_name='PostToolUse', tool_name='Bash'), 'working')

    def test_user_waits_distinguish_approval_from_questions(self):
        self.assertEqual(detail(hook_event_name='PermissionRequest'), 'approval')
        self.assertEqual(detail(hook_event_name='Notification', notification_type='permission_prompt'), 'approval')
        self.assertEqual(detail(hook_event_name='PreToolUse', tool_name='AskUserQuestion'), 'question')
        self.assertEqual(detail(hook_event_name='Elicitation'), 'question')
        self.assertEqual(detail(hook_event_name='Notification', notification_type='agent_needs_input'), 'question')
        self.assertEqual(detail(hook_event_name='Stop'), 'completed')
        self.assertEqual(detail(hook_event_name='StopFailure'), 'error')

    def test_existing_state_values_are_unchanged_for_other_hosts(self):
        for d, state in (({'hook_event_name': 'PermissionRequest'}, 'awaiting_input'), ({'hook_event_name': 'PreToolUse', 'tool_name': 'Bash'}, 'working'),
                         ({'hook_event_name': 'PreToolUse', 'tool_name': 'AskUserQuestion'}, 'awaiting_input')):
            self.assertEqual(hooks.classify(d), state)

    def test_snapshot_reports_detail_and_busy_keeps_only_active_detail(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            (state / 'claude-states').mkdir()
            write = lambda **r: (state / 'claude-states' / f'{SID}.json').write_text(json.dumps({'session_id': SID, 'timestamp': 1, 'sequence': 1, 'identity': 'id', **r}))
            live = {SID: {'identity': 'id', 'nativeState': 'busy', 'startedAt': 0}}
            with patch.object(hooks, 'STATE', state), patch.object(hooks, 'registry', return_value=live):
                write(state='working', detail='testing')
                self.assertEqual(hooks.snapshot([SID])[0]['detail'], 'testing')
                write(state='completed', detail='completed')
                row = hooks.snapshot([SID])[0]
                self.assertEqual((row['state'], row['detail']), ('working', 'working'), 'busy overrides a stale completion')
                write(state='working')  # Older records without detail.
                self.assertEqual(hooks.snapshot([SID])[0]['detail'], 'working')
                live[SID]['identity'] = 'other'
                self.assertEqual(hooks.snapshot([SID])[0]['state'], 'working')

    @unittest.skipUnless(sys.platform == 'win32', 'Windows command form')
    def test_windows_hook_command_uses_quoted_forward_slash_paths_and_state_argument(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp); (home / '.claude').mkdir()
            with patch.object(hooks.Path, 'home', return_value=home), patch.object(hooks, 'STATE', home / 'state dir'):
                hooks.configure()
                command = json.loads((home / '.claude/settings.json').read_text())['hooks']['Stop'][0]['hooks'][0]['command']
                self.assertNotIn('\\', command)
                self.assertIn('--state "', command)
                self.assertTrue(command.startswith('"') and 'claude_hooks.py"' in command)
                hooks.configure(True)
                self.assertEqual(json.loads((home / '.claude/settings.json').read_text()), {})

    @unittest.skipUnless(sys.platform == 'win32', 'Windows process API')
    def test_windows_parent_map_contains_this_process(self):
        parents = hooks.windows_parents()
        self.assertEqual(parents.get(os.getpid()), os.getppid())
        self.assertIn(os.getppid(), hooks.ancestors_of(os.getppid()))


if __name__ == '__main__':
    unittest.main()
