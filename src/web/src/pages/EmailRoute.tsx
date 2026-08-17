import { useEffect, useState, type FormEvent } from 'react';
import { Mail, Send, Check, X, Bot, AlertTriangle, Sparkles, Pencil } from 'lucide-react';
import {
  api,
  ApiError,
  EMAIL_KINDS,
  type EmailMessageDto,
  type EmailCapabilitiesDto,
  type EmailSettingsDto,
  type EmailKind,
  type EmailStatus,
  type AiAgentSummary,
} from '../lib/api.js';

const KIND_LABEL: Record<EmailKind, string> = {
  custom: 'Custom',
  order_update: 'Order update',
  appointment: 'Appointment',
  receipt: 'Receipt',
  invoice: 'Invoice',
  general_update: 'Update',
};

const STATUS_STYLE: Record<EmailStatus, string> = {
  draft: 'bg-surface-3 text-fg-secondary',
  approved: 'bg-accent-soft text-accent',
  sending: 'bg-accent-soft text-accent',
  sent: 'bg-success/15 text-success',
  failed: 'bg-error/15 text-error',
  cancelled: 'bg-surface-3 text-fg-muted',
};

/**
 * Wording is chosen to match what actually happened. 'approved' does not say
 * "sent" - the provider has not been called yet at that point - and 'sent'
 * means a provider genuinely accepted it.
 */
