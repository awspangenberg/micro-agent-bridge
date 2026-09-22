import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateConfig} from '../src/paths.mjs';
test('local only, distinct hosts and conflicting identities',()=>{
 const base={version:1,role:'desktop',hosts:[]};assert.deepEqual(validateConfig(base),base);
 const host={id:'build',sshAlias:'build-server',codexHostIds:['remote-ssh-discovered:build-server'],claudeTargets:['build-server']};
 assert.equal(validateConfig({...base,hosts:[host]}).hosts.length,1);
 assert.throws(()=>validateConfig({...base,hosts:[host,{...host,id:'other'}]}),/Ambiguous/);
 assert.throws(()=>validateConfig({...base,hosts:[{...host,sshAlias:'-oProxyCommand=bad'}]}),/SSH/);
 assert.throws(()=>validateConfig({...base,ownedLayers:[0]}),/custom layers/);
});
