import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Megaphone, Send, Check, X, Users } from 'lucide-react';
import {
  api,
  ApiError,
  type CampaignDto,
  type CampaignDetailDto,
  type EligibleRecipientDto,
} from '../lib/api.js';

const STATUS_LABEL: Record<CampaignDto['status'], string> = {
  DRAFT: 'Draft',
  REVIEW: 'In review',
  APPROVED: 'Approved',
  SCHEDULED: 'Scheduled',
  RUNNING: 'Sending',
  COMPLETED: 'Completed',
  PAUSED: 'Paused',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
};

const STATUS_COLOR: Record<CampaignDto['status'], string> = {
  DRAFT: 'bg-fg-muted/15 text-fg-muted',
  REVIEW: 'bg-warning/15 text-warning',
  APPROVED: 'bg-info/15 text-info',
  SCHEDULED: 'bg-info/15 text-info',
  RUNNING: 'bg-accent-soft text-accent',
  COMPLETED: 'bg-success/15 text-success',
  PAUSED: 'bg-warning/15 text-warning',
  CANCELLED: 'bg-fg-muted/15 text-fg-muted',
  FAILED: 'bg-error/15 text-error',
};

const RECIPIENT_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  played: 'Played',
  failed: 'Failed',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function NewCampaignForm({ onCreated, onCancel }: { onCreated: (campaignId: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [messageText, setMessageText] = useState('');
  const [recipients, setRecipients] = useState<EligibleRecipientDto[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listEligibleCampaignRecipients()
      .then((result) => setRecipients(result.recipients))
      .catch(() => setRecipients([]));
  }, []);

  function toggleRecipient(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (!recipients) return;
    setSelectedIds((current) => (current.size === recipients.length ? new Set() : new Set(recipients.map((r) => r.crmContactId))));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (selectedIds.size === 0) {
      setError('Select at least one recipient.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.createCampaign({ name: name.trim(), messageText: messageText.trim(), crmContactIds: Array.from(selectedIds) });
      onCreated(result.campaign.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that campaign.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <button type="button" onClick={onCancel} className="mb-4 flex items-center gap-1.5 text-xs font-medium text-fg-muted hover:text-fg">
        <ArrowLeft size={13} aria-hidden />
        Back to campaigns
      </button>

      <h2 className="text-base font-semibold text-fg">New campaign</h2>
      <p className="mt-1 text-xs text-fg-muted">
        Only sent to real contacts you already have an open WhatsApp conversation with - never cold outreach.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm text-fg-secondary">
          Campaign name
          <input
            type="text"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-fg-secondary">
          Message
          <textarea
            required
            rows={4}
            maxLength={4000}
            value={messageText}
            onChange={(event) => setMessageText(event.target.value)}
            className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
          />
        </label>

        <div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-fg-secondary">Recipients ({selectedIds.size} selected)</span>
            {recipients && recipients.length > 0 && (
              <button type="button" onClick={toggleAll} className="text-xs font-medium text-accent hover:text-accent-dim">
                {selectedIds.size === recipients.length ? 'Deselect all' : 'Select all'}
              </button>
            )}
          </div>
          <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-border-subtle">
            {recipients === null && <p className="p-3 text-xs text-fg-muted">Loading contacts…</p>}
            {recipients?.length === 0 && (
              <p className="p-3 text-xs text-fg-muted">No contacts with an existing conversation yet - nothing eligible to message.</p>
            )}
            {recipients?.map((recipient) => (
              <label key={recipient.crmContactId} className="flex items-center gap-2.5 border-b border-border-subtle px-3 py-2 last:border-b-0 hover:bg-surface-2">
                <input
                  type="checkbox"
                  checked={selectedIds.has(recipient.crmContactId)}
                  onChange={() => toggleRecipient(recipient.crmContactId)}
                  className="h-3.5 w-3.5"
                />
                <span className="text-xs text-fg">{recipient.displayName}</span>
                {recipient.phoneNumber && <span className="text-[11px] text-fg-muted">{recipient.phoneNumber}</span>}
              </label>
            ))}
          </div>
        </div>

        {error && <p className="text-xs text-error">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create draft'}
        </button>
      </form>
    </div>
  );
}

function CampaignDetailView({ campaignId, onBack }: { campaignId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<CampaignDetailDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const result = await api.getCampaign(campaignId);
      setDetail(result);
    } catch {
      setError('Could not load this campaign.');
    }
  }

  useEffect(() => {
    void load();
  }, [campaignId]);

  async function handleAction(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That action failed.');
    } finally {
      setBusy(false);
    }
  }

  if (!detail) return <p className="text-xs text-fg-muted">Loading…</p>;
  const { campaign, recipients, counts } = detail;

  return (
    <div className="mx-auto max-w-2xl">
      <button type="button" onClick={onBack} className="mb-4 flex items-center gap-1.5 text-xs font-medium text-fg-muted hover:text-fg">
        <ArrowLeft size={13} aria-hidden />
        Back to campaigns
      </button>

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-fg">{campaign.name}</h2>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_COLOR[campaign.status]}`}>{STATUS_LABEL[campaign.status]}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap rounded-lg border border-border-subtle bg-surface-2 p-3 text-sm text-fg-secondary">{campaign.messageText}</p>

      <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {(['total', 'queued', 'sent', 'delivered', 'read', 'failed'] as const).map((key) => (
          <div key={key} className="rounded-lg border border-border-subtle bg-surface-2 p-2 text-center">
            <p className="text-lg font-semibold text-fg">{counts[key]}</p>
            <p className="text-[10px] uppercase tracking-wide text-fg-muted">{key}</p>
          </div>
        ))}
      </div>

      {error && <p className="mt-3 text-xs text-error">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        {campaign.status === 'DRAFT' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => handleAction(() => api.submitCampaignForReview(campaign.id))}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            <Check size={13} aria-hidden />
            Submit for review
          </button>
        )}
        {campaign.status === 'REVIEW' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => handleAction(() => api.approveCampaign(campaign.id))}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            <Check size={13} aria-hidden />
            Approve
          </button>
        )}
        {campaign.status === 'APPROVED' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => handleAction(() => api.sendCampaign(campaign.id))}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            <Send size={13} aria-hidden />
            Send now
          </button>
        )}
        {(campaign.status === 'DRAFT' || campaign.status === 'REVIEW' || campaign.status === 'APPROVED') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => handleAction(() => api.cancelCampaign(campaign.id))}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
          >
            <X size={13} aria-hidden />
            Cancel
          </button>
        )}
      </div>

      <h3 className="mt-6 text-sm font-semibold text-fg">Recipients ({recipients.length})</h3>
      <div className="mt-2 rounded-lg border border-border-subtle">
        {recipients.map((recipient) => (
          <div key={recipient.id} className="flex items-center justify-between border-b border-border-subtle px-3 py-2 last:border-b-0">
            <div>
              <p className="text-xs font-medium text-fg">{recipient.displayName}</p>
              {recipient.phoneNumber && <p className="text-[11px] text-fg-muted">{recipient.phoneNumber}</p>}
            </div>
            <span className="text-xs text-fg-secondary">{recipient.status ? RECIPIENT_STATUS_LABEL[recipient.status] ?? recipient.status : 'Not yet sent'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MarketingRoute() {
  const [campaigns, setCampaigns] = useState<CampaignDto[] | null>(null);
  const [view, setView] = useState<{ mode: 'list' } | { mode: 'new' } | { mode: 'detail'; campaignId: string }>({ mode: 'list' });

  async function load() {
    try {
      const result = await api.listCampaigns();
      setCampaigns(result.campaigns);
    } catch {
      setCampaigns([]);
    }
  }

  useEffect(() => {
    if (view.mode === 'list') void load();
  }, [view.mode]);

  if (view.mode === 'new') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <NewCampaignForm onCreated={(campaignId) => setView({ mode: 'detail', campaignId })} onCancel={() => setView({ mode: 'list' })} />
      </div>
    );
  }

  if (view.mode === 'detail') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <CampaignDetailView campaignId={view.campaignId} onBack={() => setView({ mode: 'list' })} />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-fg">Campaigns</h1>
            <p className="mt-1 text-sm text-fg-muted">Real WhatsApp broadcasts to contacts you already have a conversation with.</p>
          </div>
          <button
            type="button"
            onClick={() => setView({ mode: 'new' })}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-dim"
          >
            <Megaphone size={14} aria-hidden />
            New campaign
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {campaigns === null && <p className="text-xs text-fg-muted">Loading…</p>}
          {campaigns?.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-subtle p-10 text-center">
              <Users size={22} className="text-fg-muted" aria-hidden />
              <p className="text-sm text-fg-secondary">No campaigns yet.</p>
              <p className="text-xs text-fg-muted">Create one to message contacts you already have an open conversation with.</p>
            </div>
          )}
          {campaigns?.map((campaign) => (
            <button
              key={campaign.id}
              type="button"
              onClick={() => setView({ mode: 'detail', campaignId: campaign.id })}
              className="flex w-full items-center justify-between rounded-xl border border-border-subtle bg-surface-2 p-4 text-left hover:bg-surface-3"
            >
              <div>
                <p className="text-sm font-medium text-fg">{campaign.name}</p>
                <p className="mt-0.5 text-xs text-fg-muted">
                  {campaign.counts.total} recipients · {formatDate(campaign.createdAt)}
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_COLOR[campaign.status]}`}>{STATUS_LABEL[campaign.status]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
