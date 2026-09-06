import { useEffect, useMemo, useState } from 'react';
import { Star, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import type { EmailSearchFilter } from './EmailToolsPanel.js';

export type OAuthMessageSummary = {
  id: string;
  accountId: string;
  providerMessageId: string;
  providerThreadId: string | null;
  folderId: string;
  subject: string | null;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string | null;
  snippet: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  isRead: boolean;
  isStarred: boolean;
  labels: string[];
  receivedAt: string | null;
};

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const isToday = date.toDateString() === new Date().toDateString();
  return isToday ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The middle-left message list for a real, selected Gmail/Outlook folder
 * (Email Redesign Phase B) - mirrors ChatListPane/ChatThread's existing
 * master-detail idiom (ChatsRoute.tsx) rather than inventing a new one.
 */
export function EmailMessageListPane({
  accountId,
  folderId,
  selectedMessageId,
  onSelect,
  onDeleted,
  refreshKey,
  filter,
  width,
}: {
  accountId: string;
  folderId: string;
  selectedMessageId: string | null;
  onSelect: (message: OAuthMessageSummary) => void;
  /** Called after a real, successful delete - lets the parent clear its own selected-message state if that was the one just removed. */
  onDeleted?: (messageId: string) => void;
  refreshKey?: number;
  filter?: EmailSearchFilter;
  /** Real pixel width, driven by the parent's useResizableWidth - falls back to a sensible default (matches the old fixed w-96) when omitted. */
  width?: number;
}) {
  const [messages, setMessages] = useState<OAuthMessageSummary[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    setMessages(null);
    api
      .getOAuthMessages(accountId, { folderId, limit: 50 })
      .then((res) => setMessages(res.messages))
      .catch(() => setMessages([]));
  }, [accountId, folderId, refreshKey]);

  // A quick action/contact click applies client-side, against whatever
  // this folder already fetched - a real, working filter without a new
  // cross-folder search endpoint, which stays out of scope for this pass.
  const filteredMessages = useMemo(() => {
    if (!messages || !filter) return messages;
    return messages.filter((message) => {
      if (filter.unreadOnly && message.isRead) return false;
      if (filter.fromContains && !(message.fromAddress ?? '').toLowerCase().includes(filter.fromContains.toLowerCase())) return false;
      if (filter.subjectContains && !(message.subject ?? '').toLowerCase().includes(filter.subjectContains.toLowerCase())) return false;
      return true;
    });
  }, [messages, filter]);

  async function handleDelete(event: React.MouseEvent, message: OAuthMessageSummary) {
    event.stopPropagation(); // never also trigger the row's own onSelect
    if (!window.confirm(`Delete this email from ${message.fromName || message.fromAddress || 'this sender'}? It moves to Trash/Deleted Items in the real mailbox - recoverable there, not permanently gone.`)) return;
    setDeletingId(message.id);
    try {
      await api.deleteOAuthMessage(message.id);
      setMessages((prev) => prev?.filter((m) => m.id !== message.id) ?? prev);
      onDeleted?.(message.id);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not delete this email. Try again in a moment.');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div
      style={{ width: width ?? 384, minWidth: width ?? 384 }}
      className="flex h-full shrink-0 flex-col overflow-y-auto border-r border-border-subtle">
      {messages === null && <p className="p-4 text-caption text-fg-muted">Loading messages…</p>}
      {filteredMessages?.length === 0 && messages !== null && (
        <p className="p-4 text-caption text-fg-muted">{filter ? 'No messages match this filter.' : 'No messages in this folder yet.'}</p>
      )}
      {filteredMessages?.map((message) => {
        const isSelected = message.id === selectedMessageId;
        return (
          // A row full of clickable text plus one real nested action button
          // (the delete icon) can't be a single <button> - buttons can't
          // nest. A div with the same keyboard/role semantics keeps this
          // list fully keyboard-navigable while allowing the delete icon
          // to be its own independent, stoppable click target.
          <div
            key={message.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(message)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelect(message);
            }}
            className={`group relative w-full cursor-pointer border-b border-border-subtle px-4 py-3 text-left transition-colors ${
              isSelected ? 'bg-accent-soft' : message.isRead ? 'bg-surface-1 hover:bg-surface-2' : 'bg-surface-2 hover:bg-surface-3'
            }`}
          >
            <div className="flex items-center justify-between gap-2 pr-6">
              <span className={`truncate text-caption ${message.isRead ? 'font-normal text-fg-secondary' : 'font-semibold text-fg'}`}>
                {message.fromName || message.fromAddress || 'Unknown sender'}
              </span>
              <span className="flex shrink-0 items-center gap-1 text-meta text-fg-muted">
                {message.isStarred && <Star size={11} className="fill-current text-warning" aria-label="Starred" />}
                {formatDate(message.receivedAt)}
              </span>
            </div>
            <p className={`mt-0.5 truncate pr-6 text-caption ${message.isRead ? 'text-fg-muted' : 'font-medium text-fg'}`}>
              {message.subject || '(no subject)'}
            </p>
            <p className="mt-0.5 truncate pr-6 text-meta text-fg-muted">{message.snippet}</p>
            <button
              type="button"
              onClick={(event) => void handleDelete(event, message)}
              disabled={deletingId === message.id}
              title="Delete"
              aria-label="Delete this email"
              className="absolute right-2 top-3 rounded-md border border-transparent p-1 text-fg-muted opacity-0 transition-opacity hover:border-error/30 hover:bg-error/10 hover:text-error focus:opacity-100 disabled:opacity-50 group-hover:opacity-100"
            >
              <Trash2 size={13} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
