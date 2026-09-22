import sys, json, tempfile, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from unittest.mock import patch
import claude_hooks as hooks
class HookOwnershipTests(unittest.TestCase):
 def test_install_repeat_upgrade_remove_preserves_other_settings(self):
  with tempfile.TemporaryDirectory() as temp:
   home=Path(temp);file=home/'.claude/settings.json';file.parent.mkdir();original={'permissions':{'allow':['Read']},'hooks':{'Stop':[{'hooks':[{'type':'command','command':'echo keep'}]}]}}
   file.write_text(json.dumps(original))
   with patch.object(hooks.Path,'home',return_value=home),patch.object(hooks,'STATE',home/'state'):
    hooks.configure();hooks.configure()
    d=json.loads(file.read_text());self.assertEqual(len(d['hooks']['Stop']),2)
    hooks.configure(True);self.assertEqual(json.loads(file.read_text()),original)
if __name__=='__main__':unittest.main()
