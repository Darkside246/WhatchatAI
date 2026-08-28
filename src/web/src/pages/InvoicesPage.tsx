import { useEffect, useState, type FormEvent } from 'react';
import { Plus, Receipt, FileText, CheckSquare, Send, DollarSign, X, Eye } from 'lucide-react';
import { api, ApiError, type InvoiceDto, type InvoiceLineItemDto, type CreateInvoiceInput } from '../lib/api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMoney(cents: number, currency = 'BBD') {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_BADGE: Record<InvoiceDto['status'], string> = {
  DRAFT: 'bg-fg-muted/15 text-fg-muted',
  PENDING_APPROVAL: 'bg-info/15 text-info',
  APPROVED: 'bg-accent-soft text-accent',
  SENT: 'bg-info/15 text-info',
  PAID: 'bg-success/15 text-success',
  OVERDUE: 'bg-error/15 text-error',
  CANCELLED: 'bg-fg-muted/15 text-fg-muted line-through',
  VOID: 'bg-fg-muted/15 text-fg-muted line-through',
};

const DOC_ICON: Record<InvoiceDto['documentType'], typeof Receipt> = {
  INVOICE: Receipt,
  QUOTE: FileText,
  RECEIPT: CheckSquare,
};

// ── Create form ───────────────────────────────────────────────────────────────

type LineItemDraft = { description: string; quantity: string; unitPriceStr: string; discountBp: string };

const emptyLine = (): LineItemDraft => ({ description: '', quantity: '1', unitPriceStr: '', discountBp: '0' });

