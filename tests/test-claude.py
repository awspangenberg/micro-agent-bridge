import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
import json, tempfile, unittest, time
from datetime import datetime,timezone
from pathlib import Path
from unittest.mock import patch
from claude_catalog import Catalog
from claude_hooks import completion_metadata

class NativeMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name);self.project=self.home/'.claude/projects/project'
        self.project.mkdir(parents=True)
        self.old='11111111-1111-1111-1111-111111111111';self.new='22222222-2222-2222-2222-222222222222'
    def write(self,sid,rows):
        with (self.project/(sid+'.jsonl')).open('a') as f:
            for row in rows:f.write(json.dumps({**row,'sessionId':sid})+'\n')
    def test_stopped_pin_follows_native_continuation_without_live_process(self):
        self.write(self.old,[{'type':'bridge-session','bridgeSessionId':'cse_abc'}, {'type':'continued-in','continuedInSessionId':self.new}])
        self.write(self.new,[{'type':'ai-title','aiTitle':'Duplicate title'}, {'type':'user','message':'private sentinel'}])
        catalog=Catalog(self.home)
        pins=catalog.pins(['session_abc'],'server-a',{})
        self.assertEqual(pins[0]['nativeId'],self.new)
        self.assertEqual(pins[0]['title'],'Duplicate title')
        self.assertNotIn('private sentinel',json.dumps(catalog.files))
        self.assertEqual(catalog.pins([],'server-a',{}),[])
    def test_live_mapping_overrides_historical_native_id(self):
        self.write(self.old,[{'type':'bridge-session','bridgeSessionId':'cse_abc'}])
        self.assertEqual(Catalog(self.home).pins(['session_abc'],'local',{self.new:{'bridge':'session_abc'}})[0]['nativeId'],self.new)
    def test_only_real_unblocked_stop_after_current_process_start_can_restore_green(self):
        event={'type':'system','subtype':'stop_hook_summary','timestamp':datetime.fromtimestamp(time.time()-10,timezone.utc).isoformat(),'preventedContinuation':False,'hookErrors':[]}
        with patch('claude_hooks.Path.home',return_value=self.home):
            self.write(self.new,[event]);self.assertEqual(completion_metadata(self.new,time.time()-100)['state'],'completed')
            self.assertIsNone(completion_metadata(self.new,time.time()+100))
            self.write(self.new,[{'type':'user','message':'new turn'}]);self.assertIsNone(completion_metadata(self.new,time.time()-100))
            self.write(self.new,[{**event,'preventedContinuation':True}]);self.assertIsNone(completion_metadata(self.new,time.time()-100))
            self.write(self.new,[event,{'type':'system','subtype':'api_error'}]);self.assertIsNone(completion_metadata(self.new,time.time()-100))

if __name__=='__main__':unittest.main()
