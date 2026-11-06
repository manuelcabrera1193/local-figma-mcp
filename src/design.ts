import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

export interface DesignNode {
  id: string;
  type: string;
  name?: string;
  children?: DesignNode[];
  [key: string]: unknown;
}
export interface Screen { nodeId: string; name: string; width: number; height: number; screenshotPath?: string }
export interface Asset { id: string; kind: 'screen' | 'image' | 'vector'; nodeId?: string; imageRef?: string; path: string; mimeType: string }
export interface Snapshot {
  id: string;
  fileKey: string;
  nodeId?: string;
  version: string;
  name: string;
  sourceUrl: string;
  importedAt: string;
  status: 'complete' | 'partial';
  warnings: string[];
  document: DesignNode;
  components: Record<string, Record<string, unknown>>;
  componentSets: Record<string, Record<string, unknown>>;
  styles: Record<string, Record<string, unknown>>;
  screens: Screen[];
  assets: Asset[];
}
export interface FigmaReference { fileKey: string; nodeId?: string; version?: string; url: string }
export class FigmaApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number, public readonly retryAfter?: number) { super(message); this.name = 'FigmaApiError'; }
}
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_NODES = 150_000;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const asRecord = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

export function parseFigmaUrl(value: string): FigmaReference {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid Figma URL'); }
  if (url.protocol !== 'https:' || !['figma.com', 'www.figma.com'].includes(url.hostname) || url.port || url.username || url.password) throw new Error('Expected a public HTTPS figma.com design, file, or prototype URL');
  const parts = url.pathname.split('/').filter(Boolean);
  const fileKey = parts[1];
  if (!['design', 'file', 'proto'].includes(parts[0] ?? '') || !fileKey || !/^[A-Za-z0-9]{3,128}$/.test(fileKey)) throw new Error('Unsupported Figma URL or file key');
  const rawNode = url.searchParams.get('node-id');
  const nodeId = rawNode?.replace(/-/g, ':');
  if (rawNode !== null && (!nodeId || !/^\d+:\d+$/.test(nodeId))) throw new Error('Invalid Figma node ID');
  const version = url.searchParams.get('version-id') ?? url.searchParams.get('version') ?? undefined;
  if (version !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(version)) throw new Error('Invalid Figma version ID');
  const canonical = new URL(`https://www.figma.com/${parts[0]}/${fileKey}`);
  if (nodeId) canonical.searchParams.set('node-id', nodeId);
  if (version) canonical.searchParams.set('version-id', version);
  return { fileKey, ...(nodeId ? { nodeId } : {}), ...(version ? { version } : {}), url: canonical.href };
}

