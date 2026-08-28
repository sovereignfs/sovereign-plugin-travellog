'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Card, FileDropzone, Progress, useToast } from '@sovereignfs/ui';
import { getLatestImportJobAction, resumeImportAction } from '../actions';
import type { ImportJobRow } from '../_lib/import-jobs';
import styles from './ImportStatus.module.css';

const POLL_INTERVAL_MS = 2000;

function isActive(job: ImportJobRow | null): boolean {
  return job !== null && (job.status === 'pending' || job.status === 'running');
}

/**
 * `T.8`'s import screen body — an upload zone when there's nothing active,
 * a progress card (polled) while a job runs, or a completed/failed summary.
 * The page itself (`(home)/checkins/import/page.tsx`) fetches the initial
 * state server-side; this component owns the upload flow and polling.
 */
export function ImportStatus({ initialJob }: { initialJob: ImportJobRow | null }) {
  const toast = useToast();
  const [job, setJob] = useState(initialJob);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const active = isActive(job);

  // Refreshed on an interval while a job is pending/running — the platform
  // job itself runs entirely server-side regardless of this tab; polling is
  // just how this screen reflects that progress, not what drives it.
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      getLatestImportJobAction()
        .then(setJob)
        .catch(() => {
          /* a transient poll failure just tries again next tick */
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [active]);

  async function handleUpload(): Promise<void> {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.set('file', file);
      const response = await fetch('/travellog/checkins/import/upload', {
        method: 'POST',
        body: formData,
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setUploadError(data.error ?? 'Something went wrong uploading that file.');
        return;
      }
      setFile(null);
      const latest = await getLatestImportJobAction();
      setJob(latest);
    } catch {
      setUploadError('Something went wrong uploading that file.');
    } finally {
      setUploading(false);
    }
  }

  async function handleResume(): Promise<void> {
    if (!job) return;
    setResuming(true);
    try {
      const result = await resumeImportAction(job.id);
      if (!result.ok) {
        toast.show({ title: 'Couldn’t resume the import', message: result.error, category: 'error' });
        return;
      }
      const latest = await getLatestImportJobAction();
      setJob(latest);
    } finally {
      setResuming(false);
    }
  }

  if (active && job) {
    const percent = job.totalCheckins ? Math.round((job.processedCheckins / job.totalCheckins) * 100) : 0;
    return (
      <div className={styles.section}>
        <Card>
          <div className={styles.progressHeader}>
            <span className={styles.progressTitle}>Importing your check-ins…</span>
            <span className={styles.badges}>
              <Badge variant="mono" uppercase={false}>
                Resumable
              </Badge>
              <Badge variant="mono" uppercase={false}>
                Runs in background
              </Badge>
            </span>
          </div>
          <Progress value={percent} label="Import progress" />
          <div className={styles.progressCounts}>
            <span>
              {job.totalCheckins === null
                ? 'Reading your export…'
                : `${String(job.processedCheckins)} of ${String(job.totalCheckins)} check-ins imported`}
            </span>
            {job.totalPhotos !== null && job.totalPhotos > 0 && (
              <span className={styles.photoCounts}>
                {job.processedPhotos} of {job.totalPhotos} photos fetched
                {job.failedPhotos > 0 &&
                  ` · ${String(job.failedPhotos)} photo${job.failedPhotos === 1 ? '' : 's'} failed (skipped, not blocking)`}
              </span>
            )}
          </div>
          <p className={styles.backgroundNote}>
            You’ll get a notification when this finishes. Safe to close this tab.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className={styles.section}>
      {job?.status === 'completed' && (
        <Card className={styles.summaryCard}>
          <span className={styles.summaryText}>
            Last import: {job.processedCheckins} check-in{job.processedCheckins === 1 ? '' : 's'}
            {job.failedPhotos > 0 &&
              ` (${String(job.failedPhotos)} photo${job.failedPhotos === 1 ? '' : 's'} skipped)`}
            .
          </span>
        </Card>
      )}
      {job?.status === 'failed' && (
        <Card className={styles.summaryCard}>
          <span className={styles.errorText}>
            The last import couldn’t finish{job.errorMessage ? `: ${job.errorMessage}` : '.'}
          </span>
          <Button variant="secondary" onClick={() => void handleResume()} loading={resuming}>
            Try again
          </Button>
        </Card>
      )}

      <FileDropzone
        accept=".zip,application/zip"
        label="Browse for a file"
        hint={file ? file.name : 'or drop your Swarm export .zip here'}
        ariaLabel="Swarm export ZIP file"
        onFileSelect={setFile}
      />
      {uploadError && <p className={styles.uploadError}>{uploadError}</p>}
      <Button onClick={() => void handleUpload()} loading={uploading} disabled={!file}>
        Import
      </Button>
    </div>
  );
}
