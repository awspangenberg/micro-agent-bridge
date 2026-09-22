"""GNOME tray/window and AT-SPI task binding. No global key injection."""
import json, os, sys, time
from pathlib import Path
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk, GLib, Gio
import pyatspi
try:
    gi.require_version('AyatanaAppIndicator3','0.1')
    from gi.repository import AyatanaAppIndicator3 as Indicator
except (ImportError,ValueError):
    Indicator=None
STATE=Path(sys.argv[1]); task=None; bound=None; buffer=''; generation=0
CONTROLS=['FAST','Approve','Reject','SPLIT','Microphone','NEW','Dial','Joystick plan','Joystick back','Joystick forward','Joystick sidebar']

def emit(**row):print(json.dumps(row),flush=True)
def nodes(root):
    queue=[root];i=0;end=time.monotonic()+.5
    while i<len(queue) and i<3000 and time.monotonic()<end:
        n=queue[i];i+=1;yield n
        try:queue.extend(n)
        except Exception:pass

def uri(n):
    try:
        d=n.queryDocument()
        for key in ('DocURL','URI','URL','doc-url'):
            value=d.getAttributeValue(key)
            if value:return value
    except Exception:pass
    try:
        for a in n.getAttributes():
            if a.startswith(('doc-url:','url:','uri:')):return a.split(':',1)[1]
    except Exception:pass
    return ''

def exact(value,t):
    from urllib.parse import urlparse,parse_qs
    try:
        u=urlparse(value);q=parse_qs(u.query)
        if t['provider']=='claude':return u.path.rstrip('/').endswith('/'+t['navId']) or q.get('session')==[t['navId']]
        return u.path.rstrip('/').endswith('/'+t['nativeId']) and q.get('hostId')==[t['hostId']]
    except Exception:return False

def active_binding(t):
    for application in pyatspi.Registry.getDesktop(0):
        # Inspect only the exact configured executable, not a title match.
        try:
            from paths import config
            c=config();expected=c.get('linuxPackages',{}).get(t['provider'],{}).get('executable')
            pid=application.get_process_id()
            if not expected or Path('/proc',str(pid),'exe').resolve()!=Path(expected).resolve():continue
            for window in application:
                if not window.getState().contains(pyatspi.STATE_ACTIVE):continue
                docs=[n for n in nodes(window) if exact(uri(n),t)]
                if len(docs)==1:return (pid,window,docs[0])
        except Exception:continue
    return None

def revoke(reason):
    global bound,generation
    was=bound is not None;bound=None;generation+=1
    if was:emit(event='revoked',reason=reason)

def valid():
    if bound is None or task is None:return False
    current=active_binding(task)
    return current is not None and current[0]==bound[0] and current[1]==bound[1] and current[2]==bound[2]

def select(t):
    global task,bound
    from urllib.parse import quote,urlencode
    revoke('selection');task=t
    if t['provider']=='codex':url='codex://threads/'+quote(t['nativeId'],safe='')+'?'+urlencode({'hostId':t['hostId']})
    elif t['navId'].startswith('local_'):url='claude://code/continue?'+urlencode({'session':t['navId']})
    else:url='claude://code/'+quote(t['navId'],safe='')
    Gio.AppInfo.launch_default_for_uri(url,None)
    epoch=generation;attempt=[0]
    def bind():
        global bound
        if generation!=epoch:return False
        bound=active_binding(t);attempt[0]+=1
        if bound or attempt[0]>=5:
            emit(event='selection',armed=bound is not None,reason='Exact task selected' if bound else 'Exact foreground task unavailable; actions disabled',controls=[],unavailable=CONTROLS)
            return False
        return True
    GLib.timeout_add(400,bind)

def action(x):
    if x.get('act')!=1 or x.get('layer')!=3 or task.get('keyboardLayer')!=3 or not valid():return
    names={'ACT14':['Allow once','Approve once','Allow this time'],'ACT15':['Reject','Deny'],'ACT19':['New task','New session'],'ACT04':['Back'],'ACT05':['Forward'],'ACT20':['Hide sidebar','Show sidebar']}.get(x.get('key'),[])
    controls=[n for n in nodes(bound[2]) if n.name in names and n.getRole()==pyatspi.ROLE_PUSH_BUTTON and n.getState().contains(pyatspi.STATE_ENABLED)]
    if len(controls)!=1 or not valid():return
    a=controls[0].queryAction();indices=[i for i in range(a.nActions) if a.getName(i) in ('click','press')]
    if len(indices)!=1:return
    emit(event='action',control=x['key'],performed=bool(a.doAction(indices[0])))
    if x['key'] in ('ACT19','ACT04','ACT05'):revoke('navigation')

def read(fd,condition):
    global buffer
    b=os.read(fd,8192)
    if not b:Gtk.main_quit();return False
    buffer+=b.decode()
    if len(buffer)>65536:Gtk.main_quit();return False
    while '\n' in buffer:
        line,buffer=buffer.split('\n',1)
        try:
            x=json.loads(line)
            if x['command']=='invalidate':revoke(x.get('reason','invalidated'))
            elif x['command']=='select':select(x['task'])
            elif x['command']=='action' and task:action(x)
        except Exception:revoke('unavailable')
    return True

def item(menu,text,callback=None):
    i=Gtk.MenuItem(label=text);i.set_sensitive(callback is not None)
    if callback:i.connect('activate',callback)
    menu.append(i)

def refresh():
    if bound and not valid():revoke('focus-or-task-changed')
    try:s=json.loads((STATE/'state.json').read_text())
    except Exception:s={}
    for child in menu.get_children():menu.remove(child)
    item(menu,'Micro Agent Bridge · '+str((s.get('connection') or {}).get('status','disconnected')))
    for layer,key,name in [(2,'claudeSlots','Claude'),(3,'slots','Mixed')]:
        item(menu,'Layer '+str(layer)+' · '+name)
        for i,t in enumerate(s.get(key,[None]*6)):
            title=f'{i+1}. Empty' if not t else f"{i+1}. {t['provider']} · {t['host']} · {t['title']} · {t['state']}"
            item(menu,title,None if t is None else lambda _,i=i,layer=layer:emit(event='selectSlot',slot=i,layer=layer))
    for h in s.get('hosts',[]):item(menu,h['id']+(' · connected' if h['connected'] else ' · disconnected'))
    for key in ('claudeWaiting','waiting'):
        for t in s.get(key,[]):item(menu,'Waiting · '+t['provider']+' · '+t['host']+' · '+t['title'])
    for name in s.get('unavailableControls',CONTROLS):item(menu,'Unavailable: '+name)
    if s.get('attachError'):item(menu,s['attachError'])
    item(menu,'Stop',lambda _:emit(event='stop'));menu.show_all();return True

menu=Gtk.Menu()
if Indicator:
    indicator=Indicator.Indicator.new('micro-agent-bridge','input-keyboard',Indicator.IndicatorCategory.APPLICATION_STATUS)
    indicator.set_status(Indicator.IndicatorStatus.ACTIVE);indicator.set_menu(menu)
else:
    window=Gtk.Window(title='Micro Agent Bridge');button=Gtk.MenuButton(label='Keyboard tasks');button.set_popup(menu);window.add(button);window.show_all()
GLib.io_add_watch(0,GLib.IO_IN|GLib.IO_HUP,read);GLib.timeout_add(250,refresh)
emit(event='ready',accessibility=True);Gtk.main()
