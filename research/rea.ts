import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

const locatorSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('css'),selector:z.string().min(1).max(2000)}).strict(),
  z.object({kind:z.literal('test_id'),value:z.string().min(1).max(500)}).strict(),
  z.object({kind:z.literal('role'),role:z.enum(['button','checkbox','combobox','dialog','link','listbox','menuitem','option','radio','slider','spinbutton','switch','tab','textbox']),name:z.string().min(1).max(500)}).strict(),
]);
const common={stepId:z.string().regex(/^[A-Za-z][A-Za-z0-9._-]*$/).max(80).optional(),timeoutMs:z.number().int().min(1).max(30_000).optional()};
export const reaActionSchema=z.discriminatedUnion('action',[
  z.object({...common,action:z.literal('click'),locator:locatorSchema}).strict(),
  z.object({...common,action:z.literal('press'),locator:locatorSchema,key:z.string().regex(/^[A-Za-z0-9+._-]+$/).max(64)}).strict(),
  z.object({...common,action:z.literal('wait_for'),locator:locatorSchema,state:z.enum(['attached','detached','visible','hidden']).default('visible')}).strict(),
  z.object({stepId:common.stepId,action:z.literal('wait_for_timeout'),durationMs:z.number().int().min(1).max(30_000)}).strict(),
  z.object({...common,action:z.literal('goto'),url:z.string().url()}).strict(),
]);
export type ReaAction=z.input<typeof reaActionSchema>;
export interface ReaClient {
  listTools():Promise<{tools:Array<{name:string}>}>;
  callTool(input:{name:string;arguments?:Record<string,unknown>},...rest:any[]):Promise<unknown>;
  close():Promise<void>;
}
export interface ReaOptions {root:string;command?:string;clientFactory?:()=>Promise<ReaClient>}
export interface FlowInput {url:string;actions:ReaAction[];cdpEndpoint?:string;targetId?:string;executablePath?:string;headless?:boolean;viewport?:{width:number;height:number;deviceScaleFactor?:number}}
export interface EvidenceSummary {
  evidenceId:string|null;evidencePath:string;completeness:string;status:'recorded'|'error';
  artifacts:Array<{path:string;mediaType:string;stepId?:string}>;limitations:string[];
}

