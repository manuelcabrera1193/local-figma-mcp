import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const client=new Client({name:'local-figma-smoke',version:'0.2.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/src/index.js',import.meta.url))],
  env:Object.fromEntries(Object.entries(process.env).filter((item):item is [string,string]=>typeof item[1]==='string')),stderr:'pipe'});
const report:Record<string,unknown>={transport:'stdio',realFigma:false};
async function call(name:string,args:Record<string,unknown>={}) {
  const result=await client.callTool({name,arguments:args},undefined,{timeout:120_000});
  const blocks=result.content as Array<{type:string;text?:string}>;
  const block=blocks.find(c=>c.type==='text'&&c.text);
  const data=block?.text?JSON.parse(block.text):{};
  if(result.isError)throw new Error(JSON.stringify(data));
  return {data,hasImage:blocks.some(c=>c.type==='image')};
}
try {
  await client.connect(transport);
  report.toolCount=(await client.listTools()).tools.length;
  report.auth=(await call('figma_auth_status')).data;
  report.cachedSnapshots=(await call('figma_list_snapshots')).data.snapshots.length;
  const index=process.argv.indexOf('--url');
  if(index>=0){
    const url=process.argv[index+1];if(!url)throw new Error('--url requires a Figma link');
    const started=(await call('figma_import',{url})).data;
    const deadline=Date.now()+300_000;let job;
    do {
      job=(await call('figma_job_status',{jobId:started.id})).data;
      if(['complete','failed','interrupted'].includes(job.status))break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }while(Date.now()<deadline);
    if(job?.status!=='complete'){report.job=job;throw new Error('Figma import did not complete; see safe job details.');}
    report.realFigma=true;report.import=job.result;
    const snapshotId=job.result.snapshotId;
    const context=(await call('get_design_context',{snapshotId,depth:4,limit:500})).data;
    report.context={nodeId:context.context.node.id,type:context.context.node.type,name:context.context.node.name,nodeCount:context.context.nodeCount,truncated:context.context.truncated};
    report.screens=(await call('figma_list_screens',{snapshotId})).data.screens;
    const screenshot=await call('get_screenshot',{snapshotId});report.screenshot={...screenshot.data,inlineImage:screenshot.hasImage};
    report.assets=(await call('download_assets',{snapshotId})).data;
    report.result='PASS';
  }else report.result='PASS: local MCP transport and tools; no external import requested';
}catch(error){report.result='FAIL';report.error=error instanceof Error?error.message:'Smoke failed';process.exitCode=1;}
finally{
  await client.close();
  const directory=fileURLToPath(new URL('../artifacts/',import.meta.url));await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(join(directory,'mcp-smoke-result.json'),JSON.stringify(report,null,2),{mode:0o600});
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
}
