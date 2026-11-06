import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PNG} from 'pngjs';

async function fixture(t:{after(fn:()=>Promise<void>):void},width=100,height=80){
  const root=await mkdtemp(join(tmpdir(),'figma-diff-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const a=new PNG({width,height});a.data.fill(255);
  const b=new PNG({width,height});b.data.fill(255);
  const referencePath=join(root,'ref.png'),actualPath=join(root,'actual.png'),outputDir=join(root,'report');
  await writeFile(referencePath,PNG.sync.write(a));
  return {root,a,b,referencePath,actualPath,outputDir};
}
test('identical screens pass and produce usable self-contained artifacts',async t=>{
  const f=await fixture(t);await writeFile(f.actualPath,PNG.sync.write(f.b));
  const {compareScreens}=await import('../src/compare.js');const r=await compareScreens(f);
  assert.equal(r.status,'pass');assert.equal(r.diffPixels,0);assert.equal(r.diffRatio,0);
  assert.ok(await readFile(r.reportPath!,'utf8'));assert.equal(PNG.sync.read(await readFile(r.diffPath!)).width,100);
});
test('a changed solid region fails with a measured pixel ratio',async t=>{
  const f=await fixture(t);
  for(let y=20;y<40;y++)for(let x=20;x<40;x++){const i=(y*f.b.width+x)*4;f.b.data[i]=0;f.b.data[i+1]=0;f.b.data[i+2]=0;}
  await writeFile(f.actualPath,PNG.sync.write(f.b));
  const {compareScreens}=await import('../src/compare.js');const r=await compareScreens(f);
  assert.equal(r.status,'fail');assert.equal(r.diffPixels,400);assert.equal(r.diffRatio,0.05);
});
test('explicit tolerance can accept a known difference',async t=>{
  const f=await fixture(t);f.b.data[0]=0;f.b.data[1]=0;f.b.data[2]=0;await writeFile(f.actualPath,PNG.sync.write(f.b));
  const {compareScreens}=await import('../src/compare.js');const r=await compareScreens({...f,maxDiffRatio:0.1});assert.equal(r.status,'pass');
});
test('different dimensions are incomparable and never stretched',async t=>{
  const f=await fixture(t);const other=new PNG({width:50,height:80});other.data.fill(255);await writeFile(f.actualPath,PNG.sync.write(other));
  const {compareScreens}=await import('../src/compare.js');const r=await compareScreens(f);
  assert.equal(r.status,'incomparable');assert.match(r.limitations.join(' '),/dimensions/i);
});
test('malformed PNG is rejected before creating a misleading comparison',async t=>{
  const f=await fixture(t);await writeFile(f.actualPath,'not a PNG');const {compareScreens}=await import('../src/compare.js');await assert.rejects(()=>compareScreens(f),/PNG/i);
});
test('invalid tolerance and oversized IHDR are rejected',async t=>{
  const f=await fixture(t);await writeFile(f.actualPath,PNG.sync.write(f.b));const {compareScreens}=await import('../src/compare.js');
  await assert.rejects(()=>compareScreens({...f,threshold:2}),/threshold/i);
  const bytes=PNG.sync.write(f.a);bytes.writeUInt32BE(100000,16);bytes.writeUInt32BE(100000,20);await writeFile(f.actualPath,bytes);
  await assert.rejects(()=>compareScreens(f),/32|large|pixels/i);
});

test('explicit per-image regions compare app content without reproducing OS chrome',async t=>{
  const f=await fixture(t);
  // Different system bar heights, same app-owned black area.
  for(let y=0;y<10;y++)for(let x=0;x<100;x++){const i=(y*100+x)*4;f.a.data[i]=0;f.a.data[i+1]=0;f.a.data[i+2]=0;}
  for(let y=70;y<80;y++)for(let x=0;x<100;x++){const i=(y*100+x)*4;f.b.data[i]=0;f.b.data[i+1]=0;f.b.data[i+2]=0;}
  await writeFile(f.referencePath,PNG.sync.write(f.a));await writeFile(f.actualPath,PNG.sync.write(f.b));
  const {compareScreens}=await import('../src/compare.js');
  const r=await compareScreens({...f,referenceRegion:{x:0,y:10,width:100,height:60},actualRegion:{x:0,y:0,width:100,height:60}});
  assert.equal(r.status,'pass');assert.equal(r.diffPixels,0);
  assert.deepEqual(r.referenceDimensions,{width:100,height:80});
  assert.deepEqual(r.comparedDimensions,{width:100,height:60});
  assert.deepEqual(r.referenceRegion,{x:0,y:10,width:100,height:60});
  assert.match(r.limitations.join(' '),/region|crop/i);
  assert.equal(PNG.sync.read(await readFile(r.referencePath!)).height,60);
  assert.match(await readFile(r.reportPath!,'utf8'),/reference region|reference crop/i);
});

test('regions reject empty, fractional and out-of-bounds rectangles and keep mismatched crops incomparable',async t=>{
  const f=await fixture(t);await writeFile(f.actualPath,PNG.sync.write(f.b));
  const {compareScreens}=await import('../src/compare.js');
  for(const region of [{x:-1,y:0,width:10,height:10},{x:0,y:0,width:0,height:1},{x:.5,y:0,width:10,height:10},{x:90,y:0,width:11,height:10},{x:0,y:0,width:1,height:81}]) {
    await assert.rejects(()=>compareScreens({...f,referenceRegion:region}),/region|rectangle/i);
  }
  const r=await compareScreens({...f,referenceRegion:{x:0,y:0,width:20,height:20},actualRegion:{x:0,y:0,width:21,height:20}});
  assert.equal(r.status,'incomparable');
});
