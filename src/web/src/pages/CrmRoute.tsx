import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  ApiError,
  type WorkspaceCrmContactSummary,
  type WorkspaceLeadSummary,
  type LeadStatusValue,
} from '../lib/api.js';

const STAGE_OPTIONS = ['new_enquiry', 'qualified', 'proposal_sent', 'negotiation', 'customer', 'lost'];
const LEAD_STATUS_OPTIONS = ['open', 'nurturing', 'unresponsive', 'closed'];
const PIPELINE_STATUSES: LeadStatusValue[] = ['NEW', 'QUALIFIED', 'ENGAGED', 'WON', 'LOST'];

const PIPELINE_LABEL: Record<LeadStatusValue, string> = {
  NEW: 'New',
  QUALIFIED: 'Qualified',
  ENGAGED: 'Engaged',
  WON: 'Won',
  LOST: 'Lost',
};

const PIPELINE_COLOR: Record<LeadStatusValue, string> = {
  NEW: 'bg-info/15 text-info',
  QUALIFIED: 'bg-accent-soft text-accent',
  ENGAGED: 'bg-warning/15 text-warning',
  WON: 'bg-success/15 text-success',
  LOST: 'bg-fg-muted/15 text-fg-muted',
};

function formatMoney(value: number | null): string {
  if (value === null) return '—';
  return `$${value.toLocaleString()}`;
}

