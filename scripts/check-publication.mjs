import {readdir,readFile,lstat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join,basename} from 'node:path';

const args=process.argv.slice(2);
const rootIndex=args.indexOf('--root');
const root=resolve(rootIndex>=0?args[rootIndex+1]??'.':'.');
const worktree=args.includes('--worktree');
const ignoredDirectories=new Set(['.git','node_modules','dist','coverage','artifacts','playwright-report','test-results']);
const syntheticKeys=new Set(['ABC','ABC123','abc','abc123','ARCHIVO','DEMOFILE123','EXAMPLEFILE']);
const findings=[];
function issue(file,code){if(!findings.some(x=>x.file===file&&x.code===code))findings.push({file,code});}

async function collect(directory,prefix=''){
 const files=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const name=prefix?`${prefix}/${entry.name}`:entry.name;
  if(entry.isDirectory()){
   if(!ignoredDirectories.has(entry.name))files.push(...await collect(join(directory,entry.name),name));
  }else if(entry.isSymbolicLink())issue(name,'SYMLINK_NOT_REVIEWED');
  else if(entry.isFile()&&!entry.name.endsWith('.tgz'))files.push(name);
 }
 return files;
}

try{
 let files;
 if(worktree)files=await collect(root);
 else{
  const listed=spawnSync('git',['ls-files','--cached','-z'],{cwd:root,encoding:'utf8',shell:false});
  if(listed.status!==0)throw Error('Initialize Git and stage the intended public files, or use --worktree.');
  files=listed.stdout.split('\0').filter(Boolean);
  if(!files.length)throw Error('No staged/indexed files to review.');
 }
 for(const file of files){
  if(/(^|\/)(?:auth|snapshots|evidence|private|artifacts|coverage|node_modules|dist)(\/|$)/i.test(file)||/\.(?:tgz|har|saz|log)$/i.test(file)||/^(?:personal-token|tokens|credentials|snapshot|raw)\.json$/i.test(basename(file))||/^\.env(?:\.|$)/.test(basename(file)))issue(file,'PRIVATE_FILE');
  let bytes;
  if(worktree){
   const path=join(root,file);if((await lstat(path)).size>5*1024*1024){issue(file,'OVERSIZED_FILE');continue;}
   bytes=await readFile(path);
  }else{
   const shown=spawnSync('git',['show',`:${file}`],{cwd:root,shell:false,maxBuffer:6*1024*1024});
   if(shown.status!==0){issue(file,'UNREADABLE_INDEX_ENTRY');continue;}
   bytes=shown.stdout;
  }
  if(bytes.length>5*1024*1024){issue(file,'OVERSIZED_FILE');continue;}
  const text=bytes.toString('utf8');
  for(const match of text.matchAll(/https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/([A-Za-z0-9_-]+)/g)){
   if(!syntheticKeys.has(match[1]))issue(file,'PRIVATE_DESIGN_URL');
  }
  if(/\bfigd_[A-Za-z0-9_-]{24,}\b|\bgh[pousr]_[A-Za-z0-9]{25,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))issue(file,'CREDENTIAL_PATTERN');
 }
 process.stdout.write(JSON.stringify({result:findings.length?'FAIL':'PASS',mode:worktree?'worktree':'git-index',filesReviewed:files.length,findings},null,2)+'\n');
 if(findings.length)process.exitCode=1;
}catch(error){process.stderr.write(JSON.stringify({result:'FAIL',message:error instanceof Error?error.message:'Publication scan failed'})+'\n');process.exitCode=1;}
