import hashlib,json,os,shutil,tarfile,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
VERSION=json.loads((ROOT/'package.json').read_text())['version']
def runtime(name,dest):
 spec=json.loads((ROOT/'packaging/runtimes.json').read_text())[name]
 cache=Path(os.environ.get('MAB_BUILD_CACHE',str(Path.home()/'.cache/micro-agent-bridge')));cache.mkdir(parents=True,exist_ok=True)
 file=cache/spec['url'].rsplit('/',1)[1]
 if not file.exists():urllib.request.urlretrieve(spec['url'],file)
 if hashlib.sha256(file.read_bytes()).hexdigest()!=spec['sha256']:raise RuntimeError('Runtime checksum mismatch: '+name)
 stage=dest.with_name(dest.name+'.extract');stage.mkdir(parents=True)
 with tarfile.open(file) as archive:archive.extractall(stage,filter='data')
 roots=list(stage.iterdir())
 if len(roots)!=1:raise RuntimeError('Unexpected runtime archive layout')
 shutil.move(str(roots[0]),dest);stage.rmdir()
 if name.startswith('node'):
  # The application needs Node itself, not npm, development headers or build tools.
  for item in dest.iterdir():
   if item.name not in ('bin','LICENSE','README.md','CHANGELOG.md'):
    if item.is_dir():shutil.rmtree(item)
    else:item.unlink()
  for item in (dest/'bin').iterdir():
   if item.name!='node':item.unlink()
def payload(dest):
 shutil.copytree(ROOT/'src',dest/'src',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
 for name in ['LICENSE','THIRD_PARTY_NOTICES.md']:shutil.copy2(ROOT/name,dest/name)
 shutil.copytree(ROOT/'docs',dest/'docs')
def sums(dist):
 files=sorted(p for p in dist.iterdir() if p.is_file() and p.name!='SHA256SUMS')
 (dist/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in files))
