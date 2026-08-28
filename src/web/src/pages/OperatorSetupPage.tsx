import { useState } from 'react';
import { Loader2, Lock, Phone, ShieldCheck, SkipForward } from 'lucide-react';
import { api } from '../lib/api.js';

interface Props {
  onDone: () => void;
  onSkip: () => void;
}

export function OperatorSetupPage({ onDone, onSkip }: Props) {
  const [jid, setJid] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pin.length < 4) { setError('PIN must be at least 4 characters.'); return; }
    if (pin !== confirmPin) { setError('PINs do not match.'); return; }
    const waJid = jid.trim().replace(/\D/g, '');
    if (waJid.length < 7) { setError('Enter a valid WhatsApp number (digits only, include country code).'); return; }

    setSaving(true);
    try {
      await api.setOperatorSettings({ operatorWaJid: waJid, pin, enabled: true });
      onDone();
    } catch {
      setError('Failed to save operator settings. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-surface-0 px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft">
            <Lock size={24} className="text-accent" aria-hidden />
          </div>
          <h1 className="text-display font-semibold tracking-tight text-fg">Set up Operator Mode</h1>
          <p className="mt-2 text-body leading-relaxed text-fg-secondary">
            WhatsApp your own business number from your personal phone to manage your business on the go — check stats,
            mark invoices paid, log incidents, and more.
          </p>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
          <div>
            <label htmlFor="op-jid" className="mb-1.5 block text-caption font-medium text-fg">
              Your personal WhatsApp number
            </label>
            <div className="relative">
              <Phone size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" aria-hidden />
              <input
                id="op-jid"
                type="tel"
                value={jid}
                onChange={(e) => setJid(e.target.value)}
                placeholder="1246XXXXXXX (include country code)"
                className="control-md w-full pl-9"
                required
              />
            </div>
            <p className="mt-1 text-meta text-fg-muted">
              This is the number you'll message <em>from</em>, not your business number.
            </p>
          </div>

          <div>
            <label htmlFor="op-pin" className="mb-1.5 block text-caption font-medium text-fg">
              Set a PIN (min. 4 characters)
            </label>
            <input
              id="op-pin"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="••••"
              minLength={4}
              maxLength={20}
              className="control-md w-full"
              required
            />
          </div>

          <div>
            <label htmlFor="op-pin-confirm" className="mb-1.5 block text-caption font-medium text-fg">
              Confirm PIN
            </label>
            <input
              id="op-pin-confirm"
              type="password"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              placeholder="••••"
              minLength={4}
              maxLength={20}
              className="control-md w-full"
              required
            />
          </div>

          {error && (
            <p className="rounded-lg bg-error-soft px-4 py-2.5 text-caption text-error">{error}</p>
          )}

          <div className="rounded-xl border border-border-subtle bg-surface-1 p-4">
            <p className="flex items-center gap-2 text-caption font-semibold text-fg">
              <ShieldCheck size={14} className="shrink-0 text-accent" aria-hidden />
              How it works
            </p>
            <ul className="mt-2 space-y-1 text-meta leading-relaxed text-fg-secondary">
              <li>• Message your business number → PIN challenge is sent back</li>
              <li>• Reply with your PIN → 30-minute authenticated session</li>
              <li>• After 3 wrong attempts the session is locked</li>
              <li>• All commands are scoped to your business only</li>
            </ul>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="control-lg w-full justify-center bg-accent font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Lock size={16} aria-hidden />}
            {saving ? 'Saving…' : 'Enable Operator Mode'}
          </button>
        </form>

        <button
          type="button"
          onClick={onSkip}
          className="mt-4 flex w-full items-center justify-center gap-2 text-caption text-fg-muted hover:text-fg"
        >
          <SkipForward size={13} aria-hidden />
          Skip for now — set up later in Settings
        </button>
      </div>
    </div>
  );
}
