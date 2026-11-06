import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FigmaRepository, parseFigmaUrl } from '../src/design.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const link = 'https://www.figma.com/design/ABC123/Demo?node-id=1-2&t=tracking';
const frame = (id: string, name = 'Screen') => ({ id, type: 'FRAME', name, absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 }, children: [{ id: `${id}:text`, name: 'Hello', type: 'TEXT', characters: 'Hello' }] });
const document = { id: '0:0', type: 'DOCUMENT', name: 'Document', children: [{ id: '1:1', type: 'CANVAS', name: 'Page', children: [{ id: '2:1', type: 'SECTION', name: 'Flow', children: [frame('1:2'), frame('1:3')] }] }] };
const payload = (doc: any = document) => ({ name: 'Demo', version: 'v1', document: doc, components: { '4:1': { key: 'x', name: 'Button' } }, styles: { '5:1': { name: 'Primary', styleType: 'FILL' } }, componentSets: {} });
const json = (value: any, status = 200, headers: Record<string,string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
async function fixture(handler?: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const root = await mkdtemp(join(tmpdir(), 'figma-design-'));
  const calls: Array<{url:URL,init?:RequestInit}> = [];
  let tokens = 0;
  const fetcher = async (input: any, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push({url,init});
    if (handler) { const r = await handler(url,init); if (r) return r; }
    if (url.pathname === '/v1/files/ABC123') return json(payload());
    if (url.pathname === '/v1/images/ABC123') return json({ images: Object.fromEntries((url.searchParams.get('ids') ?? '').split(',').map(id => [id, `https://figma-alpha-api.s3.us-west-2.amazonaws.com/${encodeURIComponent(id)}.png`])) });
    if (url.hostname.endsWith('amazonaws.com')) return new Response(url.pathname.includes('1%3A3') ? Buffer.concat([PNG,Buffer.from([1])]) : PNG, { headers: { 'content-type': 'image/png' } });
    return json({error:'unexpected'},404);
  };
  const repo = new FigmaRepository({ root, getAccessToken: async () => { tokens++; return 'fixture-token'; }, fetch: fetcher as typeof fetch });
  return {repo,root,calls,tokens:()=>tokens,cleanup:()=>rm(root,{recursive:true,force:true})};
}

test('parses Figma links, converts node IDs, removes tracking and preserves explicit version', () => {
  const ref = parseFigmaUrl(link + '&version-id=42');
  assert.equal(ref.fileKey,'ABC123'); assert.equal(ref.nodeId,'1:2'); assert.equal(ref.version,'42');
  assert(!ref.url.includes('tracking'));
  assert.equal(parseFigmaUrl('https://figma.com/proto/ABC123/Demo').fileKey,'ABC123');
});

test('rejects hostile URLs, user info, invalid IDs and unsupported products', () => {
  for (const url of ['http://figma.com/design/ABC/Demo','https://figma.com.evil.test/design/ABC/Demo','https://user@figma.com/design/ABC/Demo','https://figma.com/design/../../x','https://figma.com/board/ABC/Demo','https://figma.com/design/ABC/Demo?node-id=../../secret']) assert.throws(()=>parseFigmaUrl(url));
});

test('imports selected subtree with same-version exports and immediately stores bytes privately', async () => {
  const f = await fixture(); try {
    const snap = await f.repo.importDesign({url:link});
    assert.equal(snap.nodeId,'1:2'); assert.equal(snap.version,'v1');
    const request = f.calls.find(c=>c.url.pathname==='/v1/files/ABC123')!;
    assert.equal(request.url.searchParams.get('ids'),'1:2'); assert.equal(request.url.searchParams.get('geometry'),'paths');
    const rendering = f.calls.find(c=>c.url.pathname==='/v1/images/ABC123')!;
    assert.equal(rendering.url.searchParams.get('version'),'v1');
    assert.equal(rendering.url.searchParams.get('ids'),'1:2');
    assert.equal(snap.screens.length,1);
    const image = await f.repo.getScreenshot(snap.id,'1:2');
    assert.deepEqual(await readFile(image.path),PNG);
    assert.equal((await stat(image.path)).mode & 0o777,0o600);
    const cdnRequest = f.calls.find(c=>c.url.hostname.endsWith('amazonaws.com'))!;
    assert(!new Headers(cdnRequest.init?.headers).has('authorization'));
    assert.equal(snap.components['4:1']?.name,'Button');
  } finally { await f.cleanup(); }
});

test('cached imports and queries work without network or credential access', async () => {
  const f=await fixture(); try {
    const initial=await f.repo.importDesign({url:link});
    const offline=new FigmaRepository({root:f.root,getAccessToken:async()=>{throw Error('must not access token')},fetch:async()=>{throw Error('must not access network')}});
    assert.equal((await offline.importDesign({url:link})).id,initial.id);
    assert.equal((await offline.listSnapshots()).length,1);
    assert.equal((await offline.listScreens(initial.id))[0]?.nodeId,'1:2');
    assert.equal((await offline.listAssets(initial.id)).length,1);
    const context=await offline.getContext(initial.id,'1:2',1,1);
    assert.equal(context.node.id,'1:2'); assert(context.truncated);
    await assert.rejects(()=>offline.getContext(initial.id,'missing'),/not found/i);
  } finally { await f.cleanup(); }
});

test('file imports discover frames inside sections without duplicating nested frames',async()=>{
  const f=await fixture();try{
    const s=await f.repo.importDesign({url:'https://figma.com/design/ABC123/Demo'});
    assert.deepEqual(s.screens.map(x=>x.nodeId),['1:2','1:3']);
    assert.notEqual(s.screens[0]?.screenshotPath,s.screens[1]?.screenshotPath);
    const s2=await f.repo.importDesign({url:link}); assert.notEqual(s.id,s2.id);
  }finally{await f.cleanup()}
});

test('preserves partial import when Figma cannot render a node',async()=>{
  const f=await fixture(async u=>u.pathname==='/v1/images/ABC123'?json({images:{'1:2':null}}):undefined as any);try{
    const s=await f.repo.importDesign({url:link});assert.equal(s.status,'partial');assert(s.warnings.length);
    await assert.rejects(()=>f.repo.getScreenshot(s.id,'1:2'),/unavailable/i);
  }finally{await f.cleanup()}
});

test('429 reports retryAfter and does not retry or leak response details',async()=>{
  const f=await fixture(async()=>json({error:'secret body'},429,{'retry-after':'3600'}));try{
    await assert.rejects(()=>f.repo.importDesign({url:link}), (e:any)=>e.code==='RATE_LIMITED'&&e.retryAfter===3600&&!e.message.includes('secret'));
    assert.equal(f.calls.length,1);
  }finally{await f.cleanup()}
});

test('403 preserves access failure without persisting a false snapshot',async()=>{
  const f=await fixture(async()=>json({error:'private details'},403));try{
    await assert.rejects(()=>f.repo.importDesign({url:link}),/403/);assert.deepEqual(await f.repo.listSnapshots(),[]);
  }finally{await f.cleanup()}
});

test('rejects missing selected node rather than substituting other content',async()=>{
  const f=await fixture(async u=>u.pathname==='/v1/files/ABC123'?json(payload({id:'0:0',type:'DOCUMENT',children:[]})):undefined as any);try{
    await assert.rejects(()=>f.repo.importDesign({url:link}),/not found/i);
  }finally{await f.cleanup()}
});

test('blocks signed-asset SSRF and redirects to non-CDN destinations',async()=>{
  for (const target of ['http://127.0.0.1/private','https://localhost/private','https://evil.test/asset']) {
    const f=await fixture(async u=>u.pathname==='/v1/images/ABC123'?json({images:{'1:2':target}}):undefined as any);try{
      const s=await f.repo.importDesign({url:link});assert.equal(s.status,'partial');
      assert(!f.calls.some(c=>c.url.href===target));
    }finally{await f.cleanup()}
  }
  const f=await fixture(async u=>u.hostname.endsWith('amazonaws.com')?new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}):undefined as any);try{
    const s=await f.repo.importDesign({url:link});assert.equal(s.status,'partial');assert(!f.calls.some(c=>c.url.hostname==='127.0.0.1'));
  }finally{await f.cleanup()}
});

