import { useEffect, useState, type FormEvent } from 'react';
import { Building2, ChevronDown, ChevronRight } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';

/**
 * The address and phone printed in the header of every invoice, quote and
 * receipt a customer receives.
 *
 * This lives here, in Invoices, rather than buried in Settings: it is part
 * of what a document looks like, so it belongs where documents are made. A
 * person about to send their first invoice should not have to know it was
 * hidden behind a collapsed section three screens away.
 *
 * Deliberately distinct from the "Business details" address/phone in
 * Settings, which feed the AI's knowledge base. These two answer different
 * questions and are genuinely allowed to differ - a business might tell the
 * AI its trading address while printing a registered office on documents.
 */
export function InvoiceContactDetails() {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getBusiness()
      .then((result) => {
        if (cancelled) return;
        setAddress(result.business.address ?? '');
        setPhone(result.business.phone ?? '');
        setLoaded(true);
      })
      .catch(() => {
        // The form still opens and can be saved; a failed prefill must not
        // block editing. It just starts empty rather than showing stale
        // values from another session.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api.setBusinessContactDetails({ address: address.trim() || null, phone: phone.trim() || null });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save those details.');
    } finally {
      setSaving(false);
    }
  }

  const summary = [address.trim(), phone.trim()].filter((part) => part.length > 0).join(' · ');

  return (
    <div className="mb-4 rounded-xl border border-border-subtle bg-surface-1 p-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <Building2 size={14} className="shrink-0 text-accent" aria-hidden />
          <span className="min-w-0">
            <span className="block text-caption font-medium text-fg">Invoice contact details</span>
            <span className="block truncate text-meta text-fg-muted">
              {/* Shows what is really set, so the operator can tell at a
                  glance whether their documents carry contact details at
                  all - rather than having to open the section to find out. */}
              {!loaded ? 'Loading…' : summary.length > 0 ? summary : 'Not set — documents will show no address or phone'}
            </span>
          </span>
        </span>
      </button>

      {open && (
        <form onSubmit={handleSubmit} className="mt-3 space-y-2 border-t border-border-subtle pt-3">
          <p className="text-meta text-fg-muted">
            Printed in the header of every invoice, quote and receipt your customers receive. Separate from the business
            details in Settings, which feed the AI’s knowledge base.
          </p>
          <div>
            <label className="text-meta font-medium text-fg-muted">Address</label>
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Street, city, country"
              className="mt-0.5 block w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="text-meta font-medium text-fg-muted">Phone</label>
            <input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+1 246 …"
              className="mt-0.5 block w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-caption text-fg outline-none focus:border-accent"
            />
          </div>
          {error && <p className="text-meta text-error">{error}</p>}
          {saved && <p className="text-meta text-success">Saved. New documents will carry these details.</p>}
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
    </div>
  );
}
