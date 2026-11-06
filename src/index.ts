#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApplication } from './server.js';
import { AuthManager } from './auth.js';
import { FigmaRepository } from './design.js';
import { dataRoot } from './paths.js';
import { publicError } from './jobs.js';
import { runInstallerCommand } from './installer.js';

const HELP = `local-figma-mcp — Figma design context on your computer

  local-figma-mcp                       Serve MCP over stdio
  local-figma-mcp login [--no-open]      Configure token locally or authorize OAuth
  local-figma-mcp token --stdin         Save a personal token from stdin; never echo it
  local-figma-mcp status                Read safe authentication status
  local-figma-mcp doctor [--json]       Read configuration and local snapshot inventory
  local-figma-mcp logout                Delete saved authorization (keep design snapshots)
  local-figma-mcp import <figma-url> [--refresh] [--no-images]
  local-figma-mcp detect [--json]        Detect MCP clients
  local-figma-mcp setup [--client codex,claude-code,vscode] [--yes] [--force]
  local-figma-mcp uninstall [--client ...] [--yes] [--force]

REA is used for development research, not required by this MCP.
Credentials live in the private per-user data directory, never client configurations.
`;

async function main():Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command==='--help'||command==='help'||command==='-h') {process.stdout.write(HELP);return;}
  if (command==='--version') {process.stdout.write('0.2.0\n');return;}
  const root = dataRoot();
  if (!command||command==='serve') {
    if(args.length>1) throw new Error('Invalid serve arguments');
    const app=createApplication({root});
    const close=()=>{void app.close().finally(()=>{process.exitCode=0;});};
    process.once('SIGINT',close);process.once('SIGTERM',close);
    await app.server.connect(new StdioServerTransport());
    return;
  }
  if(command==='detect'||command==='setup'||command==='uninstall') {
    process.exitCode=await runInstallerCommand(command,args.slice(1));return;
  }
  const auth=new AuthManager({root});
  try {
    const output=(value:unknown)=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
    if(command==='status'){output(await auth.status());return;}
    if(command==='doctor'){
      const repository=new FigmaRepository({root,getAccessToken:()=>auth.getAccessToken(),getAuthHeaders:()=>auth.getRequestHeaders()});
      output({version:'0.2.0',node:process.versions.node,reaRequired:false,auth:await auth.status(),dataRoot:root,
        snapshots:(await repository.listSnapshots()).map(s=>({id:s.id,name:s.name,status:s.status,screens:s.screens.length}))});return;
    }
    if(command==='logout'){await auth.disconnect();output({disconnected:true,cachedSnapshotsRetained:true});return;}
    if(command==='token'){
      if(args.length!==2||args[1]!=='--stdin') throw new Error('Invalid token command: use token --stdin');
      let token='';for await(const chunk of process.stdin){token+=String(chunk);if(token.length>4096)throw new Error('Token too large');}
      await auth.setPersonalToken(token.trim());output(await auth.status());return;
    }
    if(command==='login'||command==='connect'){
      const result=await auth.connect({openBrowser:!args.includes('--no-open')});output(result);
      if(result.status==='authenticated')return;
      const deadline=Date.now()+10*60_000;
      while(Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,750));
        const status=await auth.status();
        if(status.authenticated){output(status);return;}
        if(!status.pending)break;
      }
      process.exitCode=1;output({status:'not_connected',message:'Connection did not finish. Run login again.'});return;
    }
    if(command==='import'){
      const url=args[1];if(!url)throw new Error('Invalid request: provide a Figma URL');
      const repository=new FigmaRepository({root,getAccessToken:()=>auth.getAccessToken(),getAuthHeaders:()=>auth.getRequestHeaders()});
      const s=await repository.importDesign({url,refresh:args.includes('--refresh'),exportScreens:!args.includes('--no-images')});
      output({snapshotId:s.id,name:s.name,status:s.status,version:s.version,screens:s.screens,assets:s.assets,warnings:s.warnings});return;
    }
    throw new Error('Invalid command. Use local-figma-mcp --help');
  } finally {await auth.close();}
}

main().catch(error=>{process.stderr.write(JSON.stringify(publicError(error))+'\n');process.exitCode=1;});
