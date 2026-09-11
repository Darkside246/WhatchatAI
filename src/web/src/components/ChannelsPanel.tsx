import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { api, type WorkspaceChatSummary } from '../lib/api.js';

/**
 * WhatsApp Channels this account follows.
 *
 * Channels were already being ingested - the chat list deliberately filters
 * them out, because WhatsApp's own client keeps broadcast feeds out of the
 * conversation list too - but there was nowhere to read them at all, so
 * their posts were stored and never shown.
 *
 * Read-only by design, and honestly labelled as such: only a channel's
 * owner can post to it, so offering a composer would be offering something
 * that cannot work.
 */
export function ChannelsPanel({ className = '' }: { className?: string }) {
  const [channels, setChannels] = useState<WorkspaceChatSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const selected = channels?.find((channel) => channel.id === selectedId) ?? null;

  return (
    <div className={`flex min-w-0 flex-1 ${className}`}>
      <div className="flex w-full shrink-0 flex-col border-r border-border-subtle bg-surface-1 md:w-80">
        <div className="border-b border-border-subtle px-4 py-3">
          <h2 className="text-body font-semibold text-fg">Channels</h2>
          <p className="text-meta text-fg-muted">Broadcast feeds you follow. Read-only — only the owner can post.</p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && <p className="px-4 py-3 text-caption text-error">{error}</p>}
          {channels === null && !error && <p className="px-4 py-3 text-caption text-fg-muted">Loading channels…</p>}
          {channels?.length === 0 && (
            <p className="px-4 py-6 text-center text-caption text-fg-muted">
              You don’t follow any WhatsApp Channels on this account yet.
            </p>
          )}

          {channels?.map((channel) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => setSelectedId(channel.id)}
              className={`flex w-full items-start gap-3 border-b border-border-subtle px-4 py-3 text-left hover:bg-surface-2 ${
                selectedId === channel.id ? 'bg-surface-2' : ''
              }`}
            >
              <Radio size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body font-medium text-fg">{channel.displayName}</p>
                {channel.lastMessagePreview && (
                  <p className="truncate text-caption text-fg-secondary">{channel.lastMessagePreview}</p>
                )}
              </div>
              {channel.unreadCount > 0 && (
                <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-meta font-semibold text-white">
                  {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-fg-muted md:flex">
        {selected ? (
          <div className="max-w-md text-center">
            <Radio size={32} strokeWidth={1.5} className="mx-auto mb-2 text-accent" aria-hidden />
            <p className="text-body font-medium text-fg">{selected.displayName}</p>
            {selected.lastMessagePreview && (
              <p className="mt-2 text-caption text-fg-secondary">{selected.lastMessagePreview}</p>
            )}
            <p className="mt-3 text-caption text-fg-muted">
              Channels are broadcast feeds — there is no reply to send, because only the channel’s owner can post.
            </p>
          </div>
        ) : (
          <>
            <Radio size={40} strokeWidth={1.5} aria-hidden />
            <p className="text-body">Select a channel</p>
          </>
        )}
      </div>
    </div>
  );
}