function ContactDetailCard({
  contact,
  onSaved,
}: {
  contact: WorkspaceCrmContactSummary;
  onSaved: (updated: WorkspaceCrmContactSummary) => void;
}) {
  const [stage, setStage] = useState(contact.stage ?? '');
  const [leadStatus, setLeadStatus] = useState(contact.leadStatus ?? '');
  const [notes, setNotes] = useState(contact.notes ?? '');
  const [email, setEmail] = useState(contact.email ?? '');
  const [tagsInput, setTagsInput] = useState(contact.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingLead, setCreatingLead] = useState(false);
  const [leadCreated, setLeadCreated] = useState(false);

  useEffect(() => {
    setStage(contact.stage ?? '');
    setLeadStatus(contact.leadStatus ?? '');
    setNotes(contact.notes ?? '');
    setEmail(contact.email ?? '');
    setTagsInput(contact.tags.join(', '));
    setLeadCreated(false);
  }, [contact.id]);

  async function handleCreateLead() {
    setCreatingLead(true);
    setError(null);
    try {
      await api.createLead({ crmContactId: contact.id, source: contact.source ?? undefined, stage: contact.stage ?? undefined });
      setLeadCreated(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create lead.');
    } finally {
      setCreatingLead(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const { crmContact } = await api.updateCrmContact(contact.id, {
        stage: stage.trim() || null,
        leadStatus: leadStatus.trim() || null,
        notes: notes.trim() || null,
        tags,
        email: email.trim() || null,
      });
      onSaved(crmContact);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-body-lg font-semibold text-fg">{contact.displayName}</h2>
          <p className="mt-0.5 text-caption text-fg-muted">{contact.phoneNumber ?? 'No phone number on file'}</p>
        </div>
        <button
          type="button"
          onClick={() => void handleCreateLead()}
          disabled={creatingLead || leadCreated}
          className="shrink-0 rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-2 disabled:opacity-50"
        >
          {leadCreated ? 'Lead created — see Pipeline' : creatingLead ? 'Creating…' : '+ Create lead'}
        </button>
      </div>

      <div className="mt-5 space-y-3 max-w-md">
        <div>
          <label className="text-caption font-medium text-fg-secondary" htmlFor="crm-stage">
            Stage
          </label>
          <input
            id="crm-stage"
            list="crm-stage-options"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            placeholder="new_enquiry"
            className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg outline-none focus:border-accent"
          />
          <datalist id="crm-stage-options">
            {STAGE_OPTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="text-caption font-medium text-fg-secondary" htmlFor="crm-lead-status">
            Lead status
          </label>
          <input
            id="crm-lead-status"
            list="crm-lead-status-options"
            value={leadStatus}
            onChange={(e) => setLeadStatus(e.target.value)}
            placeholder="open"
            className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg outline-none focus:border-accent"
          />
          <datalist id="crm-lead-status-options">
            {LEAD_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="text-caption font-medium text-fg-secondary" htmlFor="crm-tags">
            Tags (comma separated)
          </label>
          <input
            id="crm-tags"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="vip, follow-up"
            className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg outline-none focus:border-accent"
          />
        </div>
        <div>
          <label className="text-caption font-medium text-fg-secondary" htmlFor="crm-email">
            Email
          </label>
          <input
            id="crm-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Needed before this contact can be emailed"
            className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg outline-none focus:border-accent"
          />
          {/* WhatsApp never supplies an address, so this is only ever what
              someone typed - and email automations skip contacts without one
              rather than guessing. */}
          <p className="mt-1 text-meta text-fg-muted">WhatsApp does not provide email addresses, so this is entered by hand.</p>
        </div>
        <div>
          <label className="text-caption font-medium text-fg-secondary" htmlFor="crm-notes">
            Notes
          </label>
          <textarea
            id="crm-notes"
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full resize-none rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg outline-none focus:border-accent"
          />
        </div>
        {error && <p className="text-caption text-error">{error}</p>}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="rounded-lg bg-accent px-3 py-2 text-body font-medium text-white hover:bg-accent-dim disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ContactsTab({ focusContactId }: { focusContactId: string | null }) {
  const [contacts, setContacts] = useState<WorkspaceCrmContactSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(focusContactId);

  function load() {
    api
      .listCrmContacts()
      .then((res) => {
        setContacts(res.crmContacts);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load CRM contacts.'));
  }

  useEffect(load, []);

  useEffect(() => {
    if (focusContactId) setSelectedId(focusContactId);
  }, [focusContactId]);

  const selected = contacts?.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex h-full flex-1">
      <div
        className={`w-full shrink-0 overflow-y-auto border-r border-border-subtle md:flex md:w-80 ${selectedId ? 'hidden' : 'flex'} flex-col`}
      >
        {error && <p className="p-4 text-caption text-error">{error}</p>}
        {contacts && contacts.length === 0 && (
          <p className="p-4 text-body text-fg-muted">
            No CRM contacts yet. A profile is created automatically the first time you open a chat in the Inbox.
          </p>
        )}
        {contacts?.map((contact) => (
          <button
            key={contact.id}
            type="button"
            onClick={() => setSelectedId(contact.id)}
            className={`flex w-full flex-col gap-1 border-b border-border-subtle/60 px-4 py-3 text-left transition-colors ${
              selectedId === contact.id ? 'bg-accent-soft' : 'hover:bg-surface-2'
            }`}
          >
            <p className="truncate text-body font-medium text-fg">{contact.displayName}</p>
            <div className="flex items-center gap-1.5">
              {contact.stage && (
                <span className="rounded-full bg-surface-3 px-2 py-0.5 text-meta text-fg-secondary">{contact.stage}</span>
              )}
              {contact.leadStatus && (
                <span className="rounded-full bg-surface-3 px-2 py-0.5 text-meta text-fg-secondary">{contact.leadStatus}</span>
              )}
            </div>
          </button>
        ))}
      </div>

      {selected ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="flex shrink-0 items-center gap-1.5 border-b border-border-subtle px-4 py-2.5 text-caption font-medium text-fg-secondary hover:text-fg md:hidden"
          >
            ← Back to contacts
          </button>
          <ContactDetailCard
            key={selected.id}
            contact={selected}
            onSaved={(updated) => setContacts((prev) => prev?.map((c) => (c.id === updated.id ? updated : c)) ?? prev)}
          />
        </div>
      ) : (
        <div className="hidden flex-1 items-center justify-center text-body text-fg-muted md:flex">Select a contact</div>
      )}
    </div>
  );
}

function LeadCard({
  lead,
  onChanged,
  highlighted,
}: {
  lead: WorkspaceLeadSummary;
  onChanged: (updated: WorkspaceLeadSummary) => void;
  highlighted: boolean;
}) {
  const [busy, setBusy] = useState(false);

  async function move(status: LeadStatusValue) {
    setBusy(true);
    try {
      const { lead: updated } = await api.updateLeadStatus(lead.id, status);
      onChanged(updated);
    } catch {
      // Best-effort UI action - the list stays in its last real state on failure.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`rounded-xl border bg-surface-2 p-3 ${highlighted ? 'border-accent ring-1 ring-accent' : 'border-border-subtle'}`}>
      <p className="text-body font-medium text-fg">{lead.displayName}</p>
      {lead.nextAction && <p className="mt-1 text-caption text-fg-secondary">Next: {lead.nextAction}</p>}
      <div className="mt-2 flex items-center justify-between text-meta text-fg-muted">
        <span>{formatMoney(lead.value)}</span>
        {lead.score !== null && <span>Score {lead.score}</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {PIPELINE_STATUSES.filter((s) => s !== lead.status).map((s) => (
          <button
            key={s}
            type="button"
            disabled={busy}
            onClick={() => void move(s)}
            className="rounded-full bg-surface-3 px-2 py-0.5 text-meta text-fg-secondary hover:bg-surface-1 disabled:opacity-50"
          >
            → {PIPELINE_LABEL[s]}
          </button>
        ))}
      </div>
    </div>
  );
}

function LeadsTab({ focusLeadId }: { focusLeadId: string | null }) {
  const [leads, setLeads] = useState<WorkspaceLeadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listLeads()
      .then((res) => {
        setLeads(res.leads);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load leads.'));
  }, []);

  function handleChanged(updated: WorkspaceLeadSummary) {
    setLeads((prev) => prev?.map((l) => (l.id === updated.id ? updated : l)) ?? prev);
  }

  if (error) return <p className="p-6 text-caption text-error">{error}</p>;
  if (leads && leads.length === 0) {
    return (
      <p className="p-6 text-body text-fg-muted">
        No leads yet. Create one from a CRM contact once real conversations have qualified prospects to track.
      </p>
    );
  }

  return (
    <div className="flex flex-1 gap-3 overflow-x-auto p-4">
      {PIPELINE_STATUSES.map((status) => (
        <div key={status} className="w-64 shrink-0">
          <div className="mb-2 flex items-center gap-2 px-1">
            <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${PIPELINE_COLOR[status]}`}>
              {PIPELINE_LABEL[status]}
            </span>
            <span className="text-caption text-fg-muted">{leads?.filter((l) => l.status === status).length ?? 0}</span>
          </div>
          <div className="space-y-2">
            {leads?.filter((l) => l.status === status).map((lead) => (
              <LeadCard key={lead.id} lead={lead} onChanged={handleChanged} highlighted={lead.id === focusLeadId} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CrmRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: 'contacts' | 'leads' = searchParams.get('tab') === 'leads' ? 'leads' : 'contacts';
  const focusContactId = searchParams.get('contactId');
  const focusLeadId = searchParams.get('leadId');

  function setTab(value: 'contacts' | 'leads') {
    setSearchParams(value === 'contacts' ? {} : { tab: value });
  }

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-4 py-3">
        <h1 className="mr-4 text-body-lg font-semibold text-fg">CRM &amp; Leads</h1>
        {(['contacts', 'leads'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-full px-3 py-1 text-caption font-medium transition-colors ${
              tab === value ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-fg-secondary hover:bg-surface-3'
            }`}
          >
            {value === 'contacts' ? 'Contacts' : 'Pipeline'}
          </button>
        ))}
      </div>
      {tab === 'contacts' ? <ContactsTab focusContactId={focusContactId} /> : <LeadsTab focusLeadId={focusLeadId} />}
    </div>
  );
}
