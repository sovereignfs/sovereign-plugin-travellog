import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import {
  createImportJob,
  getImportJob,
  getLatestImportJob,
  markImportJobCompleted,
  markImportJobFailed,
  markImportJobRunning,
  setImportJobPlatformJobId,
  setImportJobTotals,
  updateImportJobProgress,
} from '../import-jobs';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(() => {
  t.close();
});

describe('createImportJob', () => {
  it('starts pending with zeroed counters and a zero cursor', async () => {
    const job = await createImportJob(t.travellog, actor, 'imports/user-1/export.zip');
    expect(job.status).toBe('pending');
    expect(job.storageKey).toBe('imports/user-1/export.zip');
    expect(job.cursor).toBe(0);
    expect(job.processedCheckins).toBe(0);
    expect(job.processedPhotos).toBe(0);
    expect(job.failedPhotos).toBe(0);
    expect(job.totalCheckins).toBeNull();
    expect(job.platformJobId).toBeNull();
    expect(job.completedAt).toBeNull();
  });
});

describe('getLatestImportJob', () => {
  it('returns null when the user has never imported', async () => {
    expect(await getLatestImportJob(t.travellog, actor)).toBeNull();
  });

  it('returns the most recently created job, scoped to the caller', async () => {
    const first = await createImportJob(t.travellog, actor, 'a.zip');
    await new Promise((r) => setTimeout(r, 2));
    const second = await createImportJob(t.travellog, actor, 'b.zip');
    await createImportJob(t.travellog, { tenantId: 'tenant-1', userId: 'user-2' }, 'someone-elses.zip');

    const latest = await getLatestImportJob(t.travellog, actor);
    expect(latest?.id).toBe(second.id);
    expect(latest?.id).not.toBe(first.id);
  });
});

describe('import job lifecycle transitions', () => {
  it('running clears a previous error message', async () => {
    const job = await createImportJob(t.travellog, actor, 'a.zip');
    await markImportJobFailed(t.travellog, job.id, 'boom');
    await markImportJobRunning(t.travellog, job.id);

    const row = await getImportJob(t.travellog, job.id);
    expect(row?.status).toBe('running');
    expect(row?.errorMessage).toBeNull();
  });

  it('completed sets completedAt', async () => {
    const job = await createImportJob(t.travellog, actor, 'a.zip');
    await markImportJobCompleted(t.travellog, job.id);

    const row = await getImportJob(t.travellog, job.id);
    expect(row?.status).toBe('completed');
    expect(row?.completedAt).not.toBeNull();
  });

  it('failed records the error message', async () => {
    const job = await createImportJob(t.travellog, actor, 'a.zip');
    await markImportJobFailed(t.travellog, job.id, 'checkins.json missing');

    const row = await getImportJob(t.travellog, job.id);
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toBe('checkins.json missing');
  });

  it('setImportJobTotals sets both counts once', async () => {
    const job = await createImportJob(t.travellog, actor, 'a.zip');
    await setImportJobTotals(t.travellog, job.id, { totalCheckins: 100, totalPhotos: 40 });

    const row = await getImportJob(t.travellog, job.id);
    expect(row?.totalCheckins).toBe(100);
    expect(row?.totalPhotos).toBe(40);
  });

  it('updateImportJobProgress advances cursor and counters together', async () => {
    const job = await createImportJob(t.travellog, actor, 'a.zip');
    await updateImportJobProgress(t.travellog, job.id, {
      cursor: 5,
      processedCheckins: 5,
      processedPhotos: 3,
      failedPhotos: 1,
    });

    const row = await getImportJob(t.travellog, job.id);
    expect(row).toMatchObject({ cursor: 5, processedCheckins: 5, processedPhotos: 3, failedPhotos: 1 });
  });

  it('setImportJobPlatformJobId records the current platform job id', async () => {
    const job = await createImportJob(t.travellog, actor, 'a.zip');
    await setImportJobPlatformJobId(t.travellog, job.id, 'platform-job-1');
    expect((await getImportJob(t.travellog, job.id))?.platformJobId).toBe('platform-job-1');

    // A resume re-enqueue reassigns it — the row tracks the *current* attempt.
    await setImportJobPlatformJobId(t.travellog, job.id, 'platform-job-2');
    expect((await getImportJob(t.travellog, job.id))?.platformJobId).toBe('platform-job-2');
  });
});
