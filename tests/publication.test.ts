import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('publication guard rejects private design URLs and tokens without echoing their values',async()=>{
 const root=await mkdtemp(join(tmpdir(),'public-fixture-'));
 try{
  const privateLink='https://www.figma.com/design/'+'PRIVATEFILEKEY123456789'+'/Private';
  const token='figd_'+'S'.repeat(40);
  await writeFile(join(root,'README.md'),privateLink+'\n'+token);
  const r=spawnSync(process.execPath,['scripts/check-publication.mjs','--root',root,'--worktree'],{encoding:'utf8'});
  assert.equal(r.status,1,r.stderr);
  assert.match(r.stdout+r.stderr,/PRIVATE_DESIGN_URL/);
  assert.match(r.stdout+r.stderr,/CREDENTIAL_PATTERN/);
  assert.doesNotMatch(r.stdout+r.stderr,/PRIVATEFILEKEY123456789/);
  assert.ok(!(r.stdout+r.stderr).includes(token));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('publication guard permits synthetic fixtures and rejects credentials as publishable files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'public-fixture-'));
 try{
  await writeFile(join(root,'README.md'),'https://www.figma.com/design/ABC123/Demo?node-id=1-2');
  let r=spawnSync(process.execPath,['scripts/check-publication.mjs','--root',root,'--worktree'],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  await mkdir(join(root,'data'));
  await writeFile(join(root,'data','personal-token.json'),'{}');
  r=spawnSync(process.execPath,['scripts/check-publication.mjs','--root',root,'--worktree'],{encoding:'utf8'});
  assert.equal(r.status,1);assert.match(r.stdout+r.stderr,/PRIVATE_FILE/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('publication guard reviews index bytes even if the worktree was subsequently cleaned',async()=>{
 const root=await mkdtemp(join(tmpdir(),'public-index-fixture-'));
 try{
  assert.equal(spawnSync('git',['init','-q'],{cwd:root}).status,0);
  const privateLink='https://www.figma.com/design/'+'STAGEDPRIVATEFILE12345'+'/Private';
  await writeFile(join(root,'README.md'),privateLink);
  assert.equal(spawnSync('git',['add','README.md'],{cwd:root}).status,0);
  await writeFile(join(root,'README.md'),'https://figma.com/design/ABC123/Demo');
  const r=spawnSync(process.execPath,['scripts/check-publication.mjs','--root',root],{encoding:'utf8'});
  assert.equal(r.status,1);assert.match(r.stdout,/PRIVATE_DESIGN_URL/);
  assert.ok(!r.stdout.includes('STAGEDPRIVATEFILE12345'));
 }finally{await rm(root,{recursive:true,force:true});}
});
