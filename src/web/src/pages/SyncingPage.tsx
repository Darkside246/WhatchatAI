import { useEffect, useState } from 'react';
import type { SyncStatusResponse, WhatsAppConnectionSnapshot } from '../lib/api.js';

interface Props {
  connection: WhatsAppConnectionSnapshot | null;
  sync: SyncStatusResponse | null;
  onContinueAnyway: () => void;
}

const STUCK_AT_FULL_PROGRESS_MS = 8000;

export function SyncingPage({ connection, sync, onContinueAnyway }: Props) {
  const progress = sync?.syncProgress ?? null;
  const job = sync?.latestJob ?? null;
  const [stuckAtFullProgress, setStuckAtFullProgress] = useState(false);

  useEffect(() => {
    if (progress === null || progress < 100 || sync?.syncStatus === 'failed') {
      setStuckAtFullProgress(false);
      return;
    }
    // WhatsApp itself has already reported 100% - if our own "sync complete"
    // bookkeeping hasn't caught up within a few seconds (some sessions never
    // send the final batch marker Baileys is supposed to send), offer a way
    // through instead of leaving this screen stuck indefinitely.
    const timer = setTimeout(() => setStuckAtFullProgress(true), STUCK_AT_FULL_PROGRESS_MS);
    return () => clearTimeout(timer);
  }, [progress, sync?.syncStatus]);

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 bg-surface-0 px-6 py-16 text-center">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-title font-bold text-accent">
          A
        </div>
        <span className="text-title font-semibold tracking-tight text-fg">AURA</span>
      </div>

      <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-surface-2 p-8">
        <h2 className="text-xl font-semibold text-fg">Synchronizing your business data…</h2>
        <p className="mt-2 text-body text-fg-secondary">
          Connected as {connection?.pushName ?? connection?.phoneNumber ?? connection?.jid ?? 'your account'}.
          Pulling real chats, contacts, groups, and message history from WhatsApp.
        </p>

        <div className="mt-6 h-2 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-accent transition-all duration-500"
            style={{ width: progress !== null ? `${Math.min(100, Math.max(0, progress))}%` : '8%' }}
          />
        </div>
        <p className="mt-2 text-caption text-fg-muted">
          {progress !== null ? `${Math.round(progress)}% reported by WhatsApp` : 'Waiting for the first data batch…'}
        </p>

        {job && (
          <dl className="mt-6 grid grid-cols-3 gap-3 text-left text-caption text-fg-secondary">
            <div className="rounded-lg bg-surface-3 p-3">
              <dt className="text-fg-muted">Chats</dt>
              <dd className="mt-1 text-body-lg font-semibold text-fg">{job.chatsProcessed}</dd>
            </div>
            <div className="rounded-lg bg-surface-3 p-3">
              <dt className="text-fg-muted">Contacts</dt>
              <dd className="mt-1 text-body-lg font-semibold text-fg">{job.contactsProcessed}</dd>
            </div>
            <div className="rounded-lg bg-surface-3 p-3">
              <dt className="text-fg-muted">Messages</dt>
              <dd className="mt-1 text-body-lg font-semibold text-fg">{job.messagesProcessed}</dd>
            </div>
          </dl>
        )}

        {sync?.syncStatus === 'failed' && (
          <div className="mt-6 rounded-lg bg-error/10 p-3 text-left text-caption text-error">
            <p>Sync reported an error: {sync.lastSyncError ?? 'unknown error'}.</p>
            <button
              type="button"
              onClick={onContinueAnyway}
              className="mt-3 rounded-md bg-error/20 px-3 py-1.5 font-medium text-error hover:bg-error/30"
            >
              Continue anyway - some data may be incomplete
            </button>
          </div>
        )}

        {stuckAtFullProgress && sync?.syncStatus !== 'failed' && (
          <div className="mt-6 rounded-lg bg-warning/10 p-3 text-left text-caption text-warning">
            <p>WhatsApp reported 100%, but the sync hasn't finalized yet.</p>
            <button
              type="button"
              onClick={onContinueAnyway}
              className="mt-3 rounded-md bg-warning/20 px-3 py-1.5 font-medium text-warning hover:bg-warning/30"
            >
              Continue to workspace
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