async function privateDirectory(path: string) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
async function atomicJson(path: string, data: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}
function walk(document: DesignNode): DesignNode[] {
  const nodes: DesignNode[] = [];
  const stack: DesignNode[] = [document];
  while (stack.length) {
    const node = stack.pop()!;
    if (!node || typeof node.id !== 'string' || typeof node.type !== 'string') throw new Error('Malformed Figma node');
    nodes.push(node);
    if (nodes.length > MAX_NODES) throw new Error('Figma document exceeds node safety limit');
    if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('Malformed Figma children');
    if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return nodes;
}
function chooseScreens(root: DesignNode): Screen[] {
  const screens: Screen[] = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(node.type)) {
      const bounds = asRecord(node.absoluteBoundingBox);
      screens.push({ nodeId: node.id, name: node.name ?? node.id, width: typeof bounds.width === 'number' ? bounds.width : 0, height: typeof bounds.height === 'number' ? bounds.height : 0 });
      continue;
    }
    for (let i=(node.children?.length ?? 0)-1; i>=0; i--) stack.push(node.children![i]!);
  }
  return screens;
}
function safeCdnUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const allowed = host === 'figma.com' || host.endsWith('.figma.com') || host === 's3.amazonaws.com' || /^(?:[a-z0-9-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host) || host.endsWith('.cloudfront.net');
  if (url.protocol !== 'https:' || !allowed || url.username || url.password || url.port) throw new Error('Asset URL is not an approved HTTPS Figma CDN');
  return url;
}
async function boundedBytes(response: Response, maximum: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) { await response.body?.cancel(); throw new Error('Response exceeds size limit'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('Response exceeds size limit'); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export class FigmaRepository {
  private readonly root: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly getAuthHeaders?: () => Promise<Record<string, string>>;
  private readonly fetcher: typeof fetch;
  private readonly apiBase: string;
  constructor(options: { root: string; getAccessToken: () => Promise<string>; getAuthHeaders?: () => Promise<Record<string, string>>; fetch?: typeof fetch; apiBase?: string }) {
    this.root = options.root;
    this.getAccessToken = options.getAccessToken;
    this.getAuthHeaders = options.getAuthHeaders;
    this.fetcher = options.fetch ?? fetch;
    this.apiBase = (options.apiBase ?? 'https://api.figma.com/v1').replace(/\/$/, '');
  }
  private directory(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid snapshot ID');
    return join(this.root, 'snapshots', id);
  }
  private async request(path: string, params?: Record<string, string>): Promise<Record<string, any>> {
    const url = new URL(this.apiBase + path);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
    const authentication = this.getAuthHeaders ? await this.getAuthHeaders() : { Authorization: `Bearer ${await this.getAccessToken()}` };
    const headers = new Headers(authentication);
    headers.set('Accept', 'application/json');
    let response: Response;
    try { response = await this.fetcher(url, { headers, signal: AbortSignal.timeout(45_000), redirect: 'error' }); }
    catch { throw new FigmaApiError('NETWORK_ERROR', 'Figma API request failed or timed out'); }
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : undefined;
      const code = response.status === 429 ? 'RATE_LIMITED' : response.status === 401 || response.status === 403 ? 'ACCESS_DENIED' : 'API_ERROR';
      throw new FigmaApiError(code, `Figma API returned HTTP ${response.status}${seconds !== undefined ? `; retry after ${seconds} seconds` : ''}`, response.status, seconds);
    }
    let result: unknown;
    try { result = JSON.parse((await boundedBytes(response, MAX_JSON_BYTES)).toString('utf8')); } catch { throw new Error('Figma API returned invalid or oversized JSON'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Figma API returned an invalid response');
    return result as Record<string, any>;
  }
  private async download(value: string, directory: string, mimeType: string): Promise<{ path: string; id: string }> {
    let url = safeCdnUrl(value);
    let response: Response | undefined;
    for (let redirect = 0; redirect < 4; redirect++) {
      try { response = await this.fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(45_000) }); }
      catch { throw new Error('Asset download failed or timed out'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Asset redirect has no destination');
        url = safeCdnUrl(new URL(location, url).href);
        response = undefined;
        continue;
      }
      break;
    }
    if (!response?.ok) { await response?.body?.cancel(); throw new Error('Asset download failed'); }
    const bytes = await boundedBytes(response, MAX_ASSET_BYTES);
    if (!bytes.length) throw new Error('Asset download is empty');
    if (mimeType === 'image/png' && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Rendered asset is not a PNG');
    const id = hash(bytes);
    const extension = mimeType === 'image/svg+xml' ? 'svg' : mimeType === 'image/png' ? 'png' : 'bin';
    const path = join(directory, `${id}.${extension}`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
    return { path, id };
  }
  async listSnapshots(): Promise<Snapshot[]> {
    let entries: string[];
    try { entries = await readdir(join(this.root, 'snapshots')); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
    const results: Snapshot[] = [];
    for (const id of entries.filter(value => /^[a-f0-9]{64}$/.test(value))) {
      try { results.push(await this.load(id)); } catch { /* Incomplete imports are not published snapshots. */ }
    }
    return results.sort((a,b)=>b.importedAt.localeCompare(a.importedAt));
  }
  async load(snapshotId: string): Promise<Snapshot> {
    const directory = this.directory(snapshotId);
    const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8')) as Snapshot;
    if (snapshot.id !== snapshotId || !snapshot.document || !Array.isArray(snapshot.assets)) throw new Error('Invalid snapshot manifest');
    // Each export has an independent immutable record. Atomic publication avoids
    // lost updates when several clients export assets for the same snapshot.
    const exportsDirectory = join(directory, 'exports');
    let exportRecords: string[] = [];
    try { exportRecords = await readdir(exportsDirectory); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const assets = new Map<string, Asset>();
    const addAsset = (asset: Asset) => assets.set(JSON.stringify([asset.kind, asset.id, asset.nodeId ?? null, asset.imageRef ?? null]), asset);
    for (const asset of snapshot.assets) addAsset(asset);
    for (const recordName of exportRecords.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).sort()) {
      const record = JSON.parse(await readFile(join(exportsDirectory, recordName), 'utf8')) as { assets: Asset[] };
      if (!Array.isArray(record.assets)) throw new Error('Invalid asset export manifest');
      for (const asset of record.assets) addAsset(asset);
    }
    return { ...snapshot, assets: [...assets.values()] };
  }
  async importDesign(input: { url: string; refresh?: boolean; exportScreens?: boolean }): Promise<Snapshot> {
    const ref = parseFigmaUrl(input.url);
    if (!input.refresh) {
      const cached = (await this.listSnapshots()).find(s => s.fileKey === ref.fileKey && s.nodeId === ref.nodeId && (!ref.version || s.version === ref.version) && (input.exportScreens === false || s.screens.length === 0 || s.screens.every(screen=>!!screen.screenshotPath)));
      if (cached) return cached;
    }
    const raw = await this.request(`/files/${ref.fileKey}`, { geometry: 'paths', ...(ref.nodeId ? { ids: ref.nodeId } : {}), ...(ref.version ? { version: ref.version } : {}) });
    const document = raw.document as DesignNode;
    if (!document) throw new Error('Figma response does not contain a document');
    const nodes = walk(document);
    const selected = ref.nodeId ? nodes.find(node=>node.id === ref.nodeId) : document;
    if (!selected) throw new Error('Selected Figma node not found in response');
    if (typeof raw.version !== 'string' || !raw.version) throw new Error('Figma response has no version; cannot create reproducible reference');
    let id = hash(JSON.stringify({fileKey:ref.fileKey,nodeId:ref.nodeId ?? null,version:raw.version,exportScreens:input.exportScreens !== false}));
    try {
      const existing = await this.load(id);
      if (existing.status === 'complete') return existing;
      // Preserve failed reference evidence while retrying unavailable exports.
      id = hash(`${id}:${randomUUID()}`);
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const directory = this.directory(id);
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, 'snapshots'));
    await privateDirectory(directory);
    await privateDirectory(join(directory, 'assets'));
    const warnings: string[] = [];
    const screens = chooseScreens(selected);
    const assets: Asset[] = [];
    if (input.exportScreens !== false && screens.length) {
      for (let offset = 0; offset < screens.length; offset += 50) {
        const batch = screens.slice(offset, offset + 50);
        let rendered: Record<string, any>;
        try { rendered = await this.request(`/images/${ref.fileKey}`, { ids: batch.map(screen=>screen.nodeId).join(','), format: 'png', scale: '1', use_absolute_bounds: 'true', version: raw.version }); }
        catch (error) { warnings.push(`Screen exports unavailable: ${error instanceof Error ? error.message : 'request failed'}`); continue; }
        for (const screen of batch) {
          const value = asRecord(rendered.images)[screen.nodeId];
          if (typeof value !== 'string') { warnings.push(`Screenshot unavailable for ${screen.nodeId}`); continue; }
          try {
            const saved = await this.download(value, join(directory, 'assets'), 'image/png');
            screen.screenshotPath = saved.path;
            assets.push({ ...saved, kind: 'screen', nodeId: screen.nodeId, mimeType: 'image/png' });
          } catch (error) { warnings.push(`Screenshot unavailable for ${screen.nodeId}: ${error instanceof Error ? error.message : 'download failed'}`); }
        }
      }
    }
    const imageRefs = new Set<string>();
    for (const node of walk(selected)) for (const paints of [node.fills, node.strokes]) if (Array.isArray(paints)) for (const paint of paints) if (paint && paint.type === 'IMAGE' && typeof paint.imageRef === 'string') imageRefs.add(paint.imageRef);
    if (imageRefs.size) {
      try {
        const fills = await this.request(`/files/${ref.fileKey}/images`);
        const mapping = asRecord(fills.meta?.images ?? fills.images);
        warnings.push('Original image fills are not version-addressable in the REST API; screen references remain pinned to the document version.');
        for (const imageRef of imageRefs) {
          if (typeof mapping[imageRef] !== 'string') { warnings.push(`Original image unavailable for ${imageRef}`); continue; }
          try {
            const saved = await this.download(mapping[imageRef], join(directory,'assets'), 'application/octet-stream');
            assets.push({...saved,kind:'image',imageRef,mimeType:'application/octet-stream'});
          } catch (error) { warnings.push(`Original image unavailable for ${imageRef}: ${error instanceof Error ? error.message : 'download failed'}`); }
        }
      } catch (error) { warnings.push(`Original images unavailable: ${error instanceof Error ? error.message : 'request failed'}`); }
    }
    const snapshot: Snapshot = {id,fileKey:ref.fileKey,...(ref.nodeId ? {nodeId:ref.nodeId}:{}),version:raw.version,name:typeof raw.name==='string'?raw.name:ref.fileKey,sourceUrl:ref.url,importedAt:new Date().toISOString(),status:warnings.length?'partial':'complete',warnings,document,components:asRecord(raw.components),componentSets:asRecord(raw.componentSets),styles:asRecord(raw.styles),screens,assets};
    await atomicJson(join(directory,'raw.json'),raw);
    await atomicJson(join(directory,'snapshot.json'),snapshot);
    return snapshot;
  }
  async listScreens(snapshotId: string): Promise<Screen[]> { return (await this.load(snapshotId)).screens; }
  async listAssets(snapshotId: string): Promise<Asset[]> { return (await this.load(snapshotId)).assets; }
  async getScreenshot(snapshotId: string, nodeId: string): Promise<Asset> {
    const snapshot = await this.load(snapshotId);
    const asset = snapshot.assets.find(a=>a.kind==='screen' && a.nodeId===nodeId);
    if (!asset) throw new Error('Screenshot unavailable; import with screen exports enabled or refresh the reference');
    return asset;
  }
  async getContext(snapshotId: string, nodeId?: string, depth = 3, limit = 200): Promise<{node:DesignNode;truncated:boolean;nodeCount:number;warnings:string[]}> {
    if (!Number.isInteger(depth) || depth < 0 || depth > 30 || !Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('Context depth or node limit out of bounds');
    const snapshot=await this.load(snapshotId);
    const chosen=nodeId ?? snapshot.nodeId ?? snapshot.document.id;
    const selected=walk(snapshot.document).find(n=>n.id===chosen);
    if(!selected)throw new Error('Figma node not found in snapshot');
    let count=0;let truncated=false;
    const clone=(node:DesignNode,remaining:number):DesignNode=>{
      count++;
      const {children,...properties}=node;
      const result:DesignNode={...properties};
      if(children?.length){
        result.children=[];
        for(const child of children){if(remaining<=0||count>=limit){truncated=true;break;}result.children.push(clone(child,remaining-1));}
      }
      return result;
    };
    const node=clone(selected,depth);
    return {node,truncated,nodeCount:count,warnings:snapshot.warnings};
  }
  async getFlows(snapshotId:string):Promise<{flows:Array<Record<string,unknown>>;interactions:Array<{nodeId:string;name:string;reactions:unknown[]}>;warnings:string[]}> {
    const snapshot=await this.load(snapshotId);const flows:Array<Record<string,unknown>>=[];const interactions:Array<{nodeId:string;name:string;reactions:unknown[]}>=[];
    for(const node of walk(snapshot.document)){
      if(Array.isArray(node.flowStartingPoints))for(const flow of node.flowStartingPoints)if(flow&&typeof flow==='object')flows.push({...flow,pageNodeId:node.id});
      const reactions=Array.isArray(node.interactions)?node.interactions:Array.isArray(node.reactions)?node.reactions:[];
      if(reactions.length)interactions.push({nodeId:node.id,name:node.name??node.id,reactions});
      else if(typeof node.transitionNodeID==='string')interactions.push({nodeId:node.id,name:node.name??node.id,reactions:[{type:'legacy-transition',destinationId:node.transitionNodeID}]});
    }
    return {flows,interactions,warnings:interactions.length?['Declared connections are not evidence that a prototype interaction was executed.']:['No prototype interactions were supplied by this snapshot. Runtime behavior remains unverified.']};
  }
  async getVariables(snapshotId:string):Promise<{available:boolean;data?:unknown;warning?:string}> {
    const snapshot=await this.load(snapshotId);
    const path=join(this.directory(snapshotId),'variables.json');
    try{return {available:true,data:JSON.parse(await readFile(path,'utf8'))};}catch(error:any){if(error.code!=='ENOENT')throw error;}
    try{
      const data=await this.request(`/files/${snapshot.fileKey}/variables/local`);
      await atomicJson(path,data);
      return {available:true,data,warning:'Variables reflect their retrieval time; this endpoint is not version-addressable.'};
    }catch(error){return {available:false,warning:`Variables unavailable: ${error instanceof Error?error.message:'request failed'}. Variables API access depends on plan, scopes and file permissions.`};}
  }
  async exportAssets(snapshotId:string,input:{nodeIds:string[];format?:'png'|'svg';scale?:number}):Promise<{assets:Asset[];warnings:string[]}> {
    const snapshot=await this.load(snapshotId);const format=input.format??'svg';const scale=input.scale??1;
    if(!['png','svg'].includes(format)||!Number.isFinite(scale)||scale<0.01||scale>4||!input.nodeIds.length||input.nodeIds.length>100)throw new Error('Invalid asset export options');
    const nodeIds=new Set(walk(snapshot.document).map(n=>n.id));for(const id of input.nodeIds)if(!nodeIds.has(id))throw new Error('Asset node not found in snapshot');
    const requested=[...new Set(input.nodeIds)];
    const assets:Asset[]=[];const warnings:string[]=[];const mimeType=format==='svg'?'image/svg+xml':'image/png';
    const exportsDirectory=join(this.directory(snapshotId),'exports');
    await privateDirectory(exportsDirectory);
    for(let offset=0;offset<requested.length;offset+=50){
      const batch=requested.slice(offset,offset+50);
      const rendered=await this.request(`/images/${snapshot.fileKey}`,{ids:batch.join(','),format,scale:String(scale),version:snapshot.version});
      const batchAssets:Asset[]=[];
      for(const nodeId of batch){
        const url=asRecord(rendered.images)[nodeId];
        if(typeof url!=='string'){warnings.push(`Export unavailable for ${nodeId}`);continue;}
        try{
          const saved=await this.download(url,join(this.directory(snapshotId),'assets'),mimeType);
          const asset:Asset={...saved,kind:'vector',nodeId,mimeType};
          assets.push(asset);batchAssets.push(asset);
        }catch(error){warnings.push(`Export unavailable for ${nodeId}: ${error instanceof Error?error.message:'download failed'}`);}
      }
      if(batchAssets.length)await atomicJson(join(exportsDirectory,`${randomUUID()}.json`),{assets:batchAssets,exportedAt:new Date().toISOString(),format,scale});
    }
    return {assets,warnings};
  }
}
