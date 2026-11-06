import {z} from 'zod';
import type {DesignNode} from './design.js';

export const implementationProfileSchema = z.object({
  platform:z.enum(['auto','android','ios','web','desktop']).default('auto'),
  framework:z.string().trim().min(1).max(160).optional(),
  components:z.enum(['project-first','library-first','custom']).default('project-first'),
  componentLibrary:z.string().trim().min(1).max(160).optional(),
  skills:z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  systemUi:z.enum(['native','reference']).default('native'),
}).strict().refine(p=>p.components!=='library-first'||!!p.componentLibrary,{
  message:'componentLibrary is required for library-first',path:['componentLibrary'],
});
export type ImplementationProfileInput = z.input<typeof implementationProfileSchema>;
type ChromeRole = 'status-bar'|'home-indicator'|'system-navigation-bar'|'display-cutout';
interface Bounds {x:number;y:number;width:number;height:number}
export interface ChromeCandidate {
  nodeId:string;name:string;role:ChromeRole;
  action:'use-platform-ui'|'reference-only-reproduction';
  evidence:'layer-name-and-edge-position';
}

function bounds(node:DesignNode):Bounds|undefined {
  const b=node.absoluteBoundingBox as Bounds|undefined;
  return b&&[b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.width>0&&b.height>0?b:undefined;
}

/** Heuristics annotate source evidence; they never delete or reinterpret source nodes. */
export function buildImplementationGuidance(root:DesignNode,input:ImplementationProfileInput={}) {
  const profile=implementationProfileSchema.parse(input);
  const systemUiCandidates:ChromeCandidate[]=[];
  const rootBounds=bounds(root);
  const stack=[root];let inspected=0;let systemUiCandidatesTruncated=false;
  while(stack.length){
    const node=stack.pop()!;
    if(++inspected>150_000){systemUiCandidatesTruncated=true;break;}
    if(node.visible===false)continue;
    const b=bounds(node);const sourceName=typeof node.name==='string'?node.name:'';
    const name=sourceName.toLowerCase().replace(/[_-]+/g,' ');
    let role:ChromeRole|undefined;
    if(rootBounds&&b&&b.height<=96){
      const top=b.y>=rootBounds.y-1&&b.y+b.height<=rootBounds.y+Math.min(96,rootBounds.height);
      const bottom=b.y>=rootBounds.y+rootBounds.height-Math.min(96,rootBounds.height)&&b.y+b.height<=rootBounds.y+rootBounds.height+1;
      if(top&&/\bstatus\s*bars?\b|\bbarra\s+(?:de\s+)?estado\b/u.test(name))role='status-bar';
      else if(bottom&&/\bhome\s*indicator\b|\bindicador\s+(?:de\s+)?inicio\b/u.test(name))role='home-indicator';
      else if(bottom&&/\bsystem\s+navigation\s+bar\b|\bbarra\s+de\s+navegaci[oó]n\s+del?\s+sistema\b/u.test(name))role='system-navigation-bar';
      else if(top&&/\bdynamic\s+island\b|\bnotch\b|\bdisplay\s+cutout\b/u.test(name))role='display-cutout';
    }
    if(role){
      if(systemUiCandidates.length<50)systemUiCandidates.push({nodeId:node.id,name:sourceName,role,
        action:profile.systemUi==='native'?'use-platform-ui':'reference-only-reproduction',evidence:'layer-name-and-edge-position'});
      else systemUiCandidatesTruncated=true;
      continue;
    }
    for(let i=(node.children?.length??0)-1;i>=0;i--)stack.push(node.children![i]!);
  }
  return {
    profile,systemUiCandidates,systemUiCandidatesTruncated,
    sourcePreserved:true,clientValidationRequired:true,skillsExecuted:false,
    workflow:[
      'Read the destination project instructions, design tokens and existing components before generating code.',
      'Use the requested framework and verify available skills in the client; skill hints are preferences, not commands executed by this MCP.',
      profile.components==='project-first'
        ?'Reuse project components first; use its existing library next, and create custom UI only when no suitable component exists.'
        :profile.components==='library-first'
          ?'Verify the named library and version in the destination project; map design roles to its documented components without inventing APIs.'
          :'Build custom app components using the destination project conventions and design tokens.',
      profile.systemUi==='native'
        ?'Use native system bars and safe-area/window insets. Do not draw the Figma clock, battery, home indicator or device cutout. Preserve app-owned headers and navigation.'
        :'Reference-only reproduction of system decorations was explicitly requested; do not describe decorations as real platform state.',
      'Implement app text, layout, semantics and actions as real controls; export only necessary artwork instead of using a full-screen reference image as UI.',
      'Verify functional behavior and accessibility separately from visual similarity.',
    ],
    comparison:{scope:profile.systemUi==='native'?'app-content':'full-reference',
      guidance:'When native chrome differs, supply explicit referenceRegion and actualRegion in pixel coordinates. Match app-owned regions without scaling; record every region and do not claim full-screen parity from cropped results.'},
    limitations:[
      'System UI candidates use names and edge geometry, not authoritative platform metadata. Confirm candidates in the reference; unnamed or unusual layers may be missed.',
      'The MCP does not inspect your destination repository, load client skills, install libraries or generate platform code. The connected client resolves these preferences.',
      ...(systemUiCandidatesTruncated?['Candidate inspection/output was bounded; inspect remaining source layers before making exhaustive claims.']:[]),
    ],
  };
}
