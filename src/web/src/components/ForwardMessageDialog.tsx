import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Search, Send, X } from 'lucide-react';
import { api, ApiError, type WorkspaceChatSummary, type WorkspaceMessage } from '../lib/api.js';
import { forwardTargets } from '../lib/forwardTargets.js';

/**
 * Sending a message on to other conversations.
 *
 * The one thing this screen has to be honest about: a forward is a new
 * message, not a window onto the old one. The recipient gets the content
 * and nothing else - not the conversation it came from, not who said it,
 * and not any later correction to it. So the summary at the bottom shows
 * exactly what will be sent, and the wording never suggests the original is
 * being shared.
 *
 * Multi-select, because forwarding the same thing to several people one at
 * a time is the case this exists for. Capped at the server's own limit
 * rather than a different number here, so the dialog cannot let somebody
 * build a selection the send will refuse.
 */

/** Matches the server's forward schema. A larger selection is a broadcast, which is what Marketing is for. */
const MAX_RECIPIENTS = 25;

function preview(message: WorkspaceMessage): string {
  if (message.textContent?.trim()) return message.textContent;
  if (message.caption?.trim()) return message.caption;
  return message.messageType.replace(/_/g, ' ');
}

export function ForwardMessageDialog({
  message,
  onClose,
  onForwarded,
}: {
  message: WorkspaceMessage;
  onClose: () => void;
  onForwarded?: (sentCount: number) => void;
}) {
  const [chats, setChats] = useState<WorkspaceChatSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showAll, setShowAll] = useState(false);

  /**
   * Loads the conversation list.
   *
   * A failure sets the list to empty rather than leaving it null: null is
   * "still loading" here, and a catch that only set an error string left the
   * dialog showing "could not load" and "Loading…" at the same time, forever.
   * One of those is always a lie.
   *
   * The real message is shown, not a generic sentence. "Could not load your
   * conversations" tells nobody whether they have been signed out, whether
   * WhatsApp is disconnected, or whether something is genuinely broken - and
   * that is exactly what somebody needs in order to do anything about it.
   */
  const load = useCallback(async () => {
    setError(null);
    try {
      const { chats: fetched } = await api.listChats();
      setChats(fetched);
    } catch (err) {
      setChats([]);
      setError(err instanceof ApiError ? `Could not load your conversations: ${err.message}` : 'Could not load your conversations.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { visible, matching, hiddenCount, searching } = useMemo(
    () => forwardTargets(chats ?? [], { excludeChatId: message.chatId, query, showAll }),
    [chats, message.chatId, query, showAll],
  );

  function toggle(chatId: string) {
    setError(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(chatId)) next.delete(chatId);
      else if (next.size >= MAX_RECIPIENTS) {
        setError(`${MAX_RECIPIENTS} conversations at a time. For more than that, use a campaign.`);
        return current;
      } else next.add(chatId);
      return next;
    });
  }

  async function send() {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { results } = await api.forwardMessage(message.id, [...selected]);
      const sent = results.filter((result) => result.outboundMessageId !== null);
      const skipped = results.filter((result) => result.skippedReason !== null);

      if (sent.length === 0) {
        // Every one failed, so this stays open with the reason rather than
        // closing as though something had been sent.
        setError(skipped[0]?.skippedReason ?? 'Nothing was sent.');
        return;
      }
      onForwarded?.(sent.length);
      if (skipped.length > 0) {
        // Partial success is still success for the ones that went, but the
        // operator has to be told which did not - silently closing here
        // would leave them believing all of them arrived.
        setError(`Sent to ${sent.length}. ${skipped.length} did not go: ${skipped[0]!.skippedReason}`);
        setSelected(new Set());
        return;
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not forward that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[85vh] w-full max-w-sm flex-col overflow-hidden rounded-t-2xl bg-surface-1 sm:rounded-2xl">
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded p-1 text-fg-muted hover:text-fg">
            <X size={16} aria-hidden />
          </button>
          <p className="min-w-0 flex-1 truncate text-body font-semibold text-fg">Forward message to</p>
        </div>

        <div className="border-b border-border-subtle px-4 py-2.5">
          <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5">
            <Search size={14} className="shrink-0 text-fg-muted" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name or number"
              aria-label="Search conversations"
              className="min-w-0 flex-1 bg-transparent text-caption text-fg placeholder:text-fg-muted focus:outline-none"
            />
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-b border-error/30 bg-error/10 px-4 py-2">
            <p className="min-w-0 flex-1 text-caption text-error">{error}</p>
            {/* A load that failed once is usually a load that succeeds on the
                second try. Closing and reopening the dialog is the same
                thing with more steps. */}
            <button
              type="button"
              onClick={() => void load()}
              className="shrink-0 text-caption font-medium text-error underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {chats === null && <p className="p-3 text-caption text-fg-muted">Loading…</p>}

          {chats !== null && visible.length === 0 && (
            <p className="p-3 text-caption text-fg-muted">
              {searching ? 'Nothing matches that.' : 'No other conversations to forward to.'}
            </p>
          )}

          {/* Named, so the short list reads as a deliberate shortlist rather
              than as the whole address book being unexpectedly small. */}
          {chats !== null && visible.length > 0 && !searching && !showAll && (
            <p className="px-2.5 pb-1 pt-2 text-meta font-medium uppercase tracking-wide text-fg-muted">Recent</p>
          )}

          {visible.map((chat) => {
            const chosen = selected.has(chat.id);
            return (
              <button
                key={chat.id}
                type="button"
                onClick={() => toggle(chat.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ${chosen ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    chosen ? 'border-accent bg-accent' : 'border-border-subtle'
                  }`}
                  aria-hidden
                >
                  {chosen && <span className="h-1.5 w-1.5 rounded-sm bg-white" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-caption font-medium text-fg">{chat.displayName}</span>
                  {chat.phoneNumber && <span className="block truncate text-meta text-fg-muted">{chat.phoneNumber}</span>}
                </span>
              </button>
            );
          })}

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-1 w-full rounded-lg px-2.5 py-2 text-left text-caption font-medium text-accent hover:bg-surface-2"
            >
              Show all {matching.length} conversations
            </button>
          )}
        </div>

        {/* What will actually be sent, so nobody forwards the wrong thing off
            a menu they opened on the wrong bubble. */}
        <div className="border-t border-border-subtle px-4 py-3">
          <div className="flex items-start gap-2 rounded-lg border-l-2 border-accent bg-surface-2 px-2.5 py-1.5">
            <p className="min-w-0 flex-1 line-clamp-2 text-meta text-fg-secondary">{preview(message)}</p>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-caption text-fg-muted">
              {selected.size === 0 ? 'Pick who to send it to' : `${selected.size} selected`}
            </p>
            <button
              type="button"
              disabled={busy || selected.size === 0}
              onClick={() => void send()}
              aria-label="Send"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:bg-accent-dim disabled:opacity-40"
            >
              {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Send size={16} aria-hidden />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
