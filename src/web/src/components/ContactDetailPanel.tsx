import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { X } from 'lucide-react';
import { api, type WorkspaceChatDetail } from '../lib/api.js';
import { Avatar } from './Avatar.js';

const AI_MODE_OPTIONS: { value: WorkspaceChatDetail['chat']['aiMode']; label: string; hint: string }[] = [
  { value: 'AI_ACTIVE', label: 'AI Active', hint: 'The AI agent responds automatically.' },
  { value: 'AI_PAUSED', label: 'AI Paused', hint: 'No automatic replies from either the AI or a human.' },
  { value: 'HUMAN_TAKEOVER', label: 'Human Takeover', hint: 'A human is handling this conversation - the AI stays silent.' },
];

interface Props {
  onClose?: () => void;
}

export function ContactDetailPanel({ onClose }: Props) {
  const { chatId } = useParams<{ chatId: string }>();
  const [detail, setDetail] = useState<WorkspaceChatDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingMode, setSavingMode] = useState(false);

  useEffect(() => {
    if (!chatId) return;
    setDetail(null);
    api
      .getChatDetail(chatId)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load contact.'));
  }, [chatId]);

  if (!chatId) return null;

  async function handleModeChange(mode: WorkspaceChatDetail['chat']['aiMode']) {
    if (!chatId || !detail) return;
    setSavingMode(true);
    try {
      await api.setAiMode(chatId, mode);
      setDetail({ ...detail, chat: { ...detail.chat, aiMode: mode } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update AI mode.');
    } finally {
      setSavingMode(false);
    }
  }

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-surface-1 lg:w-80">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <h2 className="text-sm font-semibold text-fg">Conversation details</h2>
        {onClose && (
          <button type="button" onClick={onClose} className="text-fg-muted hover:text-fg lg:hidden">
            <X size={18} aria-hidden />
          </button>
        )}
      </div>

      {error && <p className="p-4 text-xs text-error">{error}</p>}
      {!detail && !error && <p className="p-4 text-xs text-fg-muted">Loading real contact details…</p>}

      {detail && (
        <div className="flex flex-col gap-6 p-4">
          <div className="flex flex-col items-center gap-2 text-center">
            <Avatar label={detail.contact?.displayName ?? detail.chat.name ?? detail.chat.chatJid} size="lg" />
            <p className="text-sm font-medium text-fg">
              {detail.contact?.displayName ??
                detail.contact?.pushName ??
                detail.chat.name ??
                detail.resolvedPhoneNumber ??
                detail.chat.chatJid}
            </p>
            <p className="text-xs text-fg-muted">
              {detail.contact?.phoneNumber ?? detail.chat.phoneNumber ?? detail.resolvedPhoneNumber ?? detail.chat.chatJid}
            </p>
          </div>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">AI &amp; takeover</h3>
            <div className="flex flex-col gap-1.5">
              {AI_MODE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={savingMode}
                  onClick={() => handleModeChange(option.value)}
                  className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors disabled:opacity-50 ${
                    detail.chat.aiMode === option.value
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-border-subtle bg-surface-2 text-fg-secondary hover:border-fg-muted'
                  }`}
                >
                  <span className="font-medium">{option.label}</span>
                  <p className="mt-0.5 text-[11px] text-fg-muted">{option.hint}</p>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">WhatsApp identity</h3>
            <dl className="space-y-1.5 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-fg-muted">JID</dt>
                <dd className="truncate text-right text-fg-secondary">{detail.chat.chatJid}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-fg-muted">Type</dt>
                <dd className="text-fg-secondary">{detail.chat.chatType}</dd>
              </div>
              {detail.resolvedPhoneNumber && (
                <div className="flex justify-between gap-2">
                  <dt className="text-fg-muted">Resolved number</dt>
                  <dd className="text-fg-secondary">{detail.resolvedPhoneNumber}</dd>
                </div>
              )}
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">CRM</h3>
            {detail.crmContact ? (
              <dl className="space-y-1.5 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-fg-muted">Stage</dt>
                  <dd className="text-fg-secondary">{detail.crmContact.stage ?? 'Not set'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-fg-muted">Lead status</dt>
                  <dd className="text-fg-secondary">{detail.crmContact.leadStatus ?? 'Not set'}</dd>
                </div>
              </dl>
            ) : null}
            {detail.crmContact && detail.crmContact.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detail.crmContact.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-fg-secondary">
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {!detail.crmContact && (
              <p className="text-xs text-fg-muted">No CRM record for this conversation yet.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