test('downloads used image fills, preserves references and avoids requests for unused images',async()=>{
  const doc=structuredClone(document);(doc.children[0]!.children[0]!.children[0] as any).fills=[{type:'IMAGE',imageRef:'used'}];
  const f=await fixture(async u=>u.pathname==='/v1/files/ABC123'?json(payload(doc)):u.pathname==='/v1/files/ABC123/images'?json({meta:{images:{used:'https://figma-alpha-api.s3.us-west-2.amazonaws.com/used.png',unused:'https://figma-alpha-api.s3.us-west-2.amazonaws.com/unused.png'}}}):undefined as any);try{
    const s=await f.repo.importDesign({url:link});assert(s.assets.some(a=>a.imageRef==='used'));assert(!f.calls.some(c=>c.url.pathname==='/unused.png'));
  }finally{await f.cleanup()}
});

test('extracts declared interactions and starting points, reports unknown interactions otherwise',async()=>{
  const doc=structuredClone(document);(doc.children[0] as any).flowStartingPoints=[{nodeId:'1:2',name:'Shopping'}];(doc.children[0]!.children[0]!.children[0] as any).interactions=[{trigger:{type:'ON_CLICK'},actions:[{type:'NODE',destinationId:'1:3'}]}];
  const f=await fixture(async u=>u.pathname==='/v1/files/ABC123'?json(payload(doc)):undefined as any);try{
    const s=await f.repo.importDesign({url:link});const flows=await f.repo.getFlows(s.id);assert.equal(flows.flows.length,1);assert.equal(flows.interactions.length,1);
  }finally{await f.cleanup()}
});

