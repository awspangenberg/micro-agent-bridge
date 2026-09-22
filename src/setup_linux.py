"""First-run settings window; privileged vendor installs run in an explicit terminal."""
import json,subprocess,threading
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk,GLib
window=Gtk.Window(title='Micro Agent Bridge Setup');window.set_default_size(700,550)
box=Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=8);box.set_border_width(16);window.add(box)
box.pack_start(Gtk.Label(label='Claude layer 2 · Mixed layer 3 · Native Codex layer 1 preserved'),False,False,0)
consent=Gtk.CheckButton(label='Allow backed-up changes to existing layers 2 and 3');box.pack_start(consent,False,False,0)
output=Gtk.TextView();output.set_editable(False);output.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
def run(args):
 def work():
  result=subprocess.run(['/usr/bin/micro-agent-bridge',*args],capture_output=True,text=True)
  text=result.stdout+result.stderr
  try:
   rows=json.loads(result.stdout)
   if isinstance(rows,list):text='\n\n'.join(('Ready: ' if x.get('ok') else 'Needs attention: ')+x['name']+('\n'+x['reason'] if x.get('reason') else '') for x in rows)
  except ValueError:pass
  GLib.idle_add(output.get_buffer().set_text,text)
 threading.Thread(target=work,daemon=True).start()
for title,args in [('Configure desktop',['setup','--defaults','--role','desktop']),('Check compatibility',['doctor']),('Start',['start']),('Status',['status']),('Stop',['stop']),('Enable login startup',['enable-login'])]:
 button=Gtk.Button(label=title);button.connect('clicked',lambda _,a=args:run(a+(['--take-over-layers'] if a[0]=='setup' and consent.get_active() else [])));box.pack_start(button,False,False,0)
def install_vendor(_,provider):
 dialog=Gtk.MessageDialog(transient_for=window,modal=True,message_type=Gtk.MessageType.QUESTION,buttons=Gtk.ButtonsType.OK_CANCEL,text='Install '+provider+' from its verified vendor source?')
 dialog.format_secondary_text('This opens a terminal for package-manager authorization. Existing applications are preserved. Sign in directly in the vendor app afterward.')
 yes=dialog.run()==Gtk.ResponseType.OK;dialog.destroy()
 if yes:
  try:subprocess.Popen(['x-terminal-emulator','-e','micro-agent-bridge','install-app',provider,'--confirm'])
  except OSError:output.get_buffer().set_text('Open Terminal and run: micro-agent-bridge install-app '+provider+' --confirm')
for vendor in ('claude','codex'):
 b=Gtk.Button(label='Install missing '+vendor.capitalize()+' app');b.connect('clicked',install_vendor,vendor);box.pack_start(b,False,False,0)
box.pack_start(Gtk.Label(label='Remote hosts: use the hosts command described in Installation help.'),False,False,0)
scroll=Gtk.ScrolledWindow();scroll.add(output);box.pack_start(scroll,True,True,0)
window.connect('destroy',Gtk.main_quit);window.show_all();run(['doctor']);Gtk.main()