function parseCents(str: string): number {
  const n = parseFloat(str.replace(/,/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100);
}

function CreateInvoiceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (inv: InvoiceDto) => void }) {
  const [docType, setDocType] = useState<'INVOICE' | 'QUOTE' | 'RECEIPT'>('INVOICE');
  const [currency, setCurrency] = useState('BBD');
  const [taxPctStr, setTaxPctStr] = useState('0');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineItemDraft[]>([emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function setLine(i: number, patch: Partial<LineItemDraft>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function addLine() { setLines((prev) => [...prev, emptyLine()]); }
  function removeLine(i: number) { setLines((prev) => prev.filter((_, idx) => idx !== i)); }

  const subtotal = lines.reduce((acc, l) => {
    const gross = parseCents(l.unitPriceStr) * parseFloat(l.quantity || '1');
    const disc = Math.round(gross * (parseInt(l.discountBp || '0') / 10000));
    return acc + gross - disc;
  }, 0);
  const taxBp = Math.round((parseFloat(taxPctStr || '0') * 100));
  const taxCents = Math.round(subtotal * taxBp / 10000);
  const total = subtotal + taxCents;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    const parsedLines = lines.map((l, i) => ({
      description: l.description.trim() || `Item ${i + 1}`,
      quantity: parseFloat(l.quantity) || 1,
      unitPriceCents: parseCents(l.unitPriceStr),
      discountBasisPoints: parseInt(l.discountBp || '0'),
      sortOrder: i,
    }));
    if (parsedLines.some((l) => l.unitPriceCents < 0)) { setErr('Unit prices must be ≥ 0.'); return; }
    const input: CreateInvoiceInput = {
      documentType: docType,
      currencyCode: currency,
      taxBasisPoints: taxBp,
      dueDate: dueDate || undefined,
      notes: notes.trim() || undefined,
      lineItems: parsedLines,
    };
    setBusy(true);
    try {
      const result = await api.createInvoice(input);
      onCreated(result.invoice);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to create.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface-1 shadow-2xl" style={{ maxHeight: 'calc(100vh - 2rem)' }}>
        <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-4">
          <h2 className="text-body font-semibold text-fg">New document</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-fg-muted hover:text-fg"><X size={16} /></button>
        </div>
        <form onSubmit={(e) => void handleSubmit(e)} className="min-h-0 flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-caption font-medium text-fg">Type</label>
              <select value={docType} onChange={(e) => setDocType(e.target.value as typeof docType)} className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg focus:outline-none focus:ring-1 focus:ring-accent">
                <option value="INVOICE">Invoice</option>
                <option value="QUOTE">Quote</option>
                <option value="RECEIPT">Receipt</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-caption font-medium text-fg">Currency</label>
              <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg focus:outline-none focus:ring-1 focus:ring-accent" />
            </div>
            <div>
              <label className="mb-1 block text-caption font-medium text-fg">Tax %</label>
              <input type="number" min="0" max="100" step="0.01" value={taxPctStr} onChange={(e) => setTaxPctStr(e.target.value)} className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg focus:outline-none focus:ring-1 focus:ring-accent" />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-caption font-medium text-fg">Due date (optional)</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-caption font-medium text-fg">Line items</label>
              <button type="button" onClick={addLine} className="flex items-center gap-1 rounded-lg bg-accent/10 px-2 py-1 text-caption text-accent hover:bg-accent/20 transition-colors">
                <Plus size={12} /> Add line
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-caption">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-fg-muted">
                    <th className="pb-2 pr-2 font-medium">Description</th>
                    <th className="pb-2 pr-2 font-medium w-16 text-right">Qty</th>
                    <th className="pb-2 pr-2 font-medium w-24 text-right">Unit price</th>
                    <th className="pb-2 pr-2 font-medium w-16 text-right">Disc %</th>
                    <th className="pb-2 font-medium w-24 text-right">Total</th>
                    <th className="pb-2 w-6" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const gross = parseCents(l.unitPriceStr) * parseFloat(l.quantity || '1');
                    const disc = Math.round(gross * parseInt(l.discountBp || '0') / 10000);
                    const lineTotal = gross - disc;
                    return (
                      <tr key={i} className="border-b border-border-subtle/40 last:border-0">
                        <td className="py-1.5 pr-2">
                          <input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="Description" className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 text-fg placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-accent" />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input type="number" min="0.01" step="0.01" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} className="w-16 rounded border border-border-subtle bg-surface-2 px-2 py-1 text-right text-fg focus:outline-none focus:ring-1 focus:ring-accent" />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input type="number" min="0" step="0.01" value={l.unitPriceStr} onChange={(e) => setLine(i, { unitPriceStr: e.target.value })} placeholder="0.00" className="w-24 rounded border border-border-subtle bg-surface-2 px-2 py-1 text-right text-fg focus:outline-none focus:ring-1 focus:ring-accent" />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input type="number" min="0" max="100" step="1" value={Math.round(parseInt(l.discountBp || '0') / 100)} onChange={(e) => setLine(i, { discountBp: String(Math.round(parseFloat(e.target.value) * 100)) })} className="w-16 rounded border border-border-subtle bg-surface-2 px-2 py-1 text-right text-fg focus:outline-none focus:ring-1 focus:ring-accent" />
                        </td>
                        <td className="py-1.5 text-right font-tabular-nums text-fg">{fmtMoney(lineTotal, currency)}</td>
                        <td className="py-1.5 pl-2">
                          {lines.length > 1 && <button type="button" onClick={() => removeLine(i)} className="text-fg-muted hover:text-error"><X size={12} /></button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-col items-end gap-1 text-caption">
              <span className="text-fg-muted">Subtotal: <span className="font-tabular-nums text-fg">{fmtMoney(subtotal, currency)}</span></span>
              {taxBp > 0 && <span className="text-fg-muted">Tax ({(taxBp / 100).toFixed(2)}%): <span className="font-tabular-nums text-fg">{fmtMoney(taxCents, currency)}</span></span>}
              <span className="font-semibold text-fg">Total: <span className="font-tabular-nums">{fmtMoney(total, currency)}</span></span>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-caption font-medium text-fg">Notes (optional)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Payment terms, reference notes…" className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>

          {err && <p className="text-caption text-error">{err}</p>}

          <div className="flex gap-2 pt-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-accent px-5 py-2 text-caption font-medium text-white disabled:opacity-50 hover:bg-accent-dim transition-colors">
              {busy ? 'Creating…' : 'Create draft'}
            </button>
            <button type="button" onClick={onClose} className="rounded-lg border border-border-subtle px-4 py-2 text-caption text-fg-secondary hover:text-fg transition-colors">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function InvoiceDetailPanel({ invoice, lineItems, onUpdate, onClose }: {
  invoice: InvoiceDto;
  lineItems: InvoiceLineItemDto[];
  onUpdate: (inv: InvoiceDto) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function action(fn: () => Promise<{ invoice: InvoiceDto }>, label: string) {
    setBusy(label);
    setErr(null);
    try {
      const result = await fn();
      onUpdate(result.invoice);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : `Failed to ${label.toLowerCase()}.`);
    } finally {
      setBusy(null);
    }
  }

  const Icon = DOC_ICON[invoice.documentType] ?? Receipt;

  const canSubmit = invoice.status === 'DRAFT';
  const canApprove = invoice.status === 'PENDING_APPROVAL';
  const canSend = invoice.status === 'APPROVED';
  const canMarkPaid = ['SENT', 'OVERDUE', 'APPROVED'].includes(invoice.status);
  const canCancel = !['PAID', 'CANCELLED', 'VOID'].includes(invoice.status);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
        <div className="flex items-center gap-2">
          <Icon size={16} className="text-fg-muted" />
          <span className="text-body font-semibold text-fg">{invoice.invoiceNumber}</span>
          <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${STATUS_BADGE[invoice.status]}`}>{invoice.status.replace('_', ' ')}</span>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-fg-muted hover:text-fg"><X size={16} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <div className="grid grid-cols-2 gap-3 text-caption">
          <div className="rounded-lg bg-surface-2 px-3 py-2">
            <p className="text-fg-muted">Document type</p>
            <p className="font-medium text-fg">{invoice.documentType}</p>
          </div>
          <div className="rounded-lg bg-surface-2 px-3 py-2">
            <p className="text-fg-muted">Currency</p>
            <p className="font-medium text-fg">{invoice.currencyCode}</p>
          </div>
          <div className="rounded-lg bg-surface-2 px-3 py-2">
            <p className="text-fg-muted">Created</p>
            <p className="font-medium text-fg">{fmtDate(invoice.createdAt)}</p>
          </div>
          <div className="rounded-lg bg-surface-2 px-3 py-2">
            <p className="text-fg-muted">Due date</p>
            <p className="font-medium text-fg">{fmtDate(invoice.dueDate)}</p>
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-caption font-medium text-fg-muted uppercase tracking-wide">Line items</h3>
          <div className="rounded-lg border border-border-subtle overflow-hidden">
            <table className="w-full text-caption">
              <thead>
                <tr className="bg-surface-2 text-left text-fg-muted">
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium text-right">Qty</th>
                  <th className="px-3 py-2 font-medium text-right">Unit</th>
                  <th className="px-3 py-2 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((li) => (
                  <tr key={li.id} className="border-t border-border-subtle">
                    <td className="px-3 py-2 text-fg">{li.description}</td>
                    <td className="px-3 py-2 text-right text-fg-secondary">{parseFloat(li.quantity).toFixed(2)}</td>
                    <td className="px-3 py-2 text-right text-fg-secondary font-tabular-nums">{fmtMoney(li.unitPriceCents, invoice.currencyCode)}</td>
                    <td className="px-3 py-2 text-right font-tabular-nums text-fg">{fmtMoney(li.totalCents, invoice.currencyCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-col items-end gap-1 text-caption">
            <span className="text-fg-muted">Subtotal: <span className="font-tabular-nums text-fg">{fmtMoney(invoice.subtotalCents, invoice.currencyCode)}</span></span>
            {invoice.taxBasisPoints > 0 && (
              <span className="text-fg-muted">Tax ({(invoice.taxBasisPoints / 100).toFixed(2)}%): <span className="font-tabular-nums text-fg">{fmtMoney(Math.round(invoice.subtotalCents * invoice.taxBasisPoints / 10000), invoice.currencyCode)}</span></span>
            )}
            <span className="text-body font-semibold text-fg">Total: <span className="font-tabular-nums">{fmtMoney(invoice.totalCents, invoice.currencyCode)}</span></span>
          </div>
        </div>

        {invoice.notes && (
          <div>
            <h3 className="mb-1 text-caption font-medium text-fg-muted uppercase tracking-wide">Notes</h3>
            <p className="text-caption text-fg-secondary whitespace-pre-wrap">{invoice.notes}</p>
          </div>
        )}

        {err && <p className="text-caption text-error">{err}</p>}
      </div>

      <div className="border-t border-border-subtle p-4 space-y-2">
        <a href={api.invoiceHtmlUrl(invoice.id)} target="_blank" rel="noreferrer" className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2 text-caption text-fg-secondary hover:text-fg transition-colors">
          <Eye size={13} /> Preview HTML
        </a>
        <div className="flex gap-2">
          {canSubmit && (
            <button type="button" disabled={!!busy} onClick={() => void action(() => api.submitInvoice(invoice.id), 'Submit')} className="flex-1 rounded-lg bg-info/15 px-3 py-2 text-caption font-medium text-info disabled:opacity-50 hover:bg-info/25 transition-colors">
              {busy === 'Submit' ? 'Submitting…' : 'Submit for approval'}
            </button>
          )}
          {canApprove && (
            <button type="button" disabled={!!busy} onClick={() => void action(() => api.approveInvoice(invoice.id), 'Approve')} className="flex-1 rounded-lg bg-accent px-3 py-2 text-caption font-medium text-white disabled:opacity-50 hover:bg-accent-dim transition-colors">
              {busy === 'Approve' ? 'Approving…' : 'Approve'}
            </button>
          )}
          {canSend && (
            <button type="button" disabled={!!busy} onClick={() => void action(() => api.sendInvoice(invoice.id), 'Send')} className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-caption font-medium text-white disabled:opacity-50 hover:bg-accent-dim transition-colors">
              <Send size={12} />{busy === 'Send' ? 'Marking…' : 'Mark as sent'}
            </button>
          )}
          {canMarkPaid && (
            <button type="button" disabled={!!busy} onClick={() => void action(() => api.markInvoicePaid(invoice.id), 'MarkPaid')} className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-success/15 px-3 py-2 text-caption font-medium text-success disabled:opacity-50 hover:bg-success/25 transition-colors">
              <DollarSign size={12} />{busy === 'MarkPaid' ? 'Marking…' : 'Mark paid'}
            </button>
          )}
          {canCancel && (
            <button type="button" disabled={!!busy} onClick={() => void action(() => api.cancelInvoice(invoice.id), 'Cancel')} className="rounded-lg border border-error/30 px-3 py-2 text-caption font-medium text-error disabled:opacity-50 hover:bg-error/10 transition-colors">
              {busy === 'Cancel' ? '…' : 'Cancel'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Filter = 'ALL' | 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'SENT' | 'PAID' | 'OVERDUE';

const FILTER_LABELS: Record<Filter, string> = {
  ALL: 'All', DRAFT: 'Draft', PENDING_APPROVAL: 'Pending', APPROVED: 'Approved',
  SENT: 'Sent', PAID: 'Paid', OVERDUE: 'Overdue',
};

export function InvoicesPage() {
  const [invoices, setInvoices] = useState<InvoiceDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [docTypeFilter, setDocTypeFilter] = useState<'' | 'INVOICE' | 'QUOTE' | 'RECEIPT'>('');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<{ invoice: InvoiceDto; lineItems: InvoiceLineItemDto[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const opts: { status?: string; type?: string } = {};
      if (filter !== 'ALL') opts.status = filter;
      if (docTypeFilter) opts.type = docTypeFilter;
      const result = await api.listInvoices(opts);
      setInvoices(result.invoices);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [filter, docTypeFilter]);

  async function selectInvoice(inv: InvoiceDto) {
    setDetailLoading(true);
    try {
      const result = await api.getInvoice(inv.id);
      setSelected(result);
    } finally {
      setDetailLoading(false);
    }
  }

  function handleCreated(inv: InvoiceDto) {
    setInvoices((prev) => [inv, ...prev]);
    setShowCreate(false);
  }

  function handleUpdated(inv: InvoiceDto) {
    setInvoices((prev) => prev.map((i) => (i.id === inv.id ? inv : i)));
    setSelected((prev) => (prev ? { ...prev, invoice: inv } : null));
  }

  const totals = {
    paid: invoices.filter((i) => i.status === 'PAID').reduce((acc, i) => acc + i.totalCents, 0),
    outstanding: invoices.filter((i) => ['APPROVED', 'SENT', 'OVERDUE'].includes(i.status)).reduce((acc, i) => acc + i.totalCents, 0),
    draft: invoices.filter((i) => i.status === 'DRAFT').length,
  };

  return (
    <div className="flex h-full flex-col bg-surface-0">
      {showCreate && <CreateInvoiceModal onClose={() => setShowCreate(false)} onCreated={handleCreated} />}

      <div className="flex h-full min-h-0 flex-1">
        {/* Main list */}
        <div className={`flex flex-col ${selected ? 'w-1/2 border-r border-border-subtle' : 'flex-1'}`}>
          {/* Header */}
          <div className="shrink-0 border-b border-border-subtle bg-surface-1 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h1 className="text-title font-semibold text-fg">Invoices & Documents</h1>
                <p className="text-caption text-fg-muted mt-0.5">Invoices, quotes, and receipts — drafts require approval before sending.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-caption font-medium text-white hover:bg-accent-dim transition-colors"
              >
                <Plus size={14} /> New
              </button>
            </div>

            {/* Summary tiles */}
            <div className="mt-4 grid grid-cols-3 gap-3">
              {[
                { label: 'Collected', value: fmtMoney(totals.paid), color: 'text-success' },
                { label: 'Outstanding', value: fmtMoney(totals.outstanding), color: 'text-warning' },
                { label: 'Drafts', value: String(totals.draft), color: 'text-fg-muted' },
              ].map((t) => (
                <div key={t.label} className="rounded-xl border border-border-subtle bg-surface-2 px-3 py-2.5">
                  <p className="text-meta text-fg-muted">{t.label}</p>
                  <p className={`text-body font-semibold font-tabular-nums ${t.color}`}>{t.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Filters */}
          <div className="shrink-0 flex items-center gap-2 overflow-x-auto border-b border-border-subtle bg-surface-1 px-4 py-2">
            {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`shrink-0 rounded-full px-3 py-1 text-caption font-medium transition-colors ${filter === f ? 'bg-accent text-white' : 'bg-surface-2 text-fg-secondary hover:text-fg'}`}
              >
                {FILTER_LABELS[f]}
              </button>
            ))}
            <div className="ml-2 shrink-0">
              <select
                value={docTypeFilter}
                onChange={(e) => setDocTypeFilter(e.target.value as typeof docTypeFilter)}
                className="rounded-lg border border-border-subtle bg-surface-2 px-2 py-1 text-caption text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">All types</option>
                <option value="INVOICE">Invoice</option>
                <option value="QUOTE">Quote</option>
                <option value="RECEIPT">Receipt</option>
              </select>
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex h-32 items-center justify-center text-caption text-fg-muted">Loading…</div>
            ) : invoices.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center gap-2 text-center">
                <Receipt size={28} className="text-fg-muted/40" />
                <p className="text-caption text-fg-muted">No documents yet.</p>
                <button type="button" onClick={() => setShowCreate(true)} className="text-caption text-accent hover:underline">Create your first invoice →</button>
              </div>
            ) : (
              <div className="divide-y divide-border-subtle">
                {invoices.map((inv) => {
                  const Icon = DOC_ICON[inv.documentType] ?? Receipt;
                  const isSelected = selected?.invoice.id === inv.id;
                  return (
                    <button
                      key={inv.id}
                      type="button"
                      onClick={() => void selectInvoice(inv)}
                      className={`flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-surface-2 ${isSelected ? 'bg-accent/5 border-l-2 border-accent' : ''}`}
                    >
                      <Icon size={15} className="shrink-0 text-fg-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-body font-medium text-fg truncate">{inv.invoiceNumber}</span>
                          <span className={`rounded-full px-1.5 py-0.5 text-meta font-medium ${STATUS_BADGE[inv.status]}`}>{inv.status.replace('_', ' ')}</span>
                        </div>
                        <p className="text-caption text-fg-muted mt-0.5">{fmtDate(inv.createdAt)}{inv.dueDate ? ` · Due ${fmtDate(inv.dueDate)}` : ''}</p>
                      </div>
                      <span className="shrink-0 font-tabular-nums text-body font-semibold text-fg">{fmtMoney(inv.totalCents, inv.currencyCode)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="flex w-1/2 flex-col bg-surface-1">
            {detailLoading ? (
              <div className="flex h-32 items-center justify-center text-caption text-fg-muted">Loading…</div>
            ) : (
              <InvoiceDetailPanel
                invoice={selected.invoice}
                lineItems={selected.lineItems}
                onUpdate={handleUpdated}
                onClose={() => setSelected(null)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