test('optional variables permission failure is explicit and leaves design intact',async()=>{
  const f=await fixture(async u=>u.pathname.endsWith('/variables/local')?json({error:'enterprise only'},403):undefined as any);try{
    const s=await f.repo.importDesign({url:link});const vars=await f.repo.getVariables(s.id);assert.equal(vars.available,false);assert.equal((await f.repo.load(s.id)).id,s.id);
  }finally{await f.cleanup()}
});

test('rejects traversal snapshot IDs and excessive context limits',async()=>{
  const f=await fixture();try{
    await assert.rejects(()=>f.repo.load('../../tokens'),/snapshot/i);
    const s=await f.repo.importDesign({url:link});await assert.rejects(()=>f.repo.getContext(s.id,undefined,10000,10000000),/limit|depth/i);
  }finally{await f.cleanup()}
});

test('a metadata-only cache does not silently satisfy a later screenshot import',async()=>{
  const f=await fixture();try{
    const a=await f.repo.importDesign({url:link,exportScreens:false});assert.equal(a.assets.length,0);
    const b=await f.repo.importDesign({url:link,exportScreens:true});assert.notEqual(a.id,b.id);assert(b.screens[0]?.screenshotPath);
  }finally{await f.cleanup()}
});

test('refresh retries a partial export without overwriting its original manifest',async()=>{
  let fail=true;
  const f=await fixture(async u=>fail&&u.pathname==='/v1/images/ABC123'?json({images:{'1:2':null}}):undefined as any);try{
    const a=await f.repo.importDesign({url:link});assert.equal(a.status,'partial');fail=false;
    const b=await f.repo.importDesign({url:link,refresh:true});assert.equal(b.status,'complete');assert.notEqual(a.id,b.id);assert.equal((await f.repo.load(a.id)).status,'partial');
  }finally{await f.cleanup()}
});

test('exports selected vectors pinned to version and validates node membership',async()=>{
  const f=await fixture(async u=>u.pathname==='/v1/images/ABC123'&&u.searchParams.get('format')==='svg'?json({images:{'1:2':'https://s3-alpha.figma.com/icon.svg'}}):u.pathname==='/icon.svg'?new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>'):undefined as any);try{
    const s=await f.repo.importDesign({url:link});const result=await f.repo.exportAssets(s.id,{nodeIds:['1:2'],format:'svg'});
    assert.equal(result.assets.length,1);assert.equal(result.assets[0]?.mimeType,'image/svg+xml');
    assert(f.calls.find(c=>c.url.searchParams.get('format')==='svg')?.url.searchParams.get('version')==='v1');
    await assert.rejects(()=>f.repo.exportAssets(s.id,{nodeIds:['missing']}),/not found/i);
    await assert.rejects(()=>f.repo.exportAssets(s.id,{nodeIds:[],scale:99}),/invalid/i);
  }finally{await f.cleanup()}
});

test('variables success is cached independently and undeclared flows remain unverified',async()=>{
  const f=await fixture(async u=>u.pathname.endsWith('/variables/local')?json({meta:{variables:{a:{name:'Primary',valuesByMode:{light:'#fff'}}}}}):undefined as any);try{
    const s=await f.repo.importDesign({url:link});const a=await f.repo.getVariables(s.id);assert(a.available);
    const before=f.calls.length;const b=await f.repo.getVariables(s.id);assert(b.available);assert.equal(f.calls.length,before);
    const flows=await f.repo.getFlows(s.id);assert.equal(flows.interactions.length,0);assert.match(flows.warnings.join(' '),/unverified/);
  }finally{await f.cleanup()}
});

test('rejects malformed documents, non-json API responses and oversized JSON',async()=>{
  for(const response of [()=>json({document:{id:'x',type:'DOCUMENT',children:{}},version:'v1'}),()=>new Response('not json'),()=>json({},200,{'content-length':String(100*1024*1024)})]){
    const f=await fixture(async()=>response());try{await assert.rejects(()=>f.repo.importDesign({url:link}),/malformed|invalid|oversized/i);}finally{await f.cleanup()}
  }
});

