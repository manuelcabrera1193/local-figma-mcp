import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('CLI reports configuration without requiring REA or leaking token values',async()=>{
  const root=await mkdtemp(join(tmpdir(),'figma-cli-'));
  try{
    const env:NodeJS.ProcessEnv={...process.env,LOCAL_FIGMA_HOME:root};
    delete env.FIGMA_TOKEN;delete env.FIGMA_TOKEN_FILE;delete env.FIGMA_CLIENT_ID;delete env.FIGMA_CLIENT_SECRET;
    const result=spawnSync(process.execPath,['--import','tsx','src/index.ts','doctor','--json'],{encoding:'utf8',env,timeout:15_000});
    assert.equal(result.status,0,result.stderr);
    const data=JSON.parse(result.stdout);assert.equal(data.reaRequired,false);assert.equal(data.auth.authenticated,false);
    const help=spawnSync(process.execPath,['--import','tsx','src/index.ts','--help'],{encoding:'utf8',env,timeout:15_000});
    assert.equal(help.status,0);assert.match(help.stdout,/token --stdin/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('token CLI accepts only stdin and persists a private token without echo',async()=>{
  const root=await mkdtemp(join(tmpdir(),'figma-cli-'));
  try{
    const result=spawnSync(process.execPath,['--import','tsx','src/index.ts','token','--stdin'],{input:'figd_test-local-secret\n',encoding:'utf8',env:{...process.env,LOCAL_FIGMA_HOME:root},timeout:15_000});
    assert.equal(result.status,0,result.stderr);
    assert.doesNotMatch(result.stdout+result.stderr,/figd_test-local-secret/);
    assert.equal(JSON.parse(result.stdout).mode,'personal-token');
  }finally{await rm(root,{recursive:true,force:true});}
});
