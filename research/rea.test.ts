import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function setup(t: {after(fn:()=>Promise<void>):void}) {
  const root=await mkdtemp(join(tmpdir(),'figma-rea-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const calls: Array<{name:string;arguments?:Record<string,unknown>}> = [];
  const fake={
    listTools:async()=>({tools:[{name:'capture_browser_scenario'},{name:'list_browser_targets'},{name:'inspect_web_page'}]}),
    callTool:async(input:{name:string;arguments?:Record<string,unknown>})=>{
      calls.push(input);
      return {structuredContent:{evidence_id:'ev-real-shape',operation:input.name,limitations:['Only this scenario was observed'],normalized_result:{completeness:{status:'complete'},browser:{cleanup:'terminated-owned-process'},steps:[{step_id:'ready',screenshot:{mime_type:'image/png',base64:'iVBORw0KGgo='}}]}}};
    },
    close:async()=>{},
  };
  const {ReaBridge}=await import('./rea.js');
  const bridge=new ReaBridge({root,clientFactory:async()=>fake});t.after(()=>bridge.close());
  return {root,calls,bridge};
}

test('REA status discovers installed tool capabilities without a target',async t=>{
  const {bridge}=await setup(t);const status=await bridge.status();assert.equal(status.available,true);assert.ok(status.tools.includes('capture_browser_scenario'));
});
test('REA records normalized URL and persists the whole original evidence privately',async t=>{
  const {bridge,calls}=await setup(t);
  const result=await bridge.recordFlow({url:'https://www.figma.com/proto/abc123/demo?node-id=1-2',executablePath:'/Applications/Browser',actions:[{action:'wait_for_timeout',durationMs:50}]});
  assert.equal(calls[0]?.name,'capture_browser_scenario');
  const args=calls[0]?.arguments as any;
  assert.equal(args.start_url.url,'https://www.figma.com/proto/abc123/demo');
  assert.deepEqual(args.start_url.query,[{name:'node-id',value:{source:'literal',value:'1-2'}}]);
  assert.equal(args.actions[0].duration_ms,50);
  assert.equal(result.evidenceId,'ev-real-shape');
  assert.equal(result.completeness,'complete');
  const persisted=JSON.parse(await readFile(result.evidencePath,'utf8'));assert.equal(persisted.structuredContent.evidence_id,'ev-real-shape');
  assert.equal((await stat(result.evidencePath)).mode&0o777,0o600);
  assert.ok(!JSON.stringify(result).includes('iVBOR'));
});
test('REA connect mode requires both endpoint and explicit target and leaves it external',async t=>{
  const {bridge,calls}=await setup(t);
  await bridge.recordFlow({url:'https://figma.com/proto/abc/demo',cdpEndpoint:'http://127.0.0.1:9222',targetId:'target-1',actions:[{action:'click',locator:{kind:'css',selector:'button'}}]});
  assert.deepEqual((calls[0]?.arguments as any).browser,{mode:'connect',cdp_endpoint:'http://127.0.0.1:9222',target_id:'target-1'});
  await assert.rejects(()=>bridge.recordFlow({url:'https://figma.com/proto/abc/demo',cdpEndpoint:'http://127.0.0.1:9222',actions:[{action:'wait_for_timeout',durationMs:5}]}),/target/i);
});
test('REA refuses arbitrary origins, remote CDP and unsupported actions before invoking anything',async t=>{
  const {bridge,calls}=await setup(t);
  await assert.rejects(()=>bridge.recordFlow({url:'https://example.com',executablePath:'/Browser',actions:[{action:'wait_for_timeout',durationMs:5}]}),/Figma|loopback/i);
  await assert.rejects(()=>bridge.listTargets('http://example.com:9222'),/loopback/i);
  await assert.rejects(()=>bridge.recordFlow({url:'https://figma.com/proto/abc/demo',executablePath:'/Browser',actions:[{action:'evaluate',script:'process.exit()'}] as any}),/action/i);
  assert.equal(calls.length,0);
});
test('REA prevents external navigation, unbounded waiting and oversized action sets',async t=>{
  const {bridge}=await setup(t);
  const base={url:'https://figma.com/proto/abc/demo',executablePath:'/Browser'};
  await assert.rejects(()=>bridge.recordFlow({...base,actions:[{action:'goto',url:'https://evil.example'}]}),/origin|Figma/i);
  await assert.rejects(()=>bridge.recordFlow({...base,actions:[{action:'wait_for_timeout',durationMs:999999}]}),/duration|wait/i);
  await assert.rejects(()=>bridge.recordFlow({...base,actions:Array.from({length:101},()=>({action:'wait_for_timeout',durationMs:1}))}),/100|actions/i);
});
test('REA reads selected browser page passively with scripts and storage disabled',async t=>{
  const {bridge,calls}=await setup(t);
  await bridge.listTargets('http://127.0.0.1:9222');
  await bridge.inspectPage('http://127.0.0.1:9222','known-target');
  assert.equal(calls[0]?.name,'list_browser_targets');
  assert.equal(calls[1]?.name,'inspect_web_page');
  assert.equal((calls[1]?.arguments as any).include_script_sources,false);
  assert.equal((calls[1]?.arguments as any).target_id,'known-target');
});
