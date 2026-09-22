import fs from 'node:fs';
import crypto from 'node:crypto';
import {ROOT,STATE,atomic} from './paths.mjs';
export const gates=['native-layer-preserved','claude-pins','mixed-pins','six-slots-overflow-empty','pin-unpin-repin-new','exact-local-remote-selection','independent-real-status','manual-layer-isolation','supported-action-focus-loss','bluetooth-power-cycle','sleep-wake','ssh-interruption','helper-app-restart','five-second-updates','thirty-second-recovery'];
export function recordAcceptance(report){
 if(report.version!==1||!gates.every(g=>report.checks?.[g]===true))throw Error('Every physical acceptance check must pass; unavailable controls must be reported separately');
 const state=JSON.parse(fs.readFileSync(STATE+'/state.json'));
 if(Date.now()-Date.parse(state.updatedAt)>5000||state.connection?.status!=='connected')throw Error('A fresh connected helper is required');
 const record={version:1,passed:true,recordedAt:new Date().toISOString(),compatibilitySHA256:crypto.createHash('sha256').update(fs.readFileSync(ROOT+'/compatibility.json')).digest('hex'),checks:Object.fromEntries(gates.map(g=>[g,true]))};
 atomic(STATE+'/acceptance.json',record);return record;
}
