import { useState } from 'react';
import { AlertTriangle, ClipboardPaste, Loader2 } from 'lucide-react';
import { api, ApiError, type FoodMenuImportResultDto } from '../lib/api.js';

/**
 * Pasting in a menu that already exists.
 *
 * Every restaurant's menu is already written down somewhere - a Word
 * document, a PDF, a message to whoever made their flyers. None of them
 * are in our data model, and a business asked to retype forty dishes will
 * stop before it finishes and never come back.
 *
 * Nothing is written until somebody has seen exactly what will happen. The
 * preview and the commit are the same request with one flag between them,
 * so the list on this screen is not an estimate of the import - it IS the
 * import, run without saving.
 */

const SAMPLE = `STARTERS
Chicken wings .......... 9.00
Nachos 11.50

MAINS
Beef burger 18.00
Aged beef, smoked cheddar and our own sauce
Grilled snapper 24.00`;

export function MenuImport({ onImported }: { onImported: () => void }) {
  const [text, setText] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);
  const [preview, setPreview] = useState<FoodMenuImportResultDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { result } = await api.importFoodMenu(text, { dryRun, updateExisting });
      if (dryRun) {
        setPreview(result);
        setDone(null);
      } else {
        setPreview(null);
        setText('');
        setDone(
          `${result.counts.create} added` +
            (result.counts.update > 0 ? `, ${result.counts.update} updated` : '') +
            (result.counts.skip > 0 ? `, ${result.counts.skip} left alone` : '') +
            '.',
        );
        onImported();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that menu.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="flex items-center gap-1.5 text-body font-semibold text-fg">
          <ClipboardPaste size={15} aria-hidden />
          Paste your menu
        </p>
        <p className="text-meta text-fg-muted">
          Copy it from wherever it already lives. A line with a price is a dish, a short line without one is a section,
          and a sentence under a dish is its description. Nothing is saved until you have seen what it will do.
        </p>
      </div>

      <textarea
        value={text}
        onChange={(event) => { setText(event.target.value); setPreview(null); setDone(null); }}
        rows={10}
        placeholder={SAMPLE}
        className="w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 font-mono text-caption text-fg placeholder:text-fg-muted"
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => void run(true)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-40"
        >
          {busy && <Loader2 size={13} className="animate-spin" aria-hidden />}
          Show me what this will do
        </button>

        {/* Off by default. Re-importing a menu after adding three dishes is
            a normal thing to do by accident, and it must not silently
            reset thirty prices somebody corrected by hand. */}
        <label className="flex cursor-pointer items-center gap-2 text-caption text-fg-secondary">
          <input
            type="checkbox"
            checked={updateExisting}
            onChange={(event) => { setUpdateExisting(event.target.checked); setPreview(null); }}
            className="h-3.5 w-3.5 accent-accent"
          />
          Update the price of dishes I already have
        </label>
      </div>

      {error && <p className="rounded-lg bg-error/10 px-3 py-2 text-caption text-error">{error}</p>}
      {done && <p className="rounded-lg bg-success/10 px-3 py-2 text-caption text-success">{done}</p>}

      {preview && <Preview result={preview} busy={busy} onConfirm={() => void run(false)} />}
    </div>
  );
}

function Preview({
  result, busy, onConfirm,
}: {
  result: FoodMenuImportResultDto;
  busy: boolean;
  onConfirm: () => void;
}) {
  const nothingToDo = result.counts.create === 0 && result.counts.update === 0;

  return (
    <div className="rounded-lg border border-border-subtle">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-3 py-2">
        <p className="text-caption font-semibold text-fg">
          {result.counts.create} to add
          {result.counts.update > 0 && <span className="font-normal text-fg-secondary"> · {result.counts.update} to update</span>}
          {result.counts.skip > 0 && <span className="font-normal text-fg-muted"> · {result.counts.skip} already there</span>}
        </p>
        <button
          type="button"
          disabled={busy || nothingToDo}
          onClick={onConfirm}
          className="ml-auto rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-40"
        >
          {nothingToDo ? 'Nothing to import' : 'Add these to my menu'}
        </button>
      </div>

      {result.newCategories.length > 0 && (
        <p className="border-b border-border-subtle px-3 py-2 text-meta text-fg-muted">
          New sections: {result.newCategories.join(', ')}
        </p>
      )}

      {/* Lines the parser would not guess at. Shown before the good rows
          rather than buried under them: an item imported at the wrong
          price is worse than one not imported at all, so the things it
          refused to guess are the part worth reading. */}
      {result.unparsed.length > 0 && (
        <div className="border-b border-border-subtle bg-warning/10 px-3 py-2">
          <p className="flex items-center gap-1.5 text-meta font-semibold text-warning">
            <AlertTriangle size={12} aria-hidden />
            {result.unparsed.length} line{result.unparsed.length === 1 ? '' : 's'} skipped — add {result.unparsed.length === 1 ? 'it' : 'them'} yourself
          </p>
          <ul className="mt-1 space-y-0.5">
            {result.unparsed.map((entry) => (
              <li key={entry.line} className="text-meta text-warning">
                <span className="font-mono opacity-70">line {entry.line}:</span> {entry.text}
                <span className="opacity-70"> — {entry.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="max-h-80 divide-y divide-border-subtle overflow-y-auto">
        {result.rows.map((row) => (
          <li key={`${row.line}-${row.name}`} className="flex items-baseline gap-2 px-3 py-1.5">
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-meta font-semibold ${
                row.action === 'create'
                  ? 'bg-success/15 text-success'
                  : row.action === 'update'
                    ? 'bg-accent-soft text-accent'
                    : 'bg-surface-2 text-fg-muted'
              }`}
            >
              {row.action === 'create' ? 'new' : row.action === 'update' ? 'update' : 'have it'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-caption text-fg">
                {row.name}
                {row.category && <span className="text-fg-muted"> · {row.category}</span>}
              </span>
              {row.note && <span className="block text-meta text-fg-muted">{row.note}</span>}
            </span>
            <span className="shrink-0 text-caption tabular-nums text-fg-secondary">{(row.priceCents / 100).toFixed(2)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
