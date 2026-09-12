import { useEffect, useRef, useState } from 'react';
import { ImageOff, FileWarning, Loader2, Send } from 'lucide-react';
import { api, mediaUrl, ApiError, type WorkspaceStatus } from '../lib/api.js';
import { useWhatsAppSync, type RealtimeEvent } from '../hooks/useWhatsAppSync.js';
import { Avatar } from './Avatar.js';
import { useVisiblePolling } from '../hooks/useVisiblePolling.js';

const POLL_MS = 8000;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * The real, full-size view of one status - shown only once its contact
 * group is expanded, so its natural aspect ratio (object-contain) never
 * fights a grid row's stretched height the way the old grid layout did.
 */
/**
 * Reply to a customer's status, from the Status panel.
 *
 * Sends a real direct message to whoever posted, quoting the status so both
 * sides see it threaded under the right post - the same thing the official
 * client does. A status from someone this business has never messaged has no
 * conversation to send into, and that is reported honestly rather than
 * silently creating one.
 */
function StatusReplyBox({ statusId }: { statusId: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.replyToStatus(statusId, trimmed);
      setText('');
      setSent(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'NO_CONVERSATION_WITH_PUBLISHER'
          ? 'You have no conversation with this person yet, so there is nowhere to send a reply.'
          : err instanceof Error
            ? err.message
            : 'Could not send that reply.',
      );
    } finally {
      setSending(false);
    }
  }

  if (sent) return <p className="mt-1.5 text-meta text-success">Reply sent.</p>;

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Reply to this status"
          className="flex-1 rounded-full border border-border-subtle bg-surface-2 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || text.trim().length === 0}
          className="shrink-0 text-accent hover:text-accent-dim disabled:cursor-not-allowed disabled:opacity-50"
          title="Send reply"
        >
          <Send size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {error && <p className="mt-1 text-meta text-error">{error}</p>}
    </div>
  );
}

function StatusExpanded({ status }: { status: WorkspaceStatus }) {
  if (status.statusType === 'text') {
    // Real text content, emoji included - a plain string renders exactly as
    // typed, no special handling needed. 'Text status' is only ever a
    // fallback for the rare case WhatsApp sent a genuinely empty text
    // status, never a placeholder for content that failed to load.
    return <p className="whitespace-pre-wrap break-words rounded-lg bg-surface-2 px-3 py-3 text-body text-fg">{status.textContent ?? 'Text status'}</p>;
  }
  if (!status.media) {
    // Not text, and no media either - a status type this app doesn't
    // recognize yet (WhatsApp sends more kinds of status than image/video/
    // audio/text). Never mislabeled as "Text status" just because there's
    // nothing else to show.
    return <p className="rounded-lg bg-surface-2 px-3 py-3 text-caption text-fg-muted">This status type isn't supported yet.</p>;
  }

  const { media } = status;
  if (media.downloadStatus === 'pending' || media.downloadStatus === 'downloading') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-4 text-caption text-fg-secondary">
        <Loader2 size={16} className="animate-spin" aria-hidden />
        Downloading status media…
      </div>
    );
  }
  if (media.downloadStatus === 'unavailable') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-4 text-caption text-fg-muted">
        <ImageOff size={16} aria-hidden />
        No longer available
      </div>
    );
  }
  if (media.downloadStatus === 'failed') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-4 text-caption text-error">
        <FileWarning size={16} aria-hidden />
        Status media download failed
      </div>
    );
  }

  const url = mediaUrl(media.id);
  if (status.statusType === 'video') {
    return <StatusVideo url={url} />;
  }
  return <img src={url} alt="Status" className="max-h-80 w-full rounded-lg object-contain" />;
}

/**
 * Plays only while the pointer is actually over it, pausing the instant it
 * leaves - never autoplays on its own. Expanding a contact with several
 * video statuses renders several of these at once; without this, every one
 * of them would start playing (and making sound) simultaneously.
 */
