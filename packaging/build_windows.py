#!/usr/bin/env python3
# Builds the per-user Windows x64 installer. Run on Windows with npm and Inno Setup 6.
import json,os,shutil,subprocess,sys
from pathlib import Path
from common import ROOT,VERSION,runtime,payload,sums
if sys.platform!='win32':raise SystemExit('Build the Windows installer on Windows')
build=ROOT/'build/windows';app=build/'app';dist=ROOT/'dist';dist.mkdir(exist_ok=True)
if build.exists():shutil.rmtree(build)
app.mkdir(parents=True);payload(app)
runtime('nodeWindows',app/'runtime/node');runtime('pythonWindows',app/'runtime/python')
# The host scripts use only the standard library; drop package tooling, Tk, IDLE and tests.
for name in ('Lib/site-packages/pip','Lib/ensurepip','Lib/idlelib','Lib/tkinter','Lib/turtledemo','Lib/test','tcl','Scripts','libs','include'):
 if (app/'runtime/python'/name).exists():shutil.rmtree(app/'runtime/python'/name)
for item in (app/'runtime/python/Lib/site-packages').glob('pip-*'):shutil.rmtree(item)
for item in (app/'runtime/python/DLLs').glob('*'):
 if item.name.lower().startswith(('_tkinter','tcl','tk')):item.unlink()
# Ship the standard library's bytecode so running the host writes no untracked caches under the install.
subprocess.run([str(app/'runtime/python/python.exe'),'-I','-m','compileall','-q','-j','0',str(app/'runtime/python/Lib')],check=True)
# Production dependencies only (node-hid for device enumeration), resolved from the lockfile.
deps=build/'deps';deps.mkdir()
for name in ('package.json','package-lock.json'):shutil.copy2(ROOT/name,deps/name)
npm=shutil.which('npm')
if not npm:raise SystemExit('npm is required to stage node_modules')
# node-hid ships its prebuilt addon; skip its install script (verify-or-node-gyp) and check the prebuild below.
subprocess.run([npm,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=deps,check=True)
shutil.move(str(deps/'node_modules'),app/'node_modules')
for prebuilds in app.glob('node_modules/*/prebuilds'):
 for item in prebuilds.iterdir():
  if item.name!='HID-win32-x64':shutil.rmtree(item)
 if not (prebuilds/'HID-win32-x64').is_dir():raise SystemExit('Missing win32-x64 prebuild in '+str(prebuilds))
shutil.copy2(ROOT/'package.json',app/'package.json')
(app/'bin').mkdir()
# Every host command runs on the bundled Node and Python; nothing is taken from PATH.
(app/'bin/micro-agent-bridge.cmd').write_text(newline='\r\n',data='''@echo off
setlocal
set "MAB_ROOT=%~dp0.."
set "PYTHONDONTWRITEBYTECODE=1"
if /i "%~1"=="hooks" goto hooks
"%MAB_ROOT%\\runtime\\node\\node.exe" "%MAB_ROOT%\\src\\standalone-control.mjs" %* --python "%MAB_ROOT%\\runtime\\python\\python.exe"
exit /b %errorlevel%
:hooks
if /i "%~2"=="install" (set "MAB_HOOKS=--install") else if /i "%~2"=="remove" (set "MAB_HOOKS=--remove") else (
  echo Usage: micro-agent-bridge hooks install^|remove
  exit /b 2
)
"%MAB_ROOT%\\runtime\\python\\python.exe" "%MAB_ROOT%\\src\\claude_hooks.py" %MAB_HOOKS% --state "%LOCALAPPDATA%\\Micro Agent Bridge\\standalone"
exit /b %errorlevel%
''')
# Tray app and onboarding: a .NET Framework 4.8 exe hosting the local ui\ pages in WebView2.
icon=build/'icon.ico'
subprocess.run([sys.executable,str(ROOT/'packaging/windows/make_icon.py'),str(icon)],check=True)
dotnet=shutil.which('dotnet')
if not dotnet:raise SystemExit('The .NET SDK (dotnet) is required to build the tray app')
published=build/'dotnet'
subprocess.run([dotnet,'publish',str(ROOT/'windows/app/MicroAgentBridge.csproj'),'-c','Release','-o',str(published),'--nologo',
 f'-p:Version={VERSION.split("-")[0]}',f'-p:InformationalVersion={VERSION}',f'-p:MabIcon={icon}'],check=True)
for name in ('MicroAgentBridge.exe','MicroAgentBridge.exe.config','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll'):
 shutil.copy2(published/name,app/name)
# The simulator only serves browser previews of the pages.
shutil.copytree(ROOT/'windows/ui',app/'ui',ignore=shutil.ignore_patterns('simulator.js'))
shutil.copy2(icon,app/'MicroAgentBridge.ico')
# Loading the CLI imports node-hid and the HID transport without opening a device.
subprocess.run([str(app/'runtime/node/node.exe'),'-e',"import('node-hid').then(h=>{if(typeof h.devicesAsync!=='function')process.exit(1)})"],cwd=app/'src',check=True)
subprocess.run([str(app/'bin/micro-agent-bridge.cmd'),'--help'],check=True,stdout=subprocess.DEVNULL)
subprocess.run([str(app/'runtime/python/python.exe'),'-I','-c','import sqlite3,json,ssl'],check=True)
iscc=os.environ.get('ISCC') or next((str(p) for p in (
 Path(os.environ.get('ProgramFiles(x86)',r'C:\Program Files (x86)'))/'Inno Setup 6/ISCC.exe',
 Path(os.environ.get('ProgramFiles',r'C:\Program Files'))/'Inno Setup 6/ISCC.exe',
 Path(os.environ.get('LOCALAPPDATA',''))/'Programs/Inno Setup 6/ISCC.exe') if p.is_file()),None) or shutil.which('iscc')
if not iscc:raise SystemExit('Inno Setup 6 (ISCC.exe) not found; set ISCC')
base=f'Micro-Agent-Bridge-{VERSION}-windows-x64-setup'
numeric='.'.join((VERSION.split('-')[0].split('.')+['0']*4)[:4])
subprocess.run([iscc,'/Qp',f'/DAppVersion={VERSION}',f'/DNumericVersion={numeric}',f'/DSourceDir={app}',f'/DOutputDir={dist}',f'/DOutputBase={base}',f'/DIconFile={icon}',
 str(ROOT/'packaging/windows/micro-agent-bridge.iss')],check=True)
sums(dist)
print(dist/(base+'.exe'))
