import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Job {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  pid: number;
  result?: unknown;
  error?: { code: string; message: string };
}

export class JobQueue {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly root: string) {}

  private path(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job identifier');
    return join(this.root, 'jobs', `${id}.json`);
  }

  private async save(job: Job): Promise<void> {
    await mkdir(join(this.root, 'jobs'), {recursive:true, mode:0o700});
    const target = this.path(job.id);
    const temp = `${target}.${randomUUID()}.tmp`;
    job.updatedAt = new Date().toISOString();
    await writeFile(temp, JSON.stringify(job), {mode:0o600, flag:'wx'});
    await rename(temp, target);
  }

  async start(kind: string, operation: () => Promise<unknown>): Promise<Job> {
    const job: Job = {
      id:randomUUID(), kind, status:'queued', pid:process.pid,
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    };
    await this.save(job);
    const initial = {...job};
    const run = async () => {
      try {
        job.status = 'running';
        await this.save(job);
        job.result = await operation();
        job.status = 'complete';
      } catch (error) {
        job.status = 'failed';
        job.error = publicError(error);
      }
      await this.save(job);
    };
    this.tail = this.tail.then(run, run);
    // Keep failures in metadata, never create an unhandled rejection on disk failure.
    this.tail.catch(() => undefined);
    return initial;
  }

  async get(id: string): Promise<Job> {
    const job = JSON.parse(await readFile(this.path(id), 'utf8')) as Job;
    if (job.status === 'running' || job.status === 'queued') {
      try { process.kill(job.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') job.status = 'interrupted';
      }
    }
    return job;
  }

  async idle(): Promise<void> { await this.tail; }
}

export function publicError(error: unknown): {code:string;message:string;retryAfterSeconds?:number} {
  const message = error instanceof Error ? error.message : '';
  const status=error&&typeof error==='object'&&'status' in error?error.status:undefined;
  if(status===401) return {code:'AUTH_REQUIRED',message:'Figma rejected this authorization. Reconnect with figma_connect or replace the token in the local panel.'};
  if(status===403) return {code:'FORBIDDEN',message:'Figma denied access. Check file permission, granted scopes and plan availability.'};
  if (/429|rate.limit/i.test(message)) {
    const retryAfter=error&&typeof error==='object'&&'retryAfter' in error?error.retryAfter:undefined;
    return {code:'RATE_LIMITED', message:'Figma limited this request. Preserve the snapshot and retry after the interval reported by Figma.',...(typeof retryAfter==='number'&&Number.isFinite(retryAfter)&&retryAfter>=0?{retryAfterSeconds:retryAfter}:{})};
  }
  if (/oauth|authentication|authenticate|token|credential|not connected/i.test(message)) return {code:'AUTH_REQUIRED',message:'Connect with figma_connect. OAuth app credentials and Figma file permission may be required.'};
  if (/403|forbidden|permission/i.test(message)) return {code:'FORBIDDEN',message:'Figma denied access. Check file permission, granted scopes and plan availability.'};
  if (/404|not found|ENOENT/i.test(message)) return {code:'NOT_FOUND',message:'The requested local resource or Figma node was not found.'};
  if (/invalid|unsupported|dimension|exceeds|too large|must |only |unsafe/i.test(message)) return {code:'INVALID_REQUEST',message:'The input is invalid or unsupported. Check the tool schema, file dimensions and supported URL or action types.'};
  return {code:'OPERATION_FAILED', message:'The operation could not complete. Check figma_status, local resource availability and the requested input.'};
}
