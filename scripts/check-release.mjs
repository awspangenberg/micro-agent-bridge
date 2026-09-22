import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(process.argv[2]??path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
const ignored=new Set(['.git','build','dist','node_modules','__pycache__']);
const findings=[];
const forbidden=[
 ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['provider credential',/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{25,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,})\b/],
 ['personal home path',/\/(?:Users|home)\/(?!runner\b|user\b|example\b)[a-zA-Z0-9_.-]+\//],
 ['private network address',/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b/],
 ['live session id',/\b(?:session_01[A-Za-z0-9]+|cse_01[A-Za-z0-9]+)\b/]
];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
 if(ignored.has(e.name))continue;const file=path.join(dir,e.name),relative=path.relative(root,file);
 if(e.isSymbolicLink())continue;
 if(e.isDirectory()){walk(file);continue;}
 if(/^(?:config\.json|assignments\.json|claude-assignments\.json|acceptance\.json|profile-ownership\.json|\.env|settings-before-hooks\.json)$/.test(e.name))findings.push(relative+': private runtime filename');
 const bytes=fs.readFileSync(file);if(bytes.includes(0))continue;
 const text=bytes.toString();for(const [name,re]of forbidden)if(re.test(text))findings.push(relative+': '+name);
}}
walk(root);if(findings.length){console.error(findings.join('\n'));process.exitCode=1;}else console.log('Publication path/credential scan passed. Also run gitleaks and review source/history/artifact contents.');
