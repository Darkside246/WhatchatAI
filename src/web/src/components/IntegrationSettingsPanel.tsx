import { useEffect, useState, type FormEvent } from 'react';
import { Mail, Server, Send, Check, AlertTriangle, Bot, Loader2, KeyRound, Info } from 'lucide-react';
import {
  api,
  ApiError,
  type EmailSettingsDto,
  type EmailProviderKind,
  type GooseSettingsDto,
} from '../lib/api.js';

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Shows the outcome of the last REAL test, not an inference from the form
 * being filled in. "Configured" and "working" are different claims and this
 * only ever makes the second one when a test actually succeeded.
 */
function TestOutcome({ at, ok, error }: { at: string | null; ok: boolean | null; error: string | null }) {
  if (!at) return <p className="text-meta text-fg-muted">Not tested yet.</p>;
  return ok ? (
    <p className="flex items-center gap-1.5 text-meta text-success">
      <Check size={11} aria-hidden />
      Last test passed · {formatWhen(at)}
    </p>
  ) : (
    <p className="flex items-start gap-1.5 text-meta text-error">
      <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0-safe">Last test failed · {formatWhen(at)}{error ? ` — ${error}` : ''}</span>
    </p>
  );
}

function EmailSettingsCard() {
  const [settings, setSettings] = useState<EmailSettingsDto | null>(null);
  const [provider, setProvider] = useState<EmailProviderKind>('resend');
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [resendKey, setResendKey] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function load() {
    const result = await api.getEmailSettings();
    const loaded = result.settings;
    setSettings(loaded);
    if (loaded) {
      setProvider(loaded.provider);
      setFromEmail(loaded.fromEmail);
      setFromName(loaded.fromName ?? '');
      setReplyTo(loaded.replyToEmail ?? '');
      setSmtpHost(loaded.smtpHost ?? '');
      setSmtpPort(String(loaded.smtpPort ?? 587));
      setSmtpSecure(loaded.smtpSecure);
      setSmtpUser(loaded.smtpUsername ?? '');
    }
  }

  useEffect(() => {
    void load().catch(() => undefined);
  }, []);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await api.updateEmailSettings({
        provider,
        fromEmail,
        fromName: fromName || null,
        replyToEmail: replyTo || null,
        // Only sent when the operator actually typed one, so saving the form
        // never wipes or round-trips the stored secret.
        ...(resendKey ? { resendApiKey: resendKey } : {}),
        ...(provider === 'smtp'
          ? {
              smtpHost,
              smtpPort: Number(smtpPort) || null,
              smtpSecure,
              smtpUsername: smtpUser || null,
              ...(smtpPass ? { smtpPassword: smtpPass } : {}),
            }
          : {}),
      });
      setResendKey('');
      setSmtpPass('');
      setNotice({ kind: 'ok', text: 'Saved. Send a test to confirm it actually works.' });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save those settings.' });
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    if (!testTo.trim()) return;
    setTesting(true);
    setNotice(null);
    try {
      const result = await api.sendTestEmail(testTo.trim());
      setNotice(result.status === 'ok' ? { kind: 'ok', text: result.detail } : { kind: 'error', text: result.reason });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'The test failed.' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <div className="flex items-center gap-2">
        <Mail size={16} className="text-accent" aria-hidden />
        <h2 className="text-body font-semibold text-fg">Email sending</h2>
      </div>
      <p className="mt-1 text-caption text-fg-muted">
        Used for receipts, invoices and updates. Nothing is sent to a customer without a person approving it.
      </p>

      <form onSubmit={handleSave} className="mt-4 space-y-4">
        <div>
          <span className="text-caption font-medium text-fg-secondary">How should email be sent?</span>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {([
              { kind: 'smtp' as const, icon: Server, label: 'SMTP server', hint: 'Your existing mail host' },
              { kind: 'resend' as const, icon: Send, label: 'Resend API', hint: 'API key, no mail server' },
            ]).map((option) => (
              <button
                key={option.kind}
                type="button"
                onClick={() => setProvider(option.kind)}
                className={`flex items-start gap-2 rounded-lg border p-3 text-left transition-colors ${
                  provider === option.kind ? 'border-accent bg-accent-soft' : 'border-border-subtle bg-surface-1 hover:border-accent/50'
                }`}
              >
                <option.icon size={15} className={`mt-0.5 shrink-0 ${provider === option.kind ? 'text-accent' : 'text-fg-muted'}`} aria-hidden />
                <span className="min-w-0-safe">
                  <span className="block text-caption font-medium text-fg">{option.label}</span>
                  <span className="block text-meta text-fg-muted">{option.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-caption font-medium text-fg-secondary">
            From address
            <input
              required
              type="email"
              value={fromEmail}
              onChange={(event) => setFromEmail(event.target.value)}
              placeholder="hello@yourbusiness.com"
              className="field mt-1 border border-border-subtle bg-surface-1 text-fg"
            />
          </label>
          <label className="text-caption font-medium text-fg-secondary">
            From name
            <input
              value={fromName}
              onChange={(event) => setFromName(event.target.value)}
              placeholder="Your Business"
              className="field mt-1 border border-border-subtle bg-surface-1 text-fg"
            />
          </label>
        </div>

        <label className="block text-caption font-medium text-fg-secondary">
          Reply-to (optional)
          <input
            type="email"
            value={replyTo}
            onChange={(event) => setReplyTo(event.target.value)}
            className="field mt-1 border border-border-subtle bg-surface-1 text-fg"
          />
        </label>

        {provider === 'smtp' ? (
          <div className="space-y-3 rounded-lg border border-border-subtle bg-surface-1 p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-caption font-medium text-fg-secondary sm:col-span-2">
                SMTP host
                <input
                  value={smtpHost}
                  onChange={(event) => setSmtpHost(event.target.value)}
                  placeholder="smtp.yourhost.com"
                  className="field mt-1 border border-border-subtle bg-surface-2 text-fg"
                />
              </label>
              <label className="text-caption font-medium text-fg-secondary">
                Port
                <input
                  inputMode="numeric"
                  value={smtpPort}
                  onChange={(event) => setSmtpPort(event.target.value)}
                  className="field mt-1 border border-border-subtle bg-surface-2 text-fg"
                />
              </label>
            </div>

            <label className="flex items-start gap-2 text-caption text-fg-secondary">
              <input
                type="checkbox"
                checked={smtpSecure}
                onChange={(event) => setSmtpSecure(event.target.checked)}
                className="mt-0.5"
              />
              <span className="min-w-0-safe">
                Use implicit TLS
                <span className="block text-meta text-fg-muted">
                  On for port 465. Off for 587, which upgrades with STARTTLS. Getting this pair wrong is the most common
                  cause of a mail server refusing the connection.
                </span>
              </span>
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-caption font-medium text-fg-secondary">
                Username
                <input
                  value={smtpUser}
                  onChange={(event) => setSmtpUser(event.target.value)}
                  className="field mt-1 border border-border-subtle bg-surface-2 text-fg"
                />
              </label>
              <label className="text-caption font-medium text-fg-secondary">
                Password
                <input
                  type="password"
                  value={smtpPass}
                  onChange={(event) => setSmtpPass(event.target.value)}
                  placeholder={settings?.smtpPasswordSet ? '•••••••• (stored)' : ''}
                  className="field mt-1 border border-border-subtle bg-surface-2 text-fg"
                />
              </label>
            </div>
          </div>
        ) : (
          <label className="block text-caption font-medium text-fg-secondary">
            Resend API key
            <input
              type="password"
              value={resendKey}
              onChange={(event) => setResendKey(event.target.value)}
              placeholder={settings?.resendApiKeySet ? '•••••••• (stored)' : 're_...'}
              className="field mt-1 border border-border-subtle bg-surface-1 text-fg"
            />
          </label>
        )}

        <p className="flex items-start gap-1.5 text-meta text-fg-muted">
          <KeyRound size={11} className="mt-0.5 shrink-0" aria-hidden />
          Secrets are encrypted before they are stored and are never sent back to this page — leave a field blank to keep
          the one already saved.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy} className="control bg-accent font-medium text-white hover:bg-accent-dim disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} aria-hidden />}
            Save settings
          </button>
        </div>
      </form>

      <div className="mt-5 border-t border-border-subtle pt-4">
        <p className="text-caption font-medium text-fg-secondary">Send a real test email</p>
        <p className="mt-0.5 text-meta text-fg-muted">
          The only way to know these settings work. It sends a genuine message through the transport above.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="email"
            value={testTo}
            onChange={(event) => setTestTo(event.target.value)}
            placeholder="you@example.com"
            className="field min-w-0 flex-1 border border-border-subtle bg-surface-1 text-fg"
          />
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing || !testTo.trim()}
            className="control border border-border-subtle font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
          >
            {testing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}
            Send test
          </button>
        </div>
        <div className="mt-2">
          <TestOutcome at={settings?.lastTestAt ?? null} ok={settings?.lastTestOk ?? null} error={settings?.lastTestError ?? null} />
        </div>
      </div>

      {notice && (
        <p className={`mt-3 text-caption ${notice.kind === 'ok' ? 'text-success' : 'text-error'}`}>{notice.text}</p>
      )}
    </section>
  );
}

function GooseSettingsCard() {
  const [settings, setSettings] = useState<GooseSettingsDto | null>(null);
  const [isEnabled, setIsEnabled] = useState(false);
  const [serviceUrl, setServiceUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function load() {
    const result = await api.getGooseSettings();
    setSettings(result);
    setIsEnabled(result.isEnabled);
    setServiceUrl(result.serviceUrl ?? '');
  }

  useEffect(() => {
    void load().catch(() => undefined);
  }, []);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await api.updateGooseSettings({
        isEnabled,
        serviceUrl: serviceUrl || null,
        ...(apiKey ? { apiKey } : {}),
      });
      setApiKey('');
      setNotice({ kind: 'ok', text: 'Saved.' });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save those settings.' });
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setNotice(null);
    try {
      const result = await api.testGooseSettings();
      setNotice(result.status === 'ok' ? { kind: 'ok', text: result.detail } : { kind: 'error', text: result.reason });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'The test failed.' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <div className="flex items-center gap-2">
        <Bot size={16} className="text-accent" aria-hidden />
        <h2 className="text-body font-semibold text-fg">Goose failover</h2>
      </div>
      <p className="mt-1 text-caption text-fg-muted">
        An optional second engine that writes agent replies when Gemini is unavailable.
      </p>

      {/*
        Stated up front because it is the thing most likely to waste an
        operator's afternoon: this is not a Goose install URL. Goose exposes a
        CLI, an ACP server over stdio, and chat gateways - none of which is
        the HTTP contract this app calls.
      */}
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-border-subtle bg-surface-1 p-3 text-meta text-fg-secondary">
        <Info size={12} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
        <div className="min-w-0-safe space-y-1">
          <p>
            This is <span className="font-medium text-fg">not</span> a Goose install URL. Goose itself has no HTTP
            endpoint of this shape, so this must point at a small service that exposes:
          </p>
          <p className="font-mono text-meta text-fg">GET /health · POST /generate</p>
          <p>
            Also worth knowing: Goose needs its own model provider. If you point it at Gemini, then &ldquo;Gemini failed,
            try Goose&rdquo; calls the provider that just failed. A second provider is a stronger failover.
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="mt-4 space-y-3">
        <label className="flex items-center gap-2 text-caption text-fg-secondary">
          <input type="checkbox" checked={isEnabled} onChange={(event) => setIsEnabled(event.target.checked)} />
          Use Goose as a failover for agent replies
        </label>

        <label className="block text-caption font-medium text-fg-secondary">
          Service URL
          <input
            value={serviceUrl}
            onChange={(event) => setServiceUrl(event.target.value)}
            placeholder="https://goose-adapter.internal"
            className="field mt-1 border border-border-subtle bg-surface-1 text-fg"
          />
        </label>

        <label className="block text-caption font-medium text-fg-secondary">
          API key (optional)
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={settings?.apiKeySet ? '•••••••• (stored)' : 'Sent as a bearer token'}
            className="field mt-1 border border-border-subtle bg-surface-1 text-fg"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy} className="control bg-accent font-medium text-white hover:bg-accent-dim disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} aria-hidden />}
            Save
          </button>
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing || !serviceUrl.trim()}
            className="control border border-border-subtle font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
          >
            {testing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}
            Test connection
          </button>
        </div>
      </form>

      <div className="mt-3">
        <TestOutcome at={settings?.lastTestAt ?? null} ok={settings?.lastTestOk ?? null} error={settings?.lastTestError ?? null} />
      </div>

      {notice && <p className={`mt-2 text-caption ${notice.kind === 'ok' ? 'text-success' : 'text-error'}`}>{notice.text}</p>}
    </section>
  );
}

export function IntegrationSettingsPanel() {
  return (
    <div className="space-y-4">
      <EmailSettingsCard />
      <GooseSettingsCard />
    </div>
  );
}
