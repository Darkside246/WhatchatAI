import { useState, type FormEvent } from 'react';
import { useAuth } from '../hooks/useAuth.js';
import { api, ApiError } from '../lib/api.js';

/**
 * Asking for a reset link.
 *
 * Says the same thing whichever address is typed, because the server does:
 * confirming that an address has an account would let anyone test a list of
 * addresses to learn who uses AURA. The person who actually owns the
 * address finds out by receiving the mail.
 */
function ForgotPassword({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      // Only a rate limit is worth surfacing. Everything else resolves the
      // same way by design, so there is nothing else to report.
      setError(err instanceof ApiError ? err.message : 'Could not send the reset email. Try again shortly.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div>
        <h1 className="mb-1 text-display font-semibold text-fg">Check your email</h1>
        <p className="mb-6 text-body text-fg-secondary">
          If there is an AURA account for that address, a reset link is on its way. It works for 30 minutes.
        </p>
        <p className="mb-6 text-caption text-fg-muted">
          Nothing arrived? Check the spam folder, then try again — or ask whoever set up your workspace.
        </p>
        <button type="button" onClick={onBack} className="text-body font-medium text-accent hover:underline">
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-1 text-display font-semibold text-fg">Reset your password</h1>
      <p className="mb-6 text-body text-fg-secondary">We&rsquo;ll email you a link to choose a new one.</p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="block">
          <span className="mb-1 block text-caption font-medium text-fg-secondary">Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            className="block w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2.5 text-body text-fg outline-none focus:border-accent disabled:opacity-50"
          />
        </label>

        {error && <p role="alert" className="text-body text-error">{error}</p>}

        <button
          type="submit"
          disabled={busy || email.trim().length === 0}
          className="mt-2 rounded-lg bg-accent px-3 py-2.5 text-body font-medium text-white transition hover:bg-accent-dim disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
      </form>

      <button type="button" onClick={onBack} className="mt-6 text-body font-medium text-accent hover:underline">
        Back to sign in
      </button>
    </div>
  );
}

export function LoginPage() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    auth.clearError();
    setBusy(true);
    try {
      await auth.login(email, password, rememberMe);
    } catch {
      // auth.error already carries the message - nothing else to do here.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-surface-0 px-6 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-title font-bold text-accent">A</div>
          <span className="text-title font-semibold tracking-tight text-fg">AURA</span>
        </div>

        {forgot ? (
          <ForgotPassword initialEmail={email} onBack={() => setForgot(false)} />
        ) : (
          <>
        <h1 className="mb-1 text-display font-semibold text-fg">Sign in</h1>
        <p className="mb-6 text-body text-fg-secondary">Sign in to your AURA workspace.</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-body text-fg-secondary">
            Email
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-body text-fg outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-body text-fg-secondary">
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-body text-fg outline-none focus:border-accent"
            />
          </label>

          <label className="flex items-center gap-2 text-body text-fg-secondary">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
              className="h-4 w-4 rounded border-border-subtle text-accent focus:ring-accent"
            />
            Remember me
          </label>

          {auth.error && <p className="text-body text-error">{auth.error}</p>}

          <button
            type="button"
            onClick={() => {
              auth.clearError();
              setForgot(true);
            }}
            className="self-start text-caption font-medium text-accent hover:underline"
          >
            Forgot your password?
          </button>

          <button
            type="submit"
            disabled={busy}
            className="mt-2 rounded-lg bg-accent px-3 py-2.5 text-body font-medium text-white transition hover:bg-accent-dim disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-caption text-fg-muted">
          New teammates are added by an existing admin from Settings → Team, not by signing up here.
        </p>
          </>
        )}
      </div>
    </div>
  );
}
