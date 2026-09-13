import { useEffect, useState } from 'react';
import { Bluetooth, Check, Printer, Usb, X } from 'lucide-react';
import {
  DEFAULT_PRINTER_SETTINGS, loadPrinterSettings, savePrinterSettings, type PrinterSettings,
} from '../lib/printerSettings.js';
import { choosePrinter, PrinterError, sendToPrinter, transportAvailable, type PrinterTransportKind } from '../lib/printerTransport.js';
import { EscPosBuilder } from '../lib/escpos.js';

/**
 * Setting up the printer on this device.
 *
 * The honest part of this screen is the transport list: two of the three
 * options do not exist in every browser, and a kitchen that picks Bluetooth
 * on an iPad and finds out at the worst moment is a kitchen that stops
 * trusting the feature. So each option says plainly whether this browser
 * can do it, and the one that always works is never presented as the
 * lesser choice - for a printer installed on the machine it is the right
 * one.
 */

const TRANSPORTS: { kind: PrinterTransportKind; label: string; detail: string; Icon: typeof Printer }[] = [
  { kind: 'browser', label: 'Print dialog', detail: 'Any printer this device already has. Works in every browser.', Icon: Printer },
  { kind: 'bluetooth', label: 'Bluetooth', detail: 'A wireless till printer, paired to this device.', Icon: Bluetooth },
  { kind: 'usb', label: 'USB', detail: 'A printer plugged into this device.', Icon: Usb },
];

export function PrinterSettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<PrinterSettings>(DEFAULT_PRINTER_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setSettings(loadPrinterSettings());
  }, []);

  function update(patch: Partial<PrinterSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    savePrinterSettings(next);
  }

  async function pick(kind: 'bluetooth' | 'usb') {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const target = await choosePrinter(kind);
      update({ transport: kind, label: target.label, enabled: true });
      setNote(`Connected to ${target.label}.`);
    } catch (err) {
      // A person closing the chooser is not an error worth shouting about.
      if (err instanceof DOMException && err.name === 'NotFoundError') setNote('No printer chosen.');
      else setError(err instanceof PrinterError || err instanceof Error ? err.message : 'Could not reach that printer.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * A real strip of paper, not a claim that it worked.
   *
   * Every part of this - the browser's permission, the pairing, the paper
   * width, whether the roll is even in - can only really be confirmed by
   * something coming out of the printer. So the test prints, and what it
   * prints shows the column width so a 58mm setting on 80mm paper is
   * visible at a glance.
   */
  async function testPrint() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const builder = new EscPosBuilder(settings.paper);
      builder.align('center').bold(true).line('AURA').bold(false).line('Printer test').align('left').rule();
      builder.columns2('Paper', `${settings.paper}mm`);
      builder.columns2('Columns', String(builder.columns));
      builder.columns2('Printed', new Date().toLocaleString());
      builder.rule();
      // The full width, so a wrong paper setting shows as a wrapped line
      // rather than as nothing at all.
      builder.line('1234567890'.repeat(5).slice(0, builder.columns));
      builder.cut();

      await sendToPrinter(settings.transport, builder.build(), builder.toPlainText(), settings.paper);
      setNote('Sent. Check the printer.');
    } catch (err) {
      setError(err instanceof PrinterError || err instanceof Error ? err.message : 'That did not print.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col overflow-y-auto rounded-t-2xl bg-surface-1 p-4 sm:rounded-2xl">
        <div className="flex items-start gap-2">
          <div className="min-w-0">
            <p className="text-body font-semibold text-fg">Ticket printer</p>
            <p className="text-meta text-fg-muted">Set up for this device only — each screen has its own printer.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto shrink-0 rounded p-1 text-fg-muted hover:text-fg">
            <X size={16} aria-hidden />
          </button>
        </div>

        {error && <p className="mt-2 rounded bg-error/10 px-2 py-1 text-caption text-error">{error}</p>}
        {note && <p className="mt-2 rounded bg-success/10 px-2 py-1 text-caption text-success">{note}</p>}

        <label className="mt-3 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-caption text-fg">
          <input type="checkbox" checked={settings.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
          Print tickets from this device
        </label>

        {settings.enabled && (
          <>
            <p className="mt-3 text-meta font-medium uppercase tracking-wide text-fg-muted">How it connects</p>
            <div className="mt-1.5 space-y-1.5">
              {TRANSPORTS.map(({ kind, label, detail, Icon }) => {
                const available = transportAvailable(kind);
                const chosen = settings.transport === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    disabled={busy || !available}
                    onClick={() => (kind === 'browser' ? update({ transport: 'browser', label: null }) : void pick(kind))}
                    className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left disabled:opacity-50 ${
                      chosen ? 'border-accent bg-accent-soft' : 'border-border-subtle hover:bg-surface-2'
                    }`}
                  >
                    <Icon size={15} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-caption font-medium text-fg">{label}</span>
                      <span className="block text-meta text-fg-muted">
                        {available ? detail : 'This browser cannot do this. Chrome or Edge can.'}
                      </span>
                      {chosen && settings.label && <span className="block text-meta text-accent">{settings.label}</span>}
                    </span>
                    {chosen && <Check size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />}
                  </button>
                );
              })}
            </div>

            <p className="mt-3 text-meta font-medium uppercase tracking-wide text-fg-muted">Paper</p>
            <div className="mt-1.5 flex gap-1.5">
              {([58, 80] as const).map((width) => (
                <button
                  key={width}
                  type="button"
                  onClick={() => update({ paper: width })}
                  className={`rounded-full px-3 py-1 text-caption font-medium ${
                    settings.paper === width ? 'bg-accent text-white' : 'bg-surface-2 text-fg-secondary hover:text-fg'
                  }`}
                >
                  {width}mm
                </button>
              ))}
            </div>

            <label className="mt-3 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-caption text-fg">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={settings.autoPrintKitchen}
                onChange={(event) => update({ autoPrintKitchen: event.target.checked })}
              />
              <span>
                Print a ticket automatically when an order reaches the kitchen
                <span className="mt-0.5 block text-meta text-fg-muted">
                  Only from this device. Turn it on at one screen, or the same order prints on every one of them.
                </span>
              </span>
            </label>

            <button
              type="button"
              disabled={busy}
              onClick={() => void testPrint()}
              className="mt-3 w-full rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2 disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Print a test ticket'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
