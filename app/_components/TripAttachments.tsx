'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  Button,
  ConfirmDialog,
  FileDropzone,
  Icon,
  Input,
  Select,
  Spinner,
  useToast,
} from '@sovereignfs/ui';
import {
  createAttachmentAction,
  deleteAttachmentAction,
  getTripAttachmentsAction,
  type TripAttachmentView,
} from '../actions';
import type { AttachmentKind } from '../_lib/attachments';
import styles from './TripAttachments.module.css';

const KIND_LABEL: Record<AttachmentKind, string> = {
  receipt: 'Receipt',
  booking: 'Booking',
  accommodation: 'Accommodation',
  other: 'Other',
};

/** Mirrors the upload route's own cap (`app/(home)/trips/attachments/upload/route.ts`) so an oversized file is rejected before a wasted round trip, not just after. */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/** Strips a file extension for a reasonable default title — "Flight confirmation.pdf" → "Flight confirmation". */
function titleFromFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * `docs/adhoc/web-trips.md` screen 6 (`T.17`) — the one CONCEPT.md-scoped
 * Slice 2 surface that had a complete data layer (`T.10`/`T.11`: schema,
 * CRUD, authz, the upload route) but no web UI ever wired to it until now.
 * Fetched on demand when `TripDetailPanel` mounts this for a given trip —
 * same "resolve on select, not bundled into the cards list fetch" pattern
 * `CheckinsTimeline`'s `getVisitDetailAction` already established — rather
 * than eagerly fetching every trip's attachments (and their signed URLs)
 * up front for a panel most cards never open.
 */
export function TripAttachments({ tripId }: { tripId: string }) {
  const toast = useToast();
  const [attachments, setAttachments] = useState<TripAttachmentView[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [kind, setKind] = useState<AttachmentKind>('receipt');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TripAttachmentView | null>(null);
  const [deleting, startDeleting] = useTransition();

  useEffect(() => {
    let cancelled = false;
    setAttachments(null);
    getTripAttachmentsAction(tripId)
      .then((result) => {
        if (!cancelled) setAttachments(result);
      })
      .catch(() => {
        if (!cancelled) setAttachments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  function resetComposer(): void {
    setAddOpen(false);
    setKind('receipt');
    setTitle('');
    setFile(null);
    setError(null);
  }

  function handleFileSelect(next: File | null): void {
    setFile(next);
    if (next && !title.trim()) setTitle(titleFromFilename(next.name));
  }

  async function handleUpload(): Promise<void> {
    if (!file || !title.trim() || uploading) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError(`Attachments are limited to ${String(Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024)))} MB.`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.set('file', file);
      formData.set('tripId', tripId);
      const response = await fetch('/travellog/trips/attachments/upload', {
        method: 'POST',
        body: formData,
      });
      const body = (await response.json()) as { storageKey?: string; error?: string };
      if (!response.ok || !body.storageKey) {
        setError(body.error ?? 'That upload failed. Try again.');
        return;
      }

      const result = await createAttachmentAction({
        tripId,
        kind,
        title: title.trim(),
        storageKey: body.storageKey,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }

      const refreshed = await getTripAttachmentsAction(tripId);
      setAttachments(refreshed);
      resetComposer();
    } catch {
      setError('That upload failed. Try again.');
    } finally {
      setUploading(false);
    }
  }

  function confirmDelete(): void {
    if (!pendingDelete) return;
    const target = pendingDelete;
    startDeleting(async () => {
      const result = await deleteAttachmentAction(target.id);
      if (result.ok) {
        setAttachments((prev) => prev?.filter((a) => a.id !== target.id) ?? null);
        setPendingDelete(null);
      } else {
        toast.show({ title: 'Couldn’t remove attachment', message: result.error, category: 'error' });
        setPendingDelete(null);
      }
    });
  }

  return (
    <div className={styles.section}>
      <div className={styles.heading}>Attachments</div>

      {attachments === null ? (
        <Spinner size="sm" />
      ) : (
        attachments.length > 0 && (
          <ul className={styles.list}>
            {attachments.map((attachment) => (
              <li key={attachment.id} className={styles.row}>
                <Icon name="file-text" size="sm" aria-hidden={true} />
                <a
                  className={styles.rowMain}
                  href={attachment.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className={styles.rowTitle}>{attachment.title}</span>
                  <span className={styles.rowKind}>{KIND_LABEL[attachment.kind]}</span>
                </a>
                <button
                  type="button"
                  className={styles.removeButton}
                  aria-label={`Remove ${attachment.title}`}
                  onClick={() => setPendingDelete(attachment)}
                >
                  <Icon name="trash-2" size="sm" aria-hidden={true} />
                </button>
              </li>
            ))}
          </ul>
        )
      )}

      {addOpen ? (
        <div className={styles.composer}>
          {error && (
            <p className={styles.feedbackError} role="status" aria-live="polite">
              {error}
            </p>
          )}
          <Select
            aria-label="Attachment kind"
            size="sm"
            value={kind}
            disabled={uploading}
            onChange={(e) => setKind(e.target.value as AttachmentKind)}
          >
            {(Object.keys(KIND_LABEL) as AttachmentKind[]).map((value) => (
              <option key={value} value={value}>
                {KIND_LABEL[value]}
              </option>
            ))}
          </Select>
          <Input
            aria-label="Attachment title"
            placeholder="Title"
            value={title}
            disabled={uploading}
            onChange={(e) => setTitle(e.target.value)}
          />
          <FileDropzone
            label={file ? file.name : 'Choose a file'}
            hint={file ? undefined : 'or drag and drop here'}
            ariaLabel="Attachment file"
            disabled={uploading}
            onFileSelect={handleFileSelect}
          />
          <div className={styles.composerActions}>
            <Button variant="secondary" size="sm" onClick={resetComposer} disabled={uploading}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleUpload()}
              loading={uploading}
              disabled={!file || !title.trim()}
            >
              {uploading ? 'Uploading…' : 'Add'}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" size="sm" className={styles.addButton} onClick={() => setAddOpen(true)}>
          + Add attachment
        </Button>
      )}

      {pendingDelete && (
        <ConfirmDialog
          open
          onClose={() => setPendingDelete(null)}
          title={`Remove "${pendingDelete.title}"?`}
          message="This can't be undone."
          destructive
          confirmLabel={deleting ? 'Removing…' : 'Remove'}
          pending={deleting}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
