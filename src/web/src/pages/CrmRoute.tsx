import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  ApiError,
  downloadCrmExport,
  type WorkspaceCrmContactSummary,
  type WorkspaceLeadSummary,
  type LeadStatusValue,
  type WorkspaceCustomerMemory,
} from '../lib/api.js';
import { PIPELINE_STATUSES, nextPipelineOptions } from '../lib/pipelineStages.js';

const STAGE_OPTIONS = ['new_enquiry', 'qualified', 'proposal_sent', 'negotiation', 'customer', 'lost'];
const LEAD_STATUS_OPTIONS = ['open', 'nurturing', 'unresponsive', 'closed'];

/**
 * Section 75-91 (data privacy): a real data-subject-access download,
 * client-side from the already-fetched JSON - no server-side
 * Content-Disposition route needed for this one, unlike downloadCrmExport's
 * bulk CSV/JSON export above, since there's no format choice here.
 */
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

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

/**
 * Section 66: makes visible what identityEngine.ts already uses internally
 * to decide how the AI addresses this customer - a "verified name" (real
 * WhatsApp identity confirmation) and a "push name" (whatever the
 * customer's own phone happens to be set to, which can be a nickname, an
 * emoji, or a shared family device's name) are very different in
 * trustworthiness, and staff had no way to see which one a given contact
 * actually has before this. Read-only - the underlying source fields come
 * from WhatsApp itself, not something staff edit here.
 */
