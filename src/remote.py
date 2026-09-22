"""One SSH child: read-only pin metadata plus allowlisted hook states."""
import json, select, sys, time
from pathlib import Path
from pins import codex_pins, codex_presence
from claude_hooks import atomic, snapshot, registry, STATE
from claude_catalog import Catalog
catalog=Catalog()
ids=[];codex_ids=[];desktop_ids=[];sequence=0;last_input=time.monotonic()
while True:
    ready,_,_=select.select([sys.stdin],[],[],1)
    if ready:
        line=sys.stdin.readline(1048577)
        if len(line)>1048576:break
        if not line:break
        try:
            request=json.loads(line)
            if request.get('protocol')!=1:raise ValueError('Unsupported protocol')
            ids=request['ids'];codex_ids=request.get('codexIds',[]);desktop_ids=request.get('desktopIds',[])
            if any(not isinstance(v,list) or len(v)>1000 or any(not isinstance(x,str) or len(x)>512 for x in v) for v in (ids,codex_ids,desktop_ids)):raise ValueError('Invalid identifier list')
            last_input=time.monotonic()
            atomic(STATE/'claude-allowlist.json',{'ids':ids,'timestamp':time.time()})
        except (ValueError,KeyError):break
    if time.monotonic()-last_input>15:break
    sequence+=1
    try:pins=codex_pins(Path.home(),'local');presence=codex_presence(Path.home(),codex_ids);error=None
    except Exception as e:pins=None;presence=None;error=str(e)
    mappings=catalog.pins(desktop_ids,'local',registry())
    print(json.dumps({'protocol':1,'timestamp':time.time(),'sequence':sequence,'codex':pins,'codexPresence':presence,'pinError':error,'mappings':mappings,'sessions':snapshot(ids)}),flush=True)
