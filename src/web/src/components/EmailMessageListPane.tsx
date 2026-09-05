import { useEffect, useMemo, useState } from 'react';
import { Star } from 'lucide-react';
import { api } from '../lib/api.js';
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
  refreshKey,
  filter,
}: {
  accountId: string;
  folderId: string;
  selectedMessageId: string | null;
  onSelect: (message: OAuthMessageSummary) => void;
  refreshKey?: number;
  filter?: EmailSearchFilter;
}) {
  const [messages, setMessages] = useState<OAuthMessageSummary[] | null>(null);

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

  return (
    <div className="flex h-full w-96 shrink-0 flex-col overflow-y-auto border-r border-border-subtle">
      {messages === null && <p className="p-4 text-caption text-fg-muted">Loading messages…</p>}
      {filteredMessages?.length === 0 && messages !== null && (
        <p className="p-4 text-caption text-fg-muted">{filter ? 'No messages match this filter.' : 'No messages in this folder yet.'}</p>
      )}
      {filteredMessages?.map((message) => {
        const isSelected = message.id === selectedMessageId;
        return (
          <button
            key={message.id}
            type="button"
            onClick={() => onSelect(message)}
            className={`w-full border-b border-border-subtle px-4 py-3 text-left transition-colors ${
              isSelected ? 'bg-accent-soft' : message.isRead ? 'bg-surface-1 hover:bg-surface-2' : 'bg-surface-2 hover:bg-surface-3'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`truncate text-caption ${message.isRead ? 'font-normal text-fg-secondary' : 'font-semibold text-fg'}`}>
                {message.fromName || message.fromAddress || 'Unknown sender'}
              </span>
              <span className="flex shrink-0 items-center gap-1 text-meta text-fg-muted">
                {message.isStarred && <Star size={11} className="fill-current text-warning" aria-label="Starred" />}
                {formatDate(message.receivedAt)}
              </span>
            </div>
            <p className={`mt-0.5 truncate text-caption ${message.isRead ? 'text-fg-muted' : 'font-medium text-fg'}`}>
              {message.subject || '(no subject)'}
            </p>
            <p className="mt-0.5 truncate text-meta text-fg-muted">{message.snippet}</p>
          </button>
        );
      })}
    </div>
  );
}