function IdentitySourcesPanel({ contact }: { contact: WorkspaceCrmContactSummary }) {
  const sources: { label: string; value: string | null; hint: string }[] = [
    { label: 'Verified name', value: contact.verifiedName, hint: 'Confirmed by WhatsApp itself - the most trustworthy source' },
    { label: 'Business name', value: contact.businessName, hint: 'Set on a WhatsApp Business account' },
    { label: 'Push name', value: contact.pushName, hint: "Whatever this contact's own phone is set to - can be a nickname or shared device name" },
    { label: 'Short name', value: contact.shortName, hint: 'A shorter variant WhatsApp sometimes supplies alongside the push name' },
  ];
  const anyKnown = sources.some((s) => s.value);

  return (
    <div className="mt-4 rounded-lg border border-border-subtle bg-surface-2 p-3">
      <p className="text-caption font-medium text-fg-secondary">Identity sources</p>
      {anyKnown ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
          {sources.map((s) => (
            <div key={s.label} className={s.value ? '' : 'opacity-40'}>
              <dt className="text-meta text-fg-muted" title={s.hint}>
                {s.label}
              </dt>
              <dd className="text-caption text-fg">{s.value ?? '—'}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-1 text-caption text-fg-muted">WhatsApp has not supplied any name information for this contact yet.</p>
      )}
    </div>
  );
}

/**
 * Section 13: customer_memory has been real, written-through, and read
 * back into every AI reply's prompt for a while - a returning customer
 * doesn't have to restate a fact from a past, unrelated conversation.
 * It was never visible to a human anywhere before this - staff had no
 * way to see what the AI actually remembers about a customer across
 * their history. Read-only, fetched on demand per contact (not
 * preloaded into the list) since it's a second real query beyond what
 * listCrmContacts already returns.
 */
function CustomerMemoryPanel({ contactId }: { contactId: string }) {
  const [memory, setMemory] = useState<WorkspaceCustomerMemory | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getCrmContactMemory(contactId)
      .then((res) => { if (!cancelled) setMemory(res.memory); })
      .catch(() => { if (!cancelled) setMemory(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  return (
    <div className="mt-3 rounded-lg border border-border-subtle bg-surface-2 p-3">
      <p className="text-caption font-medium text-fg-secondary">What the AI remembers (across all conversations)</p>
      {loading ? (
        <p className="mt-1 text-caption text-fg-muted">Loading…</p>
      ) : !memory?.customerId ? (
        <p className="mt-1 text-caption text-fg-muted">No customer identity resolved for this contact yet.</p>
      ) : memory.confirmedFacts.length === 0 ? (
        <p className="mt-1 text-caption text-fg-muted">Nothing confirmed yet - facts appear here once the customer states something worth remembering in any conversation.</p>
      ) : (
        <dl className="mt-2 space-y-1.5">
          {memory.confirmedFacts.map((fact) => (
            <div key={fact.key} className="flex items-baseline justify-between gap-3">
              <dt className="text-meta text-fg-muted">{fact.key}</dt>
              <dd className="text-caption text-fg text-right">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
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
  const [manualDisplayName, setManualDisplayName] = useState(contact.manualDisplayName ?? '');
  const [tagsInput, setTagsInput] = useState(contact.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingLead, setCreatingLead] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [isHidden, setIsHidden] = useState(contact.isHidden);
  const [syncExcluded, setSyncExcluded] = useState(contact.syncExcluded);
  const [aiExcluded, setAiExcluded] = useState(contact.aiExcluded);
  const [leadCreated, setLeadCreated] = useState(false);

  useEffect(() => {
    setStage(contact.stage ?? '');
    setLeadStatus(contact.leadStatus ?? '');
    setNotes(contact.notes ?? '');
    setEmail(contact.email ?? '');
    setManualDisplayName(contact.manualDisplayName ?? '');
    setTagsInput(contact.tags.join(', '));
    setLeadCreated(false);
    setIsHidden(contact.isHidden);
    setSyncExcluded(contact.syncExcluded);
    setAiExcluded(contact.aiExcluded);
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

  async function handleExportData() {
    setExporting(true);
    setError(null);
    try {
      const data = await api.exportCrmContactData(contact.id);
      downloadJson(`contact-${contact.id}-data-export.json`, data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to export this contact\'s data.');
    } finally {
      setExporting(false);
    }
  }

  async function handlePrivacyToggle(flag: 'isHidden' | 'syncExcluded' | 'aiExcluded', value: boolean) {
    const setters = { isHidden: setIsHidden, syncExcluded: setSyncExcluded, aiExcluded: setAiExcluded };
    setters[flag](value);
    try {
      await api.setCrmContactPrivacyFlags(contact.id, { [flag]: value });
    } catch {
      setters[flag](!value);
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
        manualDisplayName: manualDisplayName.trim() || null,
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
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => void handleExportData()}
            disabled={exporting}
            title="Download the structured personal data this system holds on this contact - a real data-access export"
            className="rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-2 disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export data'}
          </button>
          <button
            type="button"
            onClick={() => void handleCreateLead()}
            disabled={creatingLead || leadCreated}
            className="rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-2 disabled:opacity-50"
          >
            {leadCreated ? 'Lead created — see Pipeline' : creatingLead ? 'Creating…' : '+ Create lead'}
          </button>
        </div>
      </div>

      <IdentitySourcesPanel contact={contact} />
      <CustomerMemoryPanel contactId={contact.id} />

      <div className="mt-5 space-y-3 max-w-md">
        <div>
          <label className="text-caption font-medium text-fg-secondary" htmlFor="crm-manual-name">
            Confirmed name
          </label>
          <input
            id="crm-manual-name"
            value={manualDisplayName}
            onChange={(e) => setManualDisplayName(e.target.value)}
            placeholder="Leave blank to use the automatic sources above"
            className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg outline-none focus:border-accent"
          />
          <p className="mt-1 text-meta text-fg-muted">
            A correction you enter here outranks every automatic source, including what the customer told the AI directly - use it when you know the real name and WhatsApp's own sources got it wrong.
          </p>
        </div>
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

        <div className="mt-4 space-y-2 border-t border-border-subtle pt-4">
          <p className="text-caption font-medium text-fg-secondary">Privacy flags</p>
          {([
            ['isHidden', isHidden, 'Hide from CRM list'],
            ['syncExcluded', syncExcluded, 'Exclude from sync'],
            ['aiExcluded', aiExcluded, 'Exclude from AI replies'],
          ] as const).map(([flag, checked, label]) => (
            <label key={flag} className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => void handlePrivacyToggle(flag, e.target.checked)}
                className="rounded"
              />
              <span className="text-caption text-fg-secondary">{label}</span>
            </label>
          ))}
        </div>
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
        {nextPipelineOptions(lead.status).map((s) => (
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
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  function setTab(value: 'contacts' | 'leads') {
    setSearchParams(value === 'contacts' ? {} : { tab: value });
  }

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      await downloadCrmExport('csv');
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
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
        <div className="ml-auto flex items-center gap-2">
          {exportError && <span className="text-caption text-error">{exportError}</span>}
          <button
            type="button"
            disabled={exporting}
            onClick={() => void handleExport()}
            className="rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-2 disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>
      {tab === 'contacts' ? <ContactsTab focusContactId={focusContactId} /> : <LeadsTab focusLeadId={focusLeadId} />}
    </div>
  );
}
