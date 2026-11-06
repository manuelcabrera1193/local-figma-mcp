import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildImplementationGuidance, implementationProfileSchema} from '../src/implementation.js';
import type {DesignNode} from '../src/design.js';

const box = (x:number,y:number,width:number,height:number)=>({x,y,width,height});
const layer = (id:string,name:string,bounds=box(0,0,375,50)):DesignNode=>({id,name,type:'FRAME',absoluteBoundingBox:bounds});
const screen = (children:DesignNode[]):DesignNode=>({...layer('1:1','App screen',box(0,0,375,812)),children});

test('defaults use native system UI and project components while preserving the source',()=>{
  const root=screen([layer('1:2','_status-bars'),layer('1:3','Home indicator',box(0,790,375,22)),layer('1:4','flow-navbar',box(0,50,375,64))]);
  const before=structuredClone(root);
  const result=buildImplementationGuidance(root);
  assert.equal(result.profile.systemUi,'native');
  assert.equal(result.profile.components,'project-first');
  assert.deepEqual(result.systemUiCandidates.map(x=>[x.nodeId,x.role,x.action]),[
    ['1:2','status-bar','use-platform-ui'],['1:3','home-indicator','use-platform-ui'],
  ]);
  assert.equal(result.comparison.scope,'app-content');
  assert.deepEqual(root,before);
});

test('explicit framework, library and skill hints are returned as client preferences',()=>{
  const profile=implementationProfileSchema.parse({platform:'android',framework:'Jetpack Compose',components:'library-first',componentLibrary:'androidx.compose.material3',skills:['figma-to-compose']});
  const result=buildImplementationGuidance(screen([]),profile);
  assert.equal(result.profile.componentLibrary,'androidx.compose.material3');
  assert.deepEqual(result.profile.skills,['figma-to-compose']);
  assert.equal(result.clientValidationRequired,true);
  assert.equal(result.skillsExecuted,false);
  assert.match(result.workflow.join(' '),/existing|project/i);
});

test('reference chrome must be explicitly requested and custom components remain possible',()=>{
  const result=buildImplementationGuidance(screen([layer('1:2','Status bar')]),implementationProfileSchema.parse({systemUi:'reference',components:'custom'}));
  assert.equal(result.systemUiCandidates[0]?.action,'reference-only-reproduction');
  assert.equal(result.comparison.scope,'full-reference');
});

test('does not classify app bars, hidden chrome or status-named content in the middle',()=>{
  const root=screen([
    layer('1:2','TopAppBar'),layer('1:3','bottom-navigation',box(0,740,375,72)),
    layer('1:4','Status bar',box(0,350,375,40)),
    {...layer('1:5','Hidden group'),visible:false,children:[layer('1:6','Status bar')]},
    layer('1:7','Status bar',box(0,0,375,812)),
    layer('1:8','SafeArea container',box(0,0,375,812)),
  ]);
  assert.deepEqual(buildImplementationGuidance(root).systemUiCandidates,[]);
});

test('candidate output is bounded and does not double count children of system chrome',()=>{
  const result=buildImplementationGuidance(screen(Array.from({length:60},(_,i)=>({...layer(`1:${i+2}`,'Status bar'),children:[layer(`2:${i+2}`,'Dynamic Island')]}))));
  assert.equal(result.systemUiCandidates.length,50);
  assert.equal(result.systemUiCandidatesTruncated,true);
});

test('rejects unknown profiles, missing library and unbounded skill lists',()=>{
  for(const input of [{systemUi:'guess'},{components:'library-first'},{skills:Array(11).fill('compose')},{framework:'x'.repeat(161)},{extra:'unsupported'}]) {
    assert.equal(implementationProfileSchema.safeParse(input).success,false);
  }
});