function StatusVideo({ url }: { url: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  return (
    <video
      ref={videoRef}
      controls
      src={url}
      className="max-h-80 w-full rounded-lg bg-black object-contain"
      onMouseEnter={() => void videoRef.current?.play()}
      onMouseLeave={() => videoRef.current?.pause()}
    />
  );
}

interface StatusGroup {
  publisherJid: string;
  displayName: string;
  items: WorkspaceStatus[];
  latestAt: string;
  hasUnviewed: boolean;
}

function groupByContact(statuses: WorkspaceStatus[]): StatusGroup[] {
  const byJid = new Map<string, WorkspaceStatus[]>();
  for (const status of statuses) {
    const list = byJid.get(status.publisherJid);
    if (list) list.push(status);
    else byJid.set(status.publisherJid, [status]);
  }

  const groups: StatusGroup[] = [];
  for (const [publisherJid, items] of byJid) {
    // Newest first within a contact, same convention as the backend's own
    // overall ordering (whatsappStatusRepository.ts's listByAccount).
    const sorted = [...items].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    groups.push({
      publisherJid,
      displayName: sorted[0]!.displayName,
      items: sorted,
      latestAt: sorted[0]!.createdAt,
      hasUnviewed: sorted.some((item) => !item.viewedAt),
    });
  }

  // Unviewed contacts float to the top as a whole group (newest activity
  // first within it); once every one of a contact's statuses has been
  // viewed, that contact sinks below all still-unviewed ones - a real,
  // ongoing cycle where viewing sends someone to the bottom and their next
  // new status pulls them back up, not a one-time chronological sort.
  return groups.sort((a, b) => {
    if (a.hasUnviewed !== b.hasUnviewed) return a.hasUnviewed ? -1 : 1;
    return new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime();
  });
}

interface Props {
  className?: string;
}

/**
 * A rolling timeline grouped by contact (one row per publisher, newest
 * activity first) instead of the old per-status grid - a grid stretched
 * every card in a row to match its tallest sibling (dead space under short
 * text statuses) and object-contain inside a fixed-height grid cell
 * letterboxed any portrait photo/video. One compact row per contact -
 * Avatar's real segmented status ring (statusCount), shown only while at
 * least one of that contact's statuses is unviewed - never shown once
 * every one of them has been opened, matching WhatsApp's own rule.
 * Expanding a row marks its statuses viewed and reveals each one's real,
 * full-aspect-ratio media in place.
 */
export function StatusesPanel({ className = '' }: Props) {
  const [statuses, setStatuses] = useState<WorkspaceStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedJid, setExpandedJid] = useState<string | null>(null);
  // Ids marked viewed locally (see handleToggle) whose server-side write may
  // not have landed yet - viewedAt only ever moves from unset to set in
  // reality, so a poll that still reports one of these as unviewed is stale,
  // not a genuine "actually still unviewed" answer. Without this, the ring
  // could flicker back for a few seconds after every view until the next
  // poll finally catches up with the write.
  const locallyViewed = useRef<Map<string, string>>(new Map());

  async function load() {
    try {
      const { statuses: list } = await api.listStatuses();
      const merged = list.map((status) => {
        if (status.viewedAt) return status;
        const localViewedAt = locallyViewed.current.get(status.id);
        return localViewedAt ? { ...status, viewedAt: localViewedAt } : status;
      });
      setStatuses(merged);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load statuses.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useVisiblePolling(load, POLL_MS);

  const { connected } = useWhatsAppSync((event: RealtimeEvent) => {
    if (event.type === 'status.media.updated') void load();
  });

  /** Marks every currently-unviewed status for one contact as viewed - called only once the user has moved off that contact entirely (collapsed it, or opened someone else instead), never the instant it opens. */
  function markContactViewed(publisherJid: string) {
    const unviewed = (statuses ?? []).filter((item) => item.publisherJid === publisherJid && !item.viewedAt);
    if (unviewed.length === 0) return;
    // Optimistic - the ring disappears immediately rather than waiting on
    // the round trip. Recorded in locallyViewed too, so a poll landing
    // before the server write completes can't flicker the ring back on.
    const viewedAt = new Date().toISOString();
    for (const item of unviewed) locallyViewed.current.set(item.id, viewedAt);
    setStatuses((prev) => prev?.map((item) => (unviewed.some((u) => u.id === item.id) ? { ...item, viewedAt } : item)) ?? prev);
    for (const item of unviewed) void api.markStatusViewed(item.id).catch(() => {});
  }

  function handleToggle(publisherJid: string) {
    if (expandedJid === publisherJid) {
      // Collapsing the one that was open - the user has now moved off it completely.
      markContactViewed(publisherJid);
      setExpandedJid(null);
      return;
    }
    // Switching straight to a different contact without collapsing first is
    // also "moving off" the one that was open.
    if (expandedJid) markContactViewed(expandedJid);
    setExpandedJid(publisherJid);
  }

  const groups = statuses ? groupByContact(statuses) : null;

  return (
    <div className={`h-full flex-col overflow-y-auto ${className}`}>
      <div className="shrink-0 border-b border-border-subtle p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-body-lg font-semibold text-fg">Status</h1>
          <span
            title={connected ? 'Live updates connected' : 'Live updates unavailable - showing periodically refreshed data'}
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-success' : 'bg-fg-muted/50'}`}
          />
        </div>
        <p className="mt-1 text-caption text-fg-muted">Real status updates synced from WhatsApp - expires 24h after posting.</p>
      </div>

      <div className="p-2">
        {error && <p className="p-2 text-caption text-error">{error}</p>}
        {groups === null && !error && <p className="p-2 text-body text-fg-muted">Loading real statuses…</p>}
        {groups?.length === 0 && (
          <p className="p-2 text-body text-fg-muted">No active statuses. Real updates will appear here as they're posted.</p>
        )}
        {groups?.map((group) => {
          const expanded = expandedJid === group.publisherJid;
          return (
            <div key={group.publisherJid} className="border-b border-border-subtle last:border-b-0">
              <button
                type="button"
                onClick={() => handleToggle(group.publisherJid)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-2"
                aria-expanded={expanded}
              >
                <Avatar label={group.displayName} statusCount={group.items.length} ringVisible={group.hasUnviewed} />
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-body text-fg ${group.hasUnviewed ? 'font-semibold' : 'font-medium'}`}>{group.displayName}</p>
                  <p className="text-meta text-fg-muted">
                    {formatTime(group.latestAt)}
                    {group.items.length > 1 ? ` · ${group.items.length} updates` : ''}
                  </p>
                </div>
              </button>
              {expanded && (
                <div className="space-y-2 px-2 pb-3">
                  {group.items.map((item) => (
                    <div key={item.id}>
                      <StatusExpanded status={item} />
                      <StatusReplyBox statusId={item.id} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
