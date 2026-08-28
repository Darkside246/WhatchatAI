import { useEffect, useState, type FormEvent } from 'react';
import { Mail, Send, Check, X, Bot, AlertTriangle, Sparkles, Pencil, Trash2, Filter } from 'lucide-react';
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
  approved: 'bg-info/15 text-info',
  sending: 'bg-accent-soft text-accent',
  sent: 'bg-success/15 text-success',
  failed: 'bg-error/15 text-error',
  cancelled: 'bg-surface-3 text-fg-muted',
  indeterminate: 'bg-warning/15 text-warning',
};

const STATUS_LABEL: Record<EmailStatus, string> = {
  draft: 'Awaiting approval',
  approved: 'Approved — queued',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
  indeterminate: 'Unknown',
};

const TERMINAL_STATUSES: EmailStatus[] = ['sent', 'failed', 'cancelled', 'indeterminate'];
const FILTER_OPTIONS: Array<{ label: string; value: EmailStatus | 'all' }> = [
  { label: 'All', value: 'all' },
  { label: 'Drafts', value: 'draft' },
  { label: 'Queued', value: 'approved' },
  { label: 'Sent', value: 'sent' },
  { label: 'Failed', value: 'failed' },
  { label: 'Cancelled', value: 'cancelled' },
];

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
  const [filter, setFilter] = useState<EmailStatus | 'all'>('all');

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

  const filteredEmails = filter === 'all' ? emails : emails?.filter((e) => e.status === filter) ?? null;

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

  async function handleDelete(email: EmailMessageDto) {
    if (!window.confirm(`Permanently delete this email ("${email.subject}")? This cannot be undone.`)) return;
    await handleAction(email.id, () => api.deleteEmail(email.id));
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

  function closeCompose() {
    setComposing(false);
    setEditingId(null);
    setAiNotice(null);
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-title font-semibold text-fg">Email</h1>
            <p className="mt-1 text-body text-fg-muted">
              Every email — including one an agent wrote — requires human approval before sending.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setDraft(EMPTY_DRAFT);
              setEditingId(null);
              setComposing(true);
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-body font-medium text-white hover:bg-accent-dim"
          >
            <Mail size={14} aria-hidden />
            New draft
          </button>
        </div>

        {/* Setup warning */}
        {capabilities && !canSend && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/8 px-4 py-3 text-caption text-warning">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="font-semibold">Sending is not configured — drafts can be written but not approved.</p>
              <p className="mt-0.5 opacity-90">{capabilities.reason}</p>
              {!capabilities.senderConfigured && (
                <p className="mt-0.5 opacity-80">Set a sender address in Settings and verify that domain with your provider.</p>
              )}
            </div>
          </div>
        )}

        {settings && (
          <p className="mt-3 text-meta text-fg-muted">
            Sending as{' '}
            <span className="font-medium text-fg-secondary">
              {settings.fromName ? `${settings.fromName} ` : ''}&lt;{settings.fromEmail}&gt;
            </span>
            {capabilities?.provider ? ` via ${capabilities.provider}` : ''}
          </p>
        )}

        {error && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-error/30 bg-error/8 px-3 py-2 text-caption text-error">
            <AlertTriangle size={13} className="shrink-0" aria-hidden />
            {error}
          </div>
        )}

        {/* Compose form */}
        {composing && (
          <form onSubmit={handleSubmitDraft} className="mt-5 rounded-xl border border-border-subtle bg-surface-2 shadow-sm">
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
              <h2 className="text-body font-semibold text-fg">{editingId ? 'Edit draft' : 'New draft'}</h2>
              <button type="button" onClick={closeCompose} className="text-fg-muted hover:text-fg">
                <X size={16} aria-label="Close" />
              </button>
            </div>

            <div className="space-y-4 p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-caption font-medium text-fg-secondary">Type</label>
                  <select
                    value={draft.kind}
                    disabled={editingId !== null}
                    onChange={(event) => setDraft({ ...draft, kind: event.target.value as EmailKind })}
                    className="mt-1.5 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-body text-fg disabled:opacity-60"
                  >
                    {EMAIL_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {KIND_LABEL[kind]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-caption font-medium text-fg-secondary">Recipient name</label>
                  <input
                    value={draft.toName}
                    onChange={(event) => setDraft({ ...draft, toName: event.target.value })}
                    placeholder="Jane Smith"
                    className="mt-1.5 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-body text-fg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-caption font-medium text-fg-secondary">To</label>
                <input
                  required
                  type="email"
                  value={draft.toEmail}
                  onChange={(event) => setDraft({ ...draft, toEmail: event.target.value })}
                  placeholder="recipient@example.com"
                  className="mt-1.5 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-body text-fg"
                />
              </div>

              <div>
                <label className="block text-caption font-medium text-fg-secondary">Subject</label>
                <input
                  required
                  maxLength={200}
                  value={draft.subject}
                  onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
                  className="mt-1.5 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-body text-fg"
                />
              </div>

              <div>
                <label className="block text-caption font-medium text-fg-secondary">Body</label>
                <textarea
                  required
                  rows={8}
                  maxLength={5000}
                  value={draft.bodyText}
                  onChange={(event) => setDraft({ ...draft, bodyText: event.target.value })}
                  className="mt-1.5 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-body text-fg"
                />
              </div>

              {/* AI draft panel */}
              {!editingId && agents.length > 0 && (
                <div className="rounded-lg border border-border-subtle bg-surface-1 p-3">
                  <p className="flex items-center gap-1.5 text-caption font-semibold text-accent">
                    <Sparkles size={13} aria-hidden />
                    Have an agent write it
                  </p>
                  <p className="mt-1 text-meta text-fg-muted">
                    The agent may only use facts you give it here. It will leave gaps like [amount] rather than invent
                    figures, and the result is always a draft you approve.
                  </p>
                  <div className="mt-2 space-y-2">
                    <select
                      value={aiAgentId}
                      onChange={(event) => setAiAgentId(event.target.value)}
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
                      value={aiInstruction}
                      onChange={(event) => setAiInstruction(event.target.value)}
                      placeholder="What should this email do?"
                      className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg"
                    />
                    <textarea
                      value={aiFacts}
                      onChange={(event) => setAiFacts(event.target.value)}
                      rows={3}
                      placeholder="Real facts it may use (dates, amounts, reference numbers)…"
                      className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg"
                    />
                    <button
                      type="button"
                      onClick={() => void handleAiDraft()}
                      disabled={aiBusy || !aiAgentId || !aiInstruction.trim() || !draft.toEmail}
                      className="flex items-center gap-1.5 rounded-lg border border-accent px-3 py-1.5 text-caption font-medium text-accent hover:bg-accent-soft disabled:opacity-50"
                    >
                      <Bot size={13} aria-hidden />
                      {aiBusy ? 'Drafting…' : 'Draft with agent'}
                    </button>
                    {aiNotice && <p className="text-meta text-warning">{aiNotice}</p>}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button type="submit" className="rounded-lg bg-accent px-4 py-2 text-body font-medium text-white hover:bg-accent-dim">
                  {editingId ? 'Save draft' : 'Create draft'}
                </button>
                <button
                  type="button"
                  onClick={closeCompose}
                  className="rounded-lg border border-border-subtle px-4 py-2 text-body font-medium text-fg-secondary hover:bg-surface-3"
                >
                  Cancel
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Filter chips */}
        {emails && emails.length > 0 && (
          <div className="mt-5 flex items-center gap-1.5 overflow-x-auto pb-1">
            <Filter size={13} className="shrink-0 text-fg-muted" aria-hidden />
            {FILTER_OPTIONS.map((opt) => {
              const count = opt.value === 'all' ? emails.length : emails.filter((e) => e.status === opt.value).length;
              if (opt.value !== 'all' && count === 0) return null;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setFilter(opt.value)}
                  className={`shrink-0 rounded-full px-3 py-1 text-caption font-medium transition-colors ${
                    filter === opt.value
                      ? 'bg-accent text-white'
                      : 'bg-surface-3 text-fg-secondary hover:bg-surface-3 hover:text-fg'
                  }`}
                >
                  {opt.label}
                  {count > 0 && (
                    <span className={`ml-1.5 text-meta ${filter === opt.value ? 'opacity-75' : 'text-fg-muted'}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Email list */}
        <div className="mt-4 space-y-2">
          {emails === null && <p className="text-caption text-fg-muted">Loading…</p>}
          {filteredEmails?.length === 0 && emails !== null && (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-subtle p-12 text-center">
              <Mail size={24} className="text-fg-muted" aria-hidden />
              <p className="text-body text-fg-secondary">{filter === 'all' ? 'No emails yet.' : `No ${filter} emails.`}</p>
              {filter === 'all' && (
                <p className="text-caption text-fg-muted">Create a draft — every email needs approval before it sends.</p>
              )}
            </div>
          )}

          {filteredEmails?.map((email) => (
            <div key={email.id} className="rounded-xl border border-border-subtle bg-surface-2 transition-shadow hover:shadow-sm">
              <div className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-body font-semibold text-fg">
                      {email.draftedByAgentId && <Bot size={13} className="shrink-0 text-accent" aria-label="Drafted by an agent" />}
                      {email.subject}
                    </p>
                    <p className="mt-0.5 truncate text-caption text-fg-muted">
                      {KIND_LABEL[email.kind]} · to{' '}
                      {email.toName ? `${email.toName} <${email.toEmail}>` : email.toEmail}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-caption font-medium ${STATUS_STYLE[email.status]}`}>
                    {STATUS_LABEL[email.status]}
                  </span>
                </div>

                <p className="mt-2.5 line-clamp-3 whitespace-pre-wrap text-caption text-fg-secondary leading-relaxed">
                  {email.bodyText}
                </p>

                {email.lastError && (
                  <p className="mt-2 flex items-center gap-1.5 text-meta text-error">
                    <AlertTriangle size={11} className="shrink-0" aria-hidden />
                    {email.lastError}
                  </p>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-meta text-fg-muted">
                  <span>Created {formatDate(email.createdAt)}</span>
                  {email.approvedAt && <span>Approved {formatDate(email.approvedAt)}</span>}
                  {email.sentAt && <span>Sent {formatDate(email.sentAt)}</span>}
                  {email.providerMessageId && <span className="font-mono">ID: {email.providerMessageId}</span>}
                </div>
              </div>

              {/* Actions bar */}
              {(email.status === 'draft' || email.status === 'approved' || TERMINAL_STATUSES.includes(email.status)) && (
                <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-4 py-2.5">
                  {email.status === 'draft' && (
                    <>
                      <button
                        type="button"
                        disabled={busyId === email.id || !canSend}
                        title={canSend ? 'Approve and send this email' : 'Sending is not configured yet'}
                        onClick={() => void handleAction(email.id, () => api.approveEmail(email.id))}
                        className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
                      >
                        <Check size={13} aria-hidden />
                        Approve &amp; send
                      </button>
                      <button
                        type="button"
                        disabled={busyId === email.id}
                        onClick={() => startEdit(email)}
                        className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
                      >
                        <Pencil size={13} aria-hidden />
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={busyId === email.id}
                        onClick={() => void handleAction(email.id, () => api.cancelEmail(email.id))}
                        className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
                      >
                        <X size={13} aria-hidden />
                        Discard
                      </button>
                    </>
                  )}
                  {email.status === 'approved' && (
                    <p className="flex items-center gap-1.5 text-meta text-info">
                      <Send size={11} aria-hidden />
                      Queued for sending — it has not left yet.
                    </p>
                  )}
                  {TERMINAL_STATUSES.includes(email.status) && (
                    <button
                      type="button"
                      disabled={busyId === email.id}
                      onClick={() => void handleDelete(email)}
                      className="ml-auto flex items-center gap-1.5 rounded-lg border border-error/30 px-3 py-1.5 text-caption font-medium text-error hover:bg-error/8 disabled:opacity-50"
                    >
                      <Trash2 size={13} aria-hidden />
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
