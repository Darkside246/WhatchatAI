import { useMemo } from 'react';
import { Star, Trash2 } from 'lucide-react';
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
 *
 * Purely presentational - the message list itself, and deleting from it,
 * are both owned by EmailRoute (the one parent that also drives the
 * reading pane), so the list and the reading pane can never drift out of
 * sync with each other the way they could when each owned its own copy of
 * "what got deleted."
 */
export function EmailMessageListPane({
  messages,
  selectedMessageId,
  onSelect,
  onDeleteMessage,
  deletingMessageId,
  filter,
  width,
}: {
  messages: OAuthMessageSummary[] | null;
  selectedMessageId: string | null;
  onSelect: (message: OAuthMessageSummary) => void;
  /** Confirms, deletes, and updates the shared message list/selection - owned by EmailRoute. */
  onDeleteMessage: (message: OAuthMessageSummary) => void;
  deletingMessageId: string | null;
  filter?: EmailSearchFilter;
  /** Real pixel width, driven by the parent's useResizableWidth - falls back to a sensible default (matches the old fixed w-96) when omitted. */
  width?: number;
}) {
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
              onClick={(event) => {
                event.stopPropagation(); // never also trigger the row's own onSelect
                onDeleteMessage(message);
              }}
              disabled={deletingMessageId === message.id}
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
