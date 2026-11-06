import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface ComparisonRegion {x:number;y:number;width:number;height:number}
export interface ComparisonInput {referencePath:string;actualPath:string;outputDir:string;threshold?:number;maxDiffRatio?:number;referenceRegion?:ComparisonRegion;actualRegion?:ComparisonRegion}
export interface ComparisonResult {
  status:'pass'|'fail'|'incomparable';diffPixels:number|null;diffRatio:number|null;
  referenceDimensions:{width:number;height:number};actualDimensions:{width:number;height:number};
  threshold:number;maxDiffRatio:number;limitations:string[];
  comparedDimensions?:{width:number;height:number};
  referenceRegion?:ComparisonRegion;actualRegion?:ComparisonRegion;
  comparisonScope:'full-image'|'selected-regions';
  reportPath?:string;referencePath?:string;actualPath?:string;diffPath?:string;overlayPath?:string;
}
function crop(source:PNG,region:ComparisonRegion|undefined):PNG {
  if(!region)return source;
  const {x,y,width,height}=region;
  if(![x,y,width,height].every(Number.isInteger)||x<0||y<0||width<1||height<1||x+width>source.width||y+height>source.height)throw Error('Comparison region must be an integer rectangle inside the source image');
  const result=new PNG({width,height});
  for(let row=0;row<height;row++){
    const start=((y+row)*source.width+x)*4;
    source.data.copy(result.data,row*width*4,start,start+width*4);
  }
  return result;
}
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
async function readPng(path:string):Promise<PNG>{
  if((await stat(path)).size>64*1024*1024)throw new Error('PNG compressed file exceeds 64 MiB');
  const bytes=await readFile(path);
  if(bytes.length<24||!bytes.subarray(0,8).equals(signature)||bytes.toString('ascii',12,16)!=='IHDR')throw new Error('Expected a valid PNG image');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(width<1||height<1||width*height>32_000_000)throw new Error('PNG exceeds the 32 megapixel limit');
  try{return PNG.sync.read(bytes,{checkCRC:true});}catch{throw new Error('PNG image could not be decoded');}
}
export async function compareScreens(input:ComparisonInput):Promise<ComparisonResult>{
  const threshold=input.threshold??0.1,maxDiffRatio=input.maxDiffRatio??0.01;
  if(!Number.isFinite(threshold)||threshold<0||threshold>1)throw new Error('threshold must be between 0 and 1');
  if(!Number.isFinite(maxDiffRatio)||maxDiffRatio<0||maxDiffRatio>1)throw new Error('maxDiffRatio must be between 0 and 1');
  const [referenceSource,actualSource]=await Promise.all([readPng(input.referencePath),readPng(input.actualPath)]);
  const reference=crop(referenceSource,input.referenceRegion),actual=crop(actualSource,input.actualRegion);
  const selected=!!(input.referenceRegion||input.actualRegion);
  const result:ComparisonResult={status:'incomparable',diffPixels:null,diffRatio:null,referenceDimensions:{width:referenceSource.width,height:referenceSource.height},actualDimensions:{width:actualSource.width,height:actualSource.height},threshold,maxDiffRatio,comparisonScope:selected?'selected-regions':'full-image',limitations:['Pixel differences are visual evidence and do not prove functional correctness.']};
  if(input.referenceRegion)result.referenceRegion={...input.referenceRegion};
  if(input.actualRegion)result.actualRegion={...input.actualRegion};
  if(selected)result.limitations.push('Only the explicitly selected regions were compared. No scaling was applied; differences outside the cropped regions were not evaluated.');
  if(reference.width!==actual.width||reference.height!==actual.height){result.limitations.push('Image dimensions differ. Supply an explicitly cropped or scaled image; no automatic stretching was applied.');return result;}
  result.comparedDimensions={width:reference.width,height:reference.height};
  const diff=new PNG({width:reference.width,height:reference.height});
  const overlay=new PNG({width:reference.width,height:reference.height});
  const count=pixelmatch(reference.data,actual.data,diff.data,reference.width,reference.height,{threshold});
  for(let i=0;i<reference.data.length;i++)overlay.data[i]=Math.round((reference.data[i]!+actual.data[i]!)/2);
  result.diffPixels=count;result.diffRatio=count/(reference.width*reference.height);result.status=result.diffRatio<=maxDiffRatio?'pass':'fail';
  const dir=join(input.outputDir,randomUUID());await mkdir(dir,{recursive:true,mode:0o700});
  result.referencePath=join(dir,'reference.png');result.actualPath=join(dir,'actual.png');result.diffPath=join(dir,'diff.png');result.overlayPath=join(dir,'overlay.png');result.reportPath=join(dir,'index.html');
  await Promise.all([
    writeFile(result.referencePath,PNG.sync.write(reference),{mode:0o600,flag:'wx'}),
    writeFile(result.actualPath,PNG.sync.write(actual),{mode:0o600,flag:'wx'}),
    writeFile(result.diffPath,PNG.sync.write(diff),{mode:0o600,flag:'wx'}),
    writeFile(result.overlayPath,PNG.sync.write(overlay),{mode:0o600,flag:'wx'}),
    writeFile(join(dir,'report.css'),'body{font:16px system-ui;margin:32px;background:#fafafa;color:#171717}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}img{width:100%;height:auto;border:1px solid #ddd}figure{margin:0}figcaption{font-weight:600;margin-bottom:8px}',{mode:0o600,flag:'wx'}),
  ]);
  const percentage=(result.diffRatio*100).toFixed(3);
  const describeRegion=(r:ComparisonRegion|undefined)=>r?`x=${r.x}, y=${r.y}, width=${r.width}, height=${r.height}`:'full source image';
  const scopeNote=selected?`<p>Reference region: ${describeRegion(input.referenceRegion)}. Actual region: ${describeRegion(input.actualRegion)}. Source dimensions: reference ${referenceSource.width} × ${referenceSource.height}; actual ${actualSource.width} × ${actualSource.height}. Only selected regions were evaluated; no scaling was applied.</p>`:'';
  await writeFile(result.reportPath,`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Figma comparison</title><link rel="stylesheet" href="report.css"></head><body><h1>Visual comparison${selected?' of selected regions':''}: ${result.status}</h1><p>${count} pixels differ (${percentage}%). Maximum allowed: ${(maxDiffRatio*100).toFixed(3)}%. Dimensions: ${reference.width} × ${reference.height}.</p>${scopeNote}<p>Pixel differences do not prove functional correctness.</p><main>${[['Reference','reference.png'],['Implementation','actual.png'],['Differences','diff.png'],['Overlay','overlay.png']].map(([name,file])=>`<figure><figcaption>${name}</figcaption><img src="${file}" alt="${name}"></figure>`).join('')}</main></body></html>`,{mode:0o600,flag:'wx'});
  return result;
}