const STATUS_LABEL: Record<EmailStatus, string> = {
  draft: 'Awaiting approval',
  approved: 'Approved — queued',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const EMPTY_DRAFT = { kind: 'general_update' as EmailKind, toEmail: '', toName: '', subject: '', bodyText: '' };

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function EmailRoute() {
  const [emails, setEmails] = useState<EmailMessageDto[] | null>(null);
  const [capabilities, setCapabilities] = useState<EmailCapabilitiesDto | null>(null);
  const [settings, setSettings] = useState<EmailSettingsDto | null>(null);
  const [agents, setAgents] = useState<AiAgentSummary[]>([]);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiAgentId, setAiAgentId] = useState('');
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiFacts, setAiFacts] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  async function load() {
    const [list, caps, settingsResult] = await Promise.all([
      api.listEmails(),
      api.getEmailCapabilities(),
      api.getEmailSettings(),
    ]);
    setEmails(list.emails);
    setCapabilities(caps);
    setSettings(settingsResult.settings);
  }

  useEffect(() => {
    void load().catch(() => setError('Could not load email.'));
    void api
      .listAgents()
      .then((result) => setAgents(result.agents))
      .catch(() => undefined);
  }, []);

  const canSend = capabilities?.providerConfigured === true && capabilities?.senderConfigured === true;

  async function handleSubmitDraft(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (editingId) {
        await api.updateEmailDraft(editingId, {
          toEmail: draft.toEmail,
          toName: draft.toName || null,
          subject: draft.subject,
          bodyText: draft.bodyText,
        });
      } else {
        await api.createEmailDraft({
          kind: draft.kind,
          toEmail: draft.toEmail,
          toName: draft.toName || null,
          subject: draft.subject,
          bodyText: draft.bodyText,
        });
      }
      setComposing(false);
      setEditingId(null);
      setDraft(EMPTY_DRAFT);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that draft.');
    }
  }

  async function handleAiDraft() {
    if (!aiAgentId || !aiInstruction.trim()) return;
    setAiBusy(true);
    setError(null);
    setAiNotice(null);
    try {
      const result = await api.aiDraftEmail({
        agentId: aiAgentId,
        kind: draft.kind,
        toEmail: draft.toEmail,
        toName: draft.toName || null,
        instruction: aiInstruction,
        facts: aiFacts || null,
      });
      if (result.status === 'unavailable') {
        // Honest: no draft was produced, and we say why rather than showing
        // a canned template pretending to be AI output.
        setAiNotice(result.reason);
      } else {
        setComposing(false);
        setDraft(EMPTY_DRAFT);
        setAiInstruction('');
        setAiFacts('');
        await load();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate that draft.');
    } finally {
      setAiBusy(false);
    }
  }

  async function handleAction(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That action failed.');
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(email: EmailMessageDto) {
    setDraft({
      kind: email.kind,
      toEmail: email.toEmail,
      toName: email.toName ?? '',
      subject: email.subject,
      bodyText: email.bodyText,
    });
    setEditingId(email.id);
    setComposing(true);
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-fg">Email</h1>
            <p className="mt-1 text-sm text-fg-muted">
              Every email — including one an agent wrote — is sent only after a person approves it.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setDraft(EMPTY_DRAFT);
              setEditingId(null);
              setComposing(true);
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-dim"
          >
            <Mail size={14} aria-hidden />
            New draft
          </button>
        </div>

        {capabilities && !canSend && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">Sending is not set up yet — drafts can be written but not approved.</p>
              <p className="mt-0.5 opacity-90">{capabilities.reason}</p>
              {!capabilities.senderConfigured && (
                <p className="mt-0.5 opacity-90">Set a sender address in Settings, and verify that domain with your provider.</p>
              )}
            </div>
          </div>
        )}

        {settings && (
          <p className="mt-3 text-[11px] text-fg-muted">
            Sending as {settings.fromName ? `${settings.fromName} · ` : ''}
            {settings.fromEmail}
            {capabilities?.provider ? ` via ${capabilities.provider}` : ''}
          </p>
        )}

        {error && <p className="mt-3 text-xs text-error">{error}</p>}

        {composing && (
          <form onSubmit={handleSubmitDraft} className="mt-4 space-y-3 rounded-xl border border-border-subtle bg-surface-2 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-fg-secondary">
                Type
                <select
                  value={draft.kind}
                  disabled={editingId !== null}
                  onChange={(event) => setDraft({ ...draft, kind: event.target.value as EmailKind })}
                  className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg disabled:opacity-60"
                >
                  {EMAIL_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABEL[kind]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-fg-secondary">
                Recipient name
                <input
                  value={draft.toName}
                  onChange={(event) => setDraft({ ...draft, toName: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg"
                />
              </label>
            </div>

            <label className="block text-xs font-medium text-fg-secondary">
              To
              <input
                required
                type="email"
                value={draft.toEmail}
                onChange={(event) => setDraft({ ...draft, toEmail: event.target.value })}
                className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg"
              />
            </label>

            <label className="block text-xs font-medium text-fg-secondary">
              Subject
              <input
                required
                maxLength={200}
                value={draft.subject}
                onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
                className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg"
              />
            </label>

            <label className="block text-xs font-medium text-fg-secondary">
              Body
              <textarea
                required
                rows={8}
                maxLength={5000}
                value={draft.bodyText}
                onChange={(event) => setDraft({ ...draft, bodyText: event.target.value })}
                className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg"
              />
            </label>

            {!editingId && agents.length > 0 && (
              <div className="rounded-lg border border-border-subtle bg-surface-1 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-accent">
                  <Sparkles size={13} aria-hidden />
                  Have an agent write it
                </p>
                <p className="mt-1 text-[11px] text-fg-muted">
                  The agent may only use facts you give it here. It will leave gaps like [amount] rather than invent
                  figures, and the result is always a draft you approve.
                </p>
                <div className="mt-2 space-y-2">
                  <select
                    value={aiAgentId}
                    onChange={(event) => setAiAgentId(event.target.value)}
                    className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-fg"
                  >
                    <option value="">Choose an agent…</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                  <input
                    value={aiInstruction}
                    onChange={(event) => setAiInstruction(event.target.value)}
                    placeholder="What should this email do?"
                    className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-fg"
                  />
                  <textarea
                    value={aiFacts}
                    onChange={(event) => setAiFacts(event.target.value)}
                    rows={3}
                    placeholder="Real facts it may use (dates, amounts, reference numbers)…"
                    className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-fg"
                  />
                  <button
                    type="button"
                    onClick={() => void handleAiDraft()}
                    disabled={aiBusy || !aiAgentId || !aiInstruction.trim() || !draft.toEmail}
                    className="flex items-center gap-1.5 rounded-lg border border-accent px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent-soft disabled:opacity-50"
                  >
                    <Bot size={13} aria-hidden />
                    {aiBusy ? 'Drafting…' : 'Draft with agent'}
                  </button>
                  {aiNotice && <p className="text-[11px] text-warning">{aiNotice}</p>}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button type="submit" className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-dim">
                {editingId ? 'Save draft' : 'Create draft'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setComposing(false);
                  setEditingId(null);
                  setAiNotice(null);
                }}
                className="rounded-lg border border-border-subtle px-3 py-2 text-sm font-medium text-fg-secondary hover:bg-surface-3"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        <div className="mt-5 space-y-2">
          {emails === null && <p className="text-xs text-fg-muted">Loading…</p>}
          {emails?.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-subtle p-10 text-center">
              <Mail size={22} className="text-fg-muted" aria-hidden />
              <p className="text-sm text-fg-secondary">No emails yet.</p>
            </div>
          )}

          {emails?.map((email) => (
            <div key={email.id} className="rounded-xl border border-border-subtle bg-surface-2 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
                    {email.draftedByAgentId && <Bot size={13} className="shrink-0 text-accent" aria-label="Drafted by an agent" />}
                    {email.subject}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-fg-muted">
                    {KIND_LABEL[email.kind]} · to {email.toName ? `${email.toName} <${email.toEmail}>` : email.toEmail}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[email.status]}`}>
                  {STATUS_LABEL[email.status]}
                </span>
              </div>

              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-fg-secondary">{email.bodyText}</p>

              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-muted">
                <span>Created {formatDate(email.createdAt)}</span>
                {email.approvedAt && <span>Approved {formatDate(email.approvedAt)}</span>}
                {email.sentAt && <span>Sent {formatDate(email.sentAt)}</span>}
                {email.providerMessageId && <span>Provider id {email.providerMessageId}</span>}
              </div>

              {email.lastError && <p className="mt-1 text-[11px] text-error">{email.lastError}</p>}

              {email.status === 'draft' && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busyId === email.id || !canSend}
                    title={canSend ? 'Approve and send this email' : 'Sending is not configured yet'}
                    onClick={() => void handleAction(email.id, () => api.approveEmail(email.id))}
                    className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dim disabled:opacity-50"
                  >
                    <Check size={13} aria-hidden />
                    Approve &amp; send
                  </button>
                  <button
                    type="button"
                    disabled={busyId === email.id}
                    onClick={() => startEdit(email)}
                    className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
                  >
                    <Pencil size={13} aria-hidden />
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busyId === email.id}
                    onClick={() => void handleAction(email.id, () => api.cancelEmail(email.id))}
                    className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
                  >
                    <X size={13} aria-hidden />
                    Discard
                  </button>
                </div>
              )}

              {email.status === 'approved' && (
                <p className="mt-2 flex items-center gap-1.5 text-[11px] text-accent">
                  <Send size={11} aria-hidden />
                  Queued for sending — it has not left yet.
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
