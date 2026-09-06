import { useEffect, useState } from 'react';
import { Bot, Sparkles, Reply, Forward, Trash2 } from 'lucide-react';
import { api, ApiError, type AiAgentSummary } from '../lib/api.js';
import type { OAuthMessageSummary } from './EmailMessageListPane.js';

function formatFullDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The reading pane for a real synced Gmail/Outlook message (Email
 * Redesign Phase B), plus the "Draft a reply with AI" action (Phase D) -
 * reuses emailService.ts's existing draftWithAi pipeline via a new
 * replyToOAuthMessageId parameter, so the resulting draft lands in the
 * same human-approval-before-send Compose queue every other draft does.
 * No new send path, no new safety surface.
 */
export function EmailMessageDetailPane({
  message,
  onDraftedReply,
  onReply,
  onForward,
  onDeleteMessage,
  deletingMessageId,
}: {
  message: OAuthMessageSummary;
  onDraftedReply: () => void;
  /** Opens the existing Compose-queue draft form pre-filled as a reply to this message - never a direct send, same human-approval-before-send gate every other draft goes through. */
  onReply: (message: OAuthMessageSummary) => void;
  /** Same as onReply, pre-filled as a forward instead. */
  onForward: (message: OAuthMessageSummary) => void;
  /** Confirms, deletes, and updates the shared message list/selection (including auto-advancing to the next message) - owned by EmailRoute, same handler the list pane's own per-row delete uses, so this pane and the list can never drift out of sync with each other. */
  onDeleteMessage: (message: OAuthMessageSummary) => void;
  deletingMessageId: string | null;
}) {
  const [agents, setAgents] = useState<AiAgentSummary[]>([]);
  const [agentId, setAgentId] = useState('');
  const [instruction, setInstruction] = useState('Write a brief, polite reply addressing the sender\'s message.');
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.listAgents().then((res) => {
      setAgents(res.agents);
      if (res.agents.length === 1 && res.agents[0]) setAgentId(res.agents[0].id);
    }).catch(() => undefined);
  }, []);

  async function handleDraftReply() {
    if (!agentId || !instruction.trim()) return;
    setDrafting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.aiDraftReplyToOAuthMessage({ oauthMessageId: message.id, agentId, instruction });
      if (result.status === 'unavailable') {
        setNotice(result.reason);
      } else {
        setNotice('A reply draft was created in your Compose queue - review and approve it there.');
        onDraftedReply();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not draft a reply.');
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-title font-semibold text-fg">{message.subject || '(no subject)'}</h1>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-caption text-fg-muted">
          <span>
            <span className="font-medium text-fg-secondary">{message.fromName || message.fromAddress}</span>
            {message.fromName && message.fromAddress && ` <${message.fromAddress}>`}
          </span>
          <span>{formatFullDate(message.receivedAt)}</span>
        </div>
        {message.toAddresses && <p className="mt-1 text-meta text-fg-muted">To: {message.toAddresses}</p>}

        <div className="mt-4 border-t border-border-subtle pt-4">
          {message.bodyHtml ? (
            // A real email's HTML body is untrusted content from an
            // arbitrary external sender - never injected via
            // dangerouslySetInnerHTML into this app's own DOM (that would
            // let an embedded <script> run with this page's own session).
            // A sandboxed iframe with no allow-scripts renders it inertly,
            // the same isolation every real email client uses.
            <iframe
              title="Email body"
              srcDoc={message.bodyHtml}
              sandbox="allow-same-origin"
              className="h-96 w-full rounded-lg border border-border-subtle bg-white"
            />
          ) : (
            <p className="whitespace-pre-wrap text-body text-fg-secondary">{message.bodyText || message.snippet}</p>
          )}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
          <button
            type="button"
            onClick={() => onReply(message)}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-2"
          >
            <Reply size={13} aria-hidden />
            Reply
          </button>
          <button
            type="button"
            onClick={() => onForward(message)}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-2"
          >
            <Forward size={13} aria-hidden />
            Forward
          </button>
          <button
            type="button"
            onClick={() => onDeleteMessage(message)}
            disabled={deletingMessageId === message.id}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:border-error/30 hover:bg-error/10 hover:text-error disabled:opacity-50"
          >
            <Trash2 size={13} aria-hidden />
            {deletingMessageId === message.id ? 'Deleting…' : 'Delete'}
          </button>
          {!showReplyForm ? (
            <button
              type="button"
              onClick={() => setShowReplyForm(true)}
              disabled={agents.length === 0}
              title={agents.length === 0 ? 'Create an AI agent first' : undefined}
              className="flex items-center gap-1.5 rounded-lg border border-accent px-3 py-1.5 text-caption font-medium text-accent hover:bg-accent-soft disabled:opacity-50"
            >
              <Bot size={13} aria-hidden />
              Draft a reply with AI
            </button>
          ) : (
            <div className="w-full space-y-2 rounded-lg border border-border-subtle bg-surface-1 p-3">
              <p className="flex items-center gap-1.5 text-caption font-semibold text-accent">
                <Sparkles size={13} aria-hidden />
                Draft a reply with AI
              </p>
              <p className="text-meta text-fg-muted">
                The agent sees only this email's real content and your instruction below. The result is always a draft in your Compose queue - it still requires your approval before it sends.
              </p>
              <select
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg"
              >
                <option value="">Choose an agent…</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <input
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="What should this reply say?"
                className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleDraftReply()}
                  disabled={drafting || !agentId || !instruction.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
                >
                  {drafting && <Sparkles size={13} className="animate-pulse" aria-hidden />}
                  {drafting ? 'Drafting…' : 'Draft it'}
                </button>
                <button type="button" onClick={() => setShowReplyForm(false)} className="text-caption text-fg-muted hover:text-fg">
                  Cancel
                </button>
              </div>
            </div>
          )}
          {notice && <p className="mt-2 text-caption text-warning">{notice}</p>}
          {error && <p className="mt-2 text-caption text-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
