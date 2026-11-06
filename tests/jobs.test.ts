import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobQueue, publicError } from '../src/jobs.js';

test('jobs finish asynchronously and remain readable after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'figma-jobs-'));
  try {
    const jobs = new JobQueue(root);
    const started = await jobs.start('import', async () => ({ snapshotId: 'snapshot-123' }));
    assert.match(started.id, /^[a-f0-9-]+$/);
    await jobs.idle();
    const job = await new JobQueue(root).get(started.id);
    assert.equal(job.status, 'complete');
    assert.deepEqual(job.result, { snapshotId: 'snapshot-123' });
  } finally { await rm(root, {recursive:true,force:true}); }
});

test('API authentication failures and retry delays remain actionable without provider bodies',()=>{
  const unauthorized=Object.assign(new Error('Figma API returned HTTP 401'),{status:401,code:'ACCESS_DENIED'});
  assert.equal(publicError(unauthorized).code,'AUTH_REQUIRED');
  const limited=Object.assign(new Error('Figma API returned HTTP 429'),{status:429,code:'RATE_LIMITED',retryAfter:3600});
  assert.equal(publicError(limited).retryAfterSeconds,3600);
  const forbidden=Object.assign(new Error('Figma API returned HTTP 403'),{status:403,code:'ACCESS_DENIED'});
  assert.equal(publicError(forbidden).code,'FORBIDDEN');
});

test('a failed job cannot leak exception secrets and does not stop the queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'figma-jobs-'));
  try {
    const jobs = new JobQueue(root);
    const first = await jobs.start('import', async () => { throw new Error('Bearer secret-value'); });
    const second = await jobs.start('import', async () => ({ ok:true }));
    await jobs.idle();
    assert.equal((await jobs.get(first.id)).status, 'failed');
    assert.doesNotMatch(JSON.stringify(await jobs.get(first.id)), /secret-value/);
    assert.equal((await jobs.get(second.id)).status, 'complete');
    await assert.rejects(jobs.get('../../credentials'), /Invalid job/);
  } finally { await rm(root, {recursive:true,force:true}); }
});
