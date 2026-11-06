import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplication } from '../src/server.js';
import { FigmaRepository } from '../src/design.js';
import { PNG } from 'pngjs';

test('MCP advertises compatible Figma read tools and reports missing auth honestly', async () => {
  const root = await mkdtemp(join(tmpdir(),'figma-mcp-'));
  const app = createApplication({root});
  const client = new Client({name:'acceptance-client',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await app.server.connect(a);
    await client.connect(b);
    const tools = (await client.listTools()).tools;
    for (const name of ['figma_connect','get_design_context','get_metadata','get_screenshot','download_assets','get_variable_defs','figma_import','figma_compare_screen']) {
      assert.ok(tools.some(t=>t.name===name),name);
    }
    assert.ok(!tools.some(t=>t.name==='figma_record_flow'), 'REA is a development tool, not a runtime requirement');
    const status = await client.callTool({name:'figma_auth_status',arguments:{}});
    assert.equal(JSON.parse((status.content as Array<{text:string}>)[0]!.text).authenticated,false);
    assert.doesNotMatch(JSON.stringify(status), /client_secret|access_token|refresh_token/);
    const snapshots = await client.callTool({name:'figma_list_snapshots',arguments:{}});
    assert.equal(snapshots.isError, undefined);
    assert.match(JSON.stringify(snapshots), /snapshots/);
  } finally { await client.close(); await app.close(); await rm(root,{recursive:true,force:true}); }
});

test('MCP import, offline context, screenshot and comparison work through actual tool calls', async()=>{
  const root=await mkdtemp(join(tmpdir(),'figma-mcp-fixture-'));
  const png=new PNG({width:2,height:2});png.data.fill(255);const bytes=PNG.sync.write(png);
  let calls=0;let offline=false;
  const repository=new FigmaRepository({root,getAccessToken:async()=>{if(offline)throw Error('Must not read token offline');return 'fixture-only';},fetch:async(input)=>{
    if(offline)throw Error('Must not fetch offline');calls++;
    const url=new URL(String(input));
    if(url.pathname==='/v1/files/ABC123')return Response.json({name:'Fixture',version:'1',document:{id:'0:0',type:'DOCUMENT',children:[{id:'1:2',type:'FRAME',name:'Screen',absoluteBoundingBox:{x:0,y:0,width:2,height:2},children:[{id:'1:3',type:'TEXT',characters:'Hello'},{id:'1:4',type:'FRAME',name:'Header',children:[{id:'1:5',type:'INSTANCE',name:'_status-bars',absoluteBoundingBox:{x:0,y:0,width:2,height:1}}]}]}]},styles:{s:{name:'Body',styleType:'TEXT'}},components:{}});
    if(url.pathname==='/v1/images/ABC123')return Response.json({images:{'1:2':'https://figma.com/fixture.png'}});
    if(url.pathname==='/fixture.png')return new Response(new Uint8Array(bytes),{headers:{'content-type':'image/png'}});
    throw Error('Unexpected fixture request');
  }});
  const app=createApplication({root,repository});const client=new Client({name:'fixture-client',version:'1'});
  const[a,b]=InMemoryTransport.createLinkedPair();
  const call=async(name:string,args:Record<string,unknown>={})=>{
    const result=await client.callTool({name,arguments:args});
    assert.notEqual(result.isError,true,JSON.stringify(result));
    const text=(result.content as Array<{type:string;text?:string}>).find(c=>c.type==='text')?.text;
    return {result,data:text?JSON.parse(text):{}};
  };
  try{
    await app.server.connect(a);await client.connect(b);
    const job=(await call('figma_import',{url:'https://figma.com/design/ABC123/Fixture?node-id=1-2'})).data;
    await app.jobs.idle();
    const finished=(await call('figma_job_status',{jobId:job.id})).data;assert.equal(finished.status,'complete');
    const snapshotId=finished.result.snapshotId;assert.equal(calls,3);offline=true;
    const context=(await call('get_design_context',{snapshotId,depth:10})).data;
    assert.equal(context.context.node.children[0].characters,'Hello');
    const shallow=(await call('get_design_context',{snapshotId,depth:0})).data;
    assert.equal(shallow.context.implementationGuidance.profile.systemUi,'native');
    assert.equal(shallow.context.implementationGuidance.systemUiCandidates[0].nodeId,'1:5');
    assert.equal(shallow.context.truncated,true);
    const configured=(await call('figma_get_design_context',{snapshotId,implementation:{platform:'android',framework:'Jetpack Compose',components:'library-first',componentLibrary:'Material3',skills:['figma-to-compose']}})).data;
    assert.equal(configured.context.implementationGuidance.profile.componentLibrary,'Material3');
    assert.deepEqual(configured.context.implementationGuidance.profile.skills,['figma-to-compose']);
    const invalid=await client.callTool({name:'get_design_context',arguments:{snapshotId,implementation:{components:'library-first'}}});
    assert.equal(invalid.isError,true);
    assert.equal((await call('get_metadata',{snapshotId})).data.context.node.id,'1:2');
    assert.equal((await call('get_variable_defs',{snapshotId})).data.styles.s.name,'Body');
    assert.equal((await call('figma_list_screens',{snapshotId})).data.total,1);
    const image=await call('get_screenshot',{snapshotId});
    assert.ok((image.result.content as Array<{type:string}>).some(c=>c.type==='image'));
    assert.equal((await call('download_assets',{snapshotId})).data.total,1);
    assert.equal((await call('figma_get_assets',{snapshotId})).data.total,1);
    assert.ok((await call('figma_list_flows',{snapshotId})).data.warnings.length);
    const comparison=(await call('figma_compare_screen',{snapshotId,nodeId:'1:2',actualPngBase64:bytes.toString('base64')})).data;
    assert.equal(comparison.status,'pass');assert.equal(comparison.diffPixels,0);
    const cropped=(await call('figma_compare_screen',{snapshotId,nodeId:'1:2',actualPngBase64:bytes.toString('base64'),referenceRegion:{x:0,y:0,width:1,height:2},actualRegion:{x:0,y:0,width:1,height:2}})).data;
    assert.deepEqual(cropped.comparedDimensions,{width:1,height:2});
    assert.equal(calls,3);
  }finally{await client.close();await app.close();await rm(root,{recursive:true,force:true});}
});

test('MCP rejects traversal and reports errors without exception contents', async () => {
  const root = await mkdtemp(join(tmpdir(),'figma-mcp-'));
  const app = createApplication({root});
  const client = new Client({name:'acceptance-client',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await app.server.connect(a); await client.connect(b);
    const result = await client.callTool({name:'figma_job_status',arguments:{jobId:'../../auth.json'}});
    assert.equal(result.isError,true);
    assert.doesNotMatch(JSON.stringify(result), /ENOENT|at .*\.ts/);
  } finally { await client.close(); await app.close(); await rm(root,{recursive:true,force:true}); }
});
