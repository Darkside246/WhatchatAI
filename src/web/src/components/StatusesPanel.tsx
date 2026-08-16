import { useEffect, useState } from 'react';
import { ImageOff, FileWarning, Loader2, Type } from 'lucide-react';
import { api, mediaUrl, type WorkspaceStatus } from '../lib/api.js';
import { useWhatsAppSync, type RealtimeEvent } from '../hooks/useWhatsAppSync.js';
import { Avatar } from './Avatar.js';

const POLL_MS = 8000;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Real, decrypted status media served the same way chat media is (GET
 * /api/media/:id) - never shown unless download_status is actually
 * 'downloaded'. Pending/failed/unavailable each get an honest, distinct
 * state instead of a fake preview.
 */
function StatusMedia({ status }: { status: WorkspaceStatus }) {
  if (status.statusType === 'text' || !status.media) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-6 text-xs text-fg-muted">
        <Type size={16} aria-hidden />
        {status.textContent ?? 'Text status'}
      </div>
    );
  }

  const { media } = status;
  if (media.downloadStatus === 'pending' || media.downloadStatus === 'downloading') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-6 text-xs text-fg-secondary">
        <Loader2 size={16} className="animate-spin" aria-hidden />
        Downloading status media…
      </div>
    );
  }
  if (media.downloadStatus === 'unavailable') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-6 text-xs text-fg-muted">
        <ImageOff size={16} aria-hidden />
        No longer available
      </div>
    );
  }
  if (media.downloadStatus === 'failed') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-6 text-xs text-error">
        <FileWarning size={16} aria-hidden />
        Status media download failed
      </div>
    );
  }

  const url = mediaUrl(media.id);
  if (status.statusType === 'video') {
    return <video controls src={url} className="max-h-64 w-full rounded-lg object-contain" />;
  }
  return <img src={url} alt="Status" className="max-h-64 w-full rounded-lg object-contain" />;
}

interface Props {
  className?: string;
}

export function StatusesPanel({ className = '' }: Props) {
  const [statuses, setStatuses] = useState<WorkspaceStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const { statuses: list } = await api.listStatuses();
      setStatuses(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load statuses.');
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const { connected } = useWhatsAppSync((event: RealtimeEvent) => {
    if (event.type === 'status.media.updated') void load();
  });

  return (
    <div className={`h-full flex-col overflow-y-auto ${className}`}>
      <div className="shrink-0 border-b border-border-subtle p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold text-fg">Status</h1>
          <span
            title={connected ? 'Live updates connected' : 'Live updates unavailable - showing periodically refreshed data'}
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-accent' : 'bg-fg-muted/50'}`}
          />
        </div>
        <p className="mt-1 text-xs text-fg-muted">Real status updates synced from WhatsApp - expires 24h after posting.</p>
      </div>

      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
        {error && <p className="col-span-full text-xs text-error">{error}</p>}
        {statuses === null && !error && <p className="col-span-full text-sm text-fg-muted">Loading real statuses…</p>}
        {statuses?.length === 0 && (
          <p className="col-span-full text-sm text-fg-muted">No active statuses. Real updates will appear here as they're posted.</p>
        )}
        {statuses?.map((status) => (
          <div key={status.id} className="overflow-hidden rounded-xl border border-border-subtle bg-surface-1">
            <StatusMedia status={status} />
            <div className="flex items-center gap-2 p-3">
              <Avatar label={status.displayName} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fg">{status.displayName}</p>
                <p className="text-[11px] text-fg-muted">{formatTime(status.createdAt)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