test('PAT request headers override OAuth bearer credentials and never reach asset CDN',async()=>{
  const root=await mkdtemp(join(tmpdir(),'figma-pat-'));const calls:Array<{url:URL,headers:Headers}>=[];
  const repo=new FigmaRepository({
    root,
    getAccessToken:async()=>{throw new Error('Bearer token must not be requested for a PAT')},
    getAuthHeaders:async()=>({'X-Figma-Token':'fixture-pat'}),
    fetch:(async(input:any,init?:RequestInit)=>{
      const url=new URL(String(input));const headers=new Headers(init?.headers);calls.push({url,headers});
      if(url.hostname==='api.figma.com'){
        assert.equal(headers.get('X-Figma-Token'),'fixture-pat');assert.equal(headers.get('Authorization'),null);
        if(url.pathname==='/v1/files/ABC123')return json(payload());
        if(url.pathname==='/v1/images/ABC123')return json({images:{'1:2':'https://s3-alpha.figma.com/test.png'}});
      }
      assert.equal(headers.get('X-Figma-Token'),null);assert.equal(headers.get('Authorization'),null);
      return new Response(PNG,{headers:{'content-type':'image/png'}});
    }) as typeof fetch,
  });
  try{
    const s=await repo.importDesign({url:link});assert.equal(s.status,'complete');assert(calls.some(c=>c.url.hostname==='s3-alpha.figma.com'));
    const before=calls.length;assert.equal((await repo.importDesign({url:link})).id,s.id);assert.equal(calls.length,before);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('explicit exports remain discoverable after process restart without rewriting the immutable snapshot',async()=>{
  const f=await fixture(async u=>u.pathname==='/v1/images/ABC123'?json({images:Object.fromEntries((u.searchParams.get('ids')??'').split(',').map(id=>[id,`https://s3-alpha.figma.com/${id.replace(':','-')}.svg`]))}):u.hostname==='s3-alpha.figma.com'?new Response(`<svg xmlns="http://www.w3.org/2000/svg"><title>${u.pathname}</title></svg>`):undefined as any);try{
    const s=await f.repo.importDesign({url:link,exportScreens:false});
    const path=join(f.root,'snapshots',s.id,'snapshot.json');const original=await readFile(path,'utf8');
    const output=await f.repo.exportAssets(s.id,{nodeIds:['1:2'],format:'svg'});assert.equal(output.assets.length,1);
    const offline=new FigmaRepository({root:f.root,getAccessToken:async()=>{throw Error('offline')},fetch:async()=>{throw Error('offline')}});
    assert.equal((await offline.listAssets(s.id)).length,1);assert.equal((await offline.load(s.id)).assets[0]?.nodeId,'1:2');
    assert.equal(await readFile(path,'utf8'),original);
  }finally{await f.cleanup()}
});

test('concurrent exports use independent atomic records and do not lose either asset',async()=>{
  const f=await fixture(async u=>u.pathname==='/v1/images/ABC123'?json({images:Object.fromEntries((u.searchParams.get('ids')??'').split(',').map(id=>[id,`https://s3-alpha.figma.com/${id.replace(':','-')}.svg`]))}):u.hostname==='s3-alpha.figma.com'?new Response(`<svg xmlns="http://www.w3.org/2000/svg"><title>${u.pathname}</title></svg>`):undefined as any);try{
    const s=await f.repo.importDesign({url:'https://www.figma.com/design/ABC123/Demo',exportScreens:false});
    await Promise.all([f.repo.exportAssets(s.id,{nodeIds:['1:2']}),f.repo.exportAssets(s.id,{nodeIds:['1:3']})]);
    assert.deepEqual((await f.repo.listAssets(s.id)).map(a=>a.nodeId).sort(),['1:2','1:3']);
    await f.repo.exportAssets(s.id,{nodeIds:['1:2']});assert.equal((await f.repo.listAssets(s.id)).length,2);
  }finally{await f.cleanup()}
});

test('exports support the public 100-node limit using bounded API batches',async()=>{
  const nodes=Array.from({length:100},(_,i)=>frame(`9:${i}`));
  const f=await fixture(async u=>u.pathname==='/v1/files/ABC123'?json(payload({id:'0:0',type:'DOCUMENT',children:nodes})):u.pathname==='/v1/images/ABC123'?json({images:Object.fromEntries((u.searchParams.get('ids')??'').split(',').map(id=>[id,`https://s3-alpha.figma.com/${id.replace(':','-')}.svg`]))}):u.hostname==='s3-alpha.figma.com'?new Response('<svg xmlns="http://www.w3.org/2000/svg"/>'):undefined as any);try{
    const s=await f.repo.importDesign({url:'https://figma.com/design/ABC123/Demo',exportScreens:false});
    const result=await f.repo.exportAssets(s.id,{nodeIds:nodes.map(n=>n.id)});assert.equal(result.assets.length,100);
    const calls=f.calls.filter(c=>c.url.pathname==='/v1/images/ABC123');assert.equal(calls.length,2);assert(calls.every(c=>(c.url.searchParams.get('ids')??'').split(',').length<=50));
    assert.equal((await f.repo.listAssets(s.id)).length,100);
  }finally{await f.cleanup()}
});