function loopbackEndpoint(value:string):string {
  const url=new URL(value);
  if(!['http:','ws:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash)throw new Error('CDP requires a literal loopback endpoint http://127.0.0.1:PORT');
  return value;
}
function checkedUrl(value:string):URL {
  const url=new URL(value);
  const figma=url.protocol==='https:'&&['figma.com','www.figma.com'].includes(url.hostname);
  const fixture=url.protocol==='http:'&&url.hostname==='127.0.0.1';
  if((!figma&&!fixture)||url.username||url.password)throw new Error('Flows require a Figma HTTPS URL or a loopback fixture URL');
  for(const key of url.searchParams.keys())if(/token|password|secret|authorization/i.test(key))throw new Error('Secret-bearing query parameters are not accepted');
  return url;
}
function destination(url:URL){
  const query=[...url.searchParams].map(([name,value])=>({name,value:{source:'literal',value}}));
  const clean=new URL(url);clean.search='';
  return {url:clean.href,query};
}
function record(value:unknown):Record<string,any>{return value&&typeof value==='object'?value as Record<string,any>:{};}
function evidenceOf(result:unknown):Record<string,any>{
  const r=record(result);if(r.structuredContent&&typeof r.structuredContent==='object')return r.structuredContent;
  for(const item of r.content??[])if(item.type==='text'){try {const parsed=JSON.parse(item.text);if(parsed.evidence_id)return parsed;}catch{/* Non-JSON diagnostic is not an Evidence record. */}}
  return {};
}

export class ReaBridge {
  private clientPromise:Promise<ReaClient>|undefined;
  constructor(private options:ReaOptions){}
  private async client():Promise<ReaClient>{
    if(!this.clientPromise){
      this.clientPromise=(async()=>{
        if(this.options.clientFactory)return this.options.clientFactory();
        const client=new Client({name:'local-figma-rea',version:'0.1.0'});
        await client.connect(new StdioClientTransport({command:this.options.command??'rea',args:['--mcp'],stderr:'pipe'}));
        return client as unknown as ReaClient;
      })();
      this.clientPromise.catch(()=>{this.clientPromise=undefined;});
    }
    return this.clientPromise;
  }
  async status():Promise<{available:boolean;tools:string[];limitations:string[]}>{
    try {
      const {tools}=await(await this.client()).listTools();
      return {available:true,tools:tools.map(t=>t.name),limitations:['Installed REA supports locator clicks; coordinate clicks and hover are not exposed by this bridge.','OAuth API authorization does not create a browser login session.']};
    }catch{return {available:false,tools:[],limitations:['REA is unavailable. Install or configure rea on PATH; client configuration was not changed.']};}
  }
  async listTargets(cdpEndpoint:string):Promise<EvidenceSummary>{
    return this.capture('list_browser_targets',{cdp_endpoint:loopbackEndpoint(cdpEndpoint),allowed_origins:['https://www.figma.com','https://figma.com']});
  }
  async inspectPage(cdpEndpoint:string,targetId:string):Promise<EvidenceSummary>{
    if(!targetId||targetId.length>500)throw new Error('An explicit browser target is required');
    return this.capture('inspect_web_page',{cdp_endpoint:loopbackEndpoint(cdpEndpoint),target_id:targetId,allowed_origins:['https://www.figma.com','https://figma.com'],observation_ms:500,include_accessibility_text:true,include_console_text:false,include_script_sources:false,include_storage_keys:false,include_storage_fingerprints:false,include_json_body_shapes:false,include_websocket_shapes:false});
  }
  async recordFlow(input:FlowInput):Promise<EvidenceSummary>{
    const url=checkedUrl(input.url);
    if(input.actions.length<1||input.actions.length>100)throw new Error('Provide between 1 and 100 explicit actions');
    const actions=input.actions.map((raw,index)=>{
      const parsed=reaActionSchema.safeParse(raw);if(!parsed.success)throw new Error('Invalid or unsupported action, locator, duration or wait');
      const a=parsed.data;const base={step_id:a.stepId??`step-${index+1}`};
      if(a.action==='wait_for_timeout')return {...base,action:a.action,duration_ms:a.durationMs};
      const bounded={...base,action:a.action,timeout_ms:a.timeoutMs??10_000};
      if(a.action==='goto'){
        const to=checkedUrl(a.url);if(to.origin!==url.origin)throw new Error('Flow navigation must remain on its declared origin');
        return {...bounded,destination:destination(to),wait_until:'domcontentloaded'};
      }
      if(a.action==='press')return {...bounded,locator:a.locator,key:a.key};
      if(a.action==='wait_for')return {...bounded,locator:a.locator,state:a.state};
      return {...bounded,locator:a.locator};
    });
    const stepIds=actions.map(a=>a.step_id);if(new Set(stepIds).size!==stepIds.length)throw new Error('Action step ids must be unique');
    const duration=actions.reduce((sum,a)=>sum+('duration_ms'in a?a.duration_ms:a.timeout_ms),0);
    if(duration>300_000)throw new Error('Flow action duration budget exceeds five minutes');
    let browser:Record<string,unknown>;
    if(input.cdpEndpoint||input.targetId){
      if(!input.cdpEndpoint||!input.targetId)throw new Error('Connect mode requires both CDP endpoint and explicit target id');
      if(input.executablePath)throw new Error('Choose connect mode or a launch executable, not both');
      browser={mode:'connect',cdp_endpoint:loopbackEndpoint(input.cdpEndpoint),target_id:input.targetId};
    }else{
      if(!input.executablePath||!isAbsolute(input.executablePath)||input.executablePath.includes('\0'))throw new Error('Launch mode requires an absolute browser executable path');
      browser={mode:'launch',executable_path:input.executablePath,headless:input.headless??true};
    }
    const view=input.viewport??{width:1280,height:720,deviceScaleFactor:1};
    if(!Number.isInteger(view.width)||!Number.isInteger(view.height)||view.width<1||view.height<1||view.width*view.height>4_194_304)throw new Error('Viewport must contain at most 4 megapixels');
    const dpr=view.deviceScaleFactor??1;if(!Number.isFinite(dpr)||dpr<=0||dpr>2)throw new Error('Invalid viewport scale');
    return this.capture('capture_browser_scenario',{
      browser,start_url:destination(url),actions,
      environment:{viewport:{width:view.width,height:view.height,device_scale_factor:dpr},reduced_motion:'no-preference'},
      capture:{after_each_step:['screenshot','url'],at_end:['screenshot','dom','accessibility','url'],events:[],network:{request_body:false,response_body:false,header_values:false}},
    },duration+30_000);
  }
  private async capture(name:string,args:Record<string,unknown>,timeout=60_000):Promise<EvidenceSummary>{
    const raw=await(await this.client()).callTool({name,arguments:args},undefined,{timeout});
    const serialized=JSON.stringify(raw,null,2);if(Buffer.byteLength(serialized)>128*1024*1024)throw new Error('REA evidence exceeded the 128 MiB retention budget');
    const directory=join(this.options.root,'evidence',randomUUID());await mkdir(directory,{recursive:true,mode:0o700});
    const evidencePath=join(directory,'evidence.json');await writeFile(evidencePath,serialized,{mode:0o600,flag:'wx'});
    const evidence=evidenceOf(raw);const normalized=record(evidence.normalized_result);
    const limitations=[...(Array.isArray(evidence.limitations)?evidence.limitations:[]),...(Array.isArray(normalized.limitations)?normalized.limitations:[])].filter((x):x is string=>typeof x==='string');
    const artifacts:EvidenceSummary['artifacts']=[];
    const steps=Array.isArray(normalized.steps)?normalized.steps:[];
    for(const [index,step] of steps.entries()){
      const screenshot=record(record(record(step).artifacts).screenshot);
      const value=record(screenshot.value);
      if(screenshot.state!=='captured'||value.media_type!=='image/png'||typeof value.data_base64!=='string')continue;
      const bytes=Buffer.from(value.data_base64,'base64');
      if(bytes.length>32*1024*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))continue;
      const path=join(directory,`step-${index}.png`);await writeFile(path,bytes,{mode:0o600,flag:'wx'});
      artifacts.push({path,mediaType:'image/png',...(typeof step.step_id==='string'?{stepId:step.step_id}:{})});
    }
    const missing=!evidence.evidence_id;const isError=record(raw).isError===true||missing;
    if(missing)limitations.push('REA returned no structured Evidence record; inspect the saved diagnostic.');
    return {status:isError?'error':'recorded',evidenceId:typeof evidence.evidence_id==='string'?evidence.evidence_id:null,evidencePath,completeness:normalized.completeness?.status??'unknown',artifacts,limitations:[...new Set(limitations)]};
  }
  async close():Promise<void>{const pending=this.clientPromise;this.clientPromise=undefined;if(pending){try{await(await pending).close();}catch{/* A failed or terminated transport is already closed. */}}}
}
