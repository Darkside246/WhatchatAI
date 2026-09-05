import { useEffect, useRef, useState } from 'react';
import { X, RotateCcw } from 'lucide-react';
import { api, ApiError, previewInvoiceHtml, type InvoiceTemplateId, type InvoiceFontId, type InvoiceBlockColors, type InvoiceCustomizationDto } from '../lib/api.js';

const TEMPLATES: { id: InvoiceTemplateId; name: string; description: string }[] = [
  { id: 'classic', name: 'Classic', description: 'A traditional, understated look - restrained color, a single accent rule under the title.' },
  { id: 'modern', name: 'Modern', description: 'A full-width colored header band, a colored item-table header, and a colored total box.' },
  { id: 'minimal', name: 'Minimal', description: 'The most whitespace, thin rules only, uppercase micro-labels - clean and typography-led.' },
];

/** Curated, system-safe fonts (invoiceTemplates.ts, server-side) - each renders identically regardless of network access, unlike a web font. */
const FONTS: { id: InvoiceFontId; name: string; sample: string }[] = [
  { id: 'helvetica', name: 'Helvetica', sample: 'font-sans' },
  { id: 'georgia', name: 'Georgia', sample: 'font-serif' },
  { id: 'times', name: 'Times New Roman', sample: 'font-serif' },
  { id: 'courier', name: 'Courier', sample: 'font-mono' },
];

const COLOR_FIELDS: { key: keyof InvoiceBlockColors; label: string; hint: string }[] = [
  { key: 'headerBg', label: 'Header band', hint: 'Modern only - the filled band behind your logo.' },
  { key: 'accent', label: 'Accent', hint: 'The document title and highlight touches.' },
  { key: 'tableHeaderBg', label: 'Table header background', hint: 'The row above your line items.' },
  { key: 'tableHeaderText', label: 'Table header text', hint: '' },
  { key: 'totalsBg', label: 'Total box background', hint: 'Behind the grand total figure.' },
  { key: 'totalsText', label: 'Total text', hint: '' },
];

const DEBOUNCE_MS = 350;

/**
 * The independent "Customize" entry point (InvoicesPage.tsx) - a business
 * picks one of the 3 real templates (invoiceTemplates.ts, server-side) and
 * can override specific block colors on top of it, watching the exact
 * same live preview a real invoice would render with (POST /invoices/
 * preview, unsaved sample data) as they choose. Saved once, it applies to
 * every invoice/quote/receipt this business generates from then on.
 */
export function InvoiceCustomizePanel({ onClose }: { onClose: () => void }) {
  const [templateId, setTemplateId] = useState<InvoiceTemplateId>('classic');
  const [fontId, setFontId] = useState<InvoiceFontId>('helvetica');
  const [colors, setColors] = useState<InvoiceBlockColors>({});
  const [loaded, setLoaded] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    api
      .getInvoiceCustomization()
      .then((res) => {
        setTemplateId(res.customization.templateId);
        setFontId(res.customization.fontId ?? 'helvetica');
        setColors(res.customization.colors);
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      previewInvoiceHtml({ customization: { templateId, fontId, colors } })
        .then(setPreviewHtml)
        .catch(() => undefined);
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [templateId, fontId, colors, loaded]);

  function setColor(key: keyof InvoiceBlockColors, value: string | null) {
    setColors((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.setInvoiceCustomization({ templateId, fontId, colors } as InvoiceCustomizationDto);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex w-full max-w-5xl overflow-hidden rounded-2xl border border-border-subtle bg-surface-1 shadow-2xl" style={{ height: 'calc(100vh - 4rem)' }}>
        {/* ── Controls ── */}
        <div className="flex w-96 shrink-0 flex-col border-r border-border-subtle">
          <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-4">
            <h2 className="text-body font-semibold text-fg">Customize documents</h2>
            <button type="button" onClick={onClose} className="rounded p-1 text-fg-muted hover:text-fg"><X size={16} /></button>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            <div>
              <p className="mb-2 text-caption font-medium text-fg">Template</p>
              <div className="space-y-2">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => { setTemplateId(t.id); setSaved(false); }}
                    className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      templateId === t.id ? 'border-accent bg-accent-soft' : 'border-border-subtle hover:bg-surface-2'
                    }`}
                  >
                    <p className={`text-caption font-semibold ${templateId === t.id ? 'text-accent' : 'text-fg'}`}>{t.name}</p>
                    <p className="mt-0.5 text-meta text-fg-muted">{t.description}</p>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-2 text-caption font-medium text-fg">Font</p>
              <div className="grid grid-cols-2 gap-2">
                {FONTS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => { setFontId(f.id); setSaved(false); }}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      fontId === f.id ? 'border-accent bg-accent-soft' : 'border-border-subtle hover:bg-surface-2'
                    }`}
                  >
                    <p className={`${f.sample} text-caption font-semibold ${fontId === f.id ? 'text-accent' : 'text-fg'}`}>{f.name}</p>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-2 text-caption font-medium text-fg">Block colors</p>
              <div className="space-y-2.5">
                {COLOR_FIELDS.map((field) => (
                  <div key={field.key} className="flex items-center gap-2.5">
                    <input
                      type="color"
                      value={colors[field.key] ?? '#0a84ff'}
                      onChange={(event) => setColor(field.key, event.target.value)}
                      className="h-8 w-8 shrink-0 cursor-pointer rounded border border-border-subtle bg-surface-2 p-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-caption text-fg-secondary">{field.label}</p>
                      {field.hint && <p className="text-meta text-fg-muted">{field.hint}</p>}
                    </div>
                    {colors[field.key] != null && (
                      <button type="button" onClick={() => setColor(field.key, null)} title="Reset to default" className="shrink-0 rounded p-1 text-fg-muted hover:text-fg">
                        <RotateCcw size={13} aria-hidden />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {error && <p className="text-caption text-error">{error}</p>}
            {saved && !error && <p className="text-caption text-success">Saved - every new document will use this from now on.</p>}
          </div>

          <div className="shrink-0 border-t border-border-subtle p-4">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="w-full rounded-lg bg-accent px-4 py-2.5 text-caption font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {/* ── Live preview ── */}
        <div className="min-w-0 flex-1 bg-surface-0 p-4">
          {previewHtml ? (
            <iframe title="Document preview" srcDoc={previewHtml} className="h-full w-full rounded-lg border border-border-subtle bg-white" />
          ) : (
            <div className="flex h-full items-center justify-center text-caption text-fg-muted">Loading preview…</div>
          )}
        </div>
      </div>
    </div>
  );
}
