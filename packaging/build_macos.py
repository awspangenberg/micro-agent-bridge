#!/usr/bin/env python3
import json,os,plistlib,shutil,subprocess
from pathlib import Path
from common import ROOT,VERSION,runtime,payload,sums
os.environ.setdefault('DEVELOPER_DIR','/Library/Developer/CommandLineTools')
if os.uname().machine!='arm64':raise SystemExit('Build on an Apple Silicon Mac')
build=ROOT/'build/mac';dist=ROOT/'dist';dist.mkdir(exist_ok=True)
if build.exists():shutil.rmtree(build)
app=build/'Micro Agent Bridge.app';resources=app/'Contents/Resources';resources.mkdir(parents=True);binary=app/'Contents/MacOS';binary.mkdir()
payload(resources);runtime('nodeDarwin',resources/'runtime/node');runtime('pythonDarwin',resources/'runtime/python')
plist={'CFBundleIdentifier':'org.microagentbridge.app','CFBundleName':'Micro Agent Bridge','CFBundleExecutable':'MicroAgentBridge','CFBundleShortVersionString':VERSION.split('-')[0],'CFBundleVersion':'1','LSMinimumSystemVersion':'14.0','NSHighResolutionCapable':True}
(app/'Contents/Info.plist').write_bytes(plistlib.dumps(plist))
run=lambda *args:subprocess.run(args,check=True)
compiler='/Library/Developer/CommandLineTools/usr/bin/swiftc';sdk='/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk'
for src,dest in [('Setup.swift',binary/'MicroAgentBridge'),('Menu.swift',resources/'src/MicroMixedMenu')]:run(compiler,'-O','-sdk',sdk,'-target','arm64-apple-macosx14.0',str(resources/'src'/src),'-o',str(dest))
identity=os.environ.get('MAB_SIGNING_IDENTITY');profile=os.environ.get('MAB_NOTARY_PROFILE')
if not identity:raise SystemExit('Application built, but signing identity required for release DMG')
entitlements=build/'runtime-entitlements.plist';entitlements.write_bytes(plistlib.dumps({'com.apple.security.cs.allow-jit':True,'com.apple.security.cs.allow-unsigned-executable-memory':True,'com.apple.security.cs.disable-library-validation':True}))
# Sign nested native code before signing the outer application. No developer names in build scripts.
for p in sorted(resources.rglob('*')):
 if p.is_file() and not p.is_symlink():
  kind=subprocess.check_output(['file','-b',str(p)],text=True)
  if 'Mach-O' in kind:run('codesign','--force','--options','runtime','--timestamp','--entitlements',str(entitlements),'--sign',identity,str(p))
run('codesign','--force','--options','runtime','--timestamp','--sign',identity,str(app));run('codesign','--verify','--deep','--strict',str(app))
if not profile:raise SystemExit('Signed application built; MAB_NOTARY_PROFILE required before release packaging')
zipfile=build/'notarize.zip';run('ditto','-c','-k','--keepParent',str(app),str(zipfile))
run('xcrun','notarytool','submit',str(zipfile),'--keychain-profile',profile,'--wait');run('xcrun','stapler','staple',str(app));run('spctl','--assess','--type','execute',str(app))
dmgroot=ROOT/'build/dmg';dmgroot.mkdir();shutil.copytree(app,dmgroot/app.name,symlinks=True);(dmgroot/'Applications').symlink_to('/Applications')
dmg=dist/f'Micro-Agent-Bridge-{VERSION}-macOS-arm64.dmg'
run('hdiutil','create','-volname','Micro Agent Bridge','-srcfolder',str(dmgroot),'-format','UDZO','-ov',str(dmg))
run('codesign','--sign',identity,'--timestamp',str(dmg));run('xcrun','notarytool','submit',str(dmg),'--keychain-profile',profile,'--wait');run('xcrun','stapler','staple',str(dmg));sums(dist)
