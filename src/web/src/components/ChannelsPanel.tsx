import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Radio, Search, Image as ImageIcon, Video, Mic, FileText, MapPin } from 'lucide-react';
import { api, type WorkspaceChatSummary, type WorkspaceMessage } from '../lib/api.js';
import { MediaContent } from './ChatThread.js';

/**
 * WhatsApp Channels this account follows.
 *
 * Read-only by design, and honestly labelled as such: only a channel's owner
 * can post to it, so offering a composer would be offering something that
 * cannot work.
 *
 * This reads the REAL posts. The first version of this panel listed channels
 * and showed a single line of preview text per row, which made a feed of
 * photos, videos and links look like a list of truncated sentences - nothing
 * like the thing it is a view of. The posts were being ingested into
 * whatsapp_messages the whole time; the panel simply never asked for them.
 *
 * Still genuinely absent, because the data is not ingested rather than not
 * rendered: channel profile pictures (an avatar comes from a contact row and
 * a channel has none), follower counts, verified badges, and WhatsApp's
 * per-post reaction and forward tallies. Those need new ingestion, and a
 * placeholder pretending to have them would be worse than their absence.
 */

const TYPE_ICON: Record<string, typeof ImageIcon> = {
  image: ImageIcon,
  video: Video,
  audio: Mic,
  voice_note: Mic,
  document: FileText,
  location: MapPin,
};

/** WhatsApp's own row format: time today, "Yesterday", then a date. */
function formatRowTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const now = new Date();
  const sameDay = then.toDateString() === now.toDateString();
  if (sameDay) return then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return then.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}

function initials(name: string): string {
  const cleaned = name.trim();
  if (cleaned.length === 0) return '#';
  return cleaned[0]!.toUpperCase();
}

export function ChannelsPanel({ className = '' }: { className?: string }) {
  const [channels, setChannels] = useState<WorkspaceChatSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [posts, setPosts] = useState<WorkspaceMessage[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listChannels()
      .then((result) => {
        if (!cancelled) setChannels(result.channels);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load channels.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadPosts = useCallback(async (channelId: string) => {
    setPosts(null);
    setPostsError(null);
    try {
      const { messages } = await api.listMessages(channelId);
      // Oldest first, so a channel reads top-to-bottom like the feed it is.
      setPosts([...messages].reverse());
    } catch (err) {
      setPostsError(err instanceof Error ? err.message : 'Could not load this channel.');
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadPosts(selectedId);
  }, [selectedId, loadPosts]);

  // Newest post in view on open, the way every feed opens.
  useEffect(() => {
    if (posts) feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [posts]);

  const selected = channels?.find((channel) => channel.id === selectedId) ?? null;

  const visible = useMemo(() => {
    if (!channels) return null;
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return channels;
    return channels.filter((channel) => channel.displayName.toLowerCase().includes(needle));
  }, [channels, query]);

  async function handleRetry(mediaId: string) {
    setRetrying(mediaId);
    try {
      await api.retryMediaDownload(mediaId);
      if (selectedId) await loadPosts(selectedId);
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div className={`flex min-w-0 flex-1 ${className}`}>
      <div className="flex w-full shrink-0 flex-col border-r border-border-subtle bg-surface-1 md:w-80">
        <div className="border-b border-border-subtle px-4 py-3">
          <h2 className="text-body font-semibold text-fg">Channels</h2>
          <p className="text-meta text-fg-muted">Broadcast feeds you follow. Read-only — only the owner can post.</p>
          {channels && channels.length > 0 && (
            <div className="relative mt-2">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted" aria-hidden />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search channels"
                className="block w-full rounded-lg border border-border-subtle bg-surface-2 py-1.5 pl-8 pr-3 text-caption text-fg outline-none focus:border-accent"
              />
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && <p className="px-4 py-3 text-caption text-error">{error}</p>}
          {channels === null && !error && <p className="px-4 py-3 text-caption text-fg-muted">Loading channels…</p>}
          {channels?.length === 0 && (
            <p className="px-4 py-6 text-center text-caption text-fg-muted">
              You don’t follow any WhatsApp Channels on this account yet.
            </p>
          )}
          {visible?.length === 0 && (channels?.length ?? 0) > 0 && (
            <p className="px-4 py-6 text-center text-caption text-fg-muted">No channel matches “{query}”.</p>
          )}

          {visible?.map((channel) => {
            const TypeIcon = channel.lastMessageType ? TYPE_ICON[channel.lastMessageType] : undefined;
            return (
              <button
                key={channel.id}
                type="button"
                onClick={() => setSelectedId(channel.id)}
                className={`flex w-full items-center gap-3 border-b border-border-subtle px-4 py-3 text-left hover:bg-surface-2 ${
                  selectedId === channel.id ? 'bg-surface-2' : ''
                }`}
              >
                {/*
                  A channel has no contact row, so there is no stored profile
                  picture to show. An initial is an honest stand-in; a generic
                  broadcast glyph on every row made them all look identical.
                */}
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-body font-semibold text-accent">
                  {initials(channel.displayName)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-body font-medium text-fg">{channel.displayName}</span>
                    <span className="shrink-0 text-meta text-fg-muted">{formatRowTime(channel.lastMessageAt)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1">
                    {TypeIcon && <TypeIcon size={12} className="shrink-0 text-fg-muted" aria-hidden />}
                    <span className="truncate text-caption text-fg-secondary">{channel.lastMessagePreview}</span>
                    {channel.unreadCount > 0 && (
                      <span className="ml-auto shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-meta font-semibold text-white">
                        {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="hidden min-w-0 flex-1 flex-col md:flex">
        {selected ? (
          <>
            <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-surface-1 px-4 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-caption font-semibold text-accent">
                {initials(selected.displayName)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-body font-medium text-fg">{selected.displayName}</p>
                <p className="text-meta text-fg-muted">Channel · read-only</p>
              </div>
            </div>

            <div ref={feedRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-surface-0 p-4">
              {postsError && <p className="text-caption text-error">{postsError}</p>}
              {posts === null && !postsError && <p className="text-caption text-fg-muted">Loading posts…</p>}
              {posts?.length === 0 && (
                <p className="py-8 text-center text-caption text-fg-muted">No posts from this channel yet.</p>
              )}

              {posts?.map((post) => (
                <article key={post.id} className="max-w-xl rounded-xl border border-border-subtle bg-surface-1 p-3">
                  {post.media && (
                    <div className="mb-2">
                      <MediaContent
                        media={post.media}
                        caption={null}
                        onImageClick={(url) => setLightbox(url)}
                        onRetry={(mediaId) => void handleRetry(mediaId)}
                        retrying={retrying === post.media.id}
                      />
                    </div>
                  )}
                  {(post.textContent || post.caption) && (
                    <p className="whitespace-pre-wrap break-words text-caption text-fg">{post.textContent ?? post.caption}</p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <time className="text-meta text-fg-muted">
                      {new Date(post.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </time>
                    {/* Only real reactions this account actually received - never a fabricated tally. */}
                    {post.reactions.length > 0 && (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-meta">
                        {post.reactions.map((reaction) => reaction.reaction).join(' ')}
                      </span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-fg-muted">
            <Radio size={40} strokeWidth={1.5} aria-hidden />
            <p className="text-body">Select a channel</p>
          </div>
        )}
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightbox(null)}
          role="presentation"
        >
          <img src={lightbox} alt="" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </div>
  );
}
