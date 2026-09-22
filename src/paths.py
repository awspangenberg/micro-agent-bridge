"""Shared per-user paths. Never write inside an application or package directory."""
import json, os, sys
from pathlib import Path
HOME=Path.home()
CONFIG=Path(os.environ.get('MAB_CONFIG',str(Path(os.environ.get('XDG_CONFIG_HOME',str(HOME/'.config')))/'micro-agent-bridge/config.json')))
STATE=Path(os.environ.get('MAB_STATE',str(HOME/'Library/Application Support/Micro Agent Bridge' if sys.platform=='darwin' else Path(os.environ.get('XDG_STATE_HOME',str(HOME/'.local/state')))/'micro-agent-bridge')))
def config():
    return json.loads(CONFIG.read_text()) if CONFIG.exists() else {'version':1,'role':'observer','hosts':[]}
