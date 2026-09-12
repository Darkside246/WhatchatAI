import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';

/**
 * Where a reset link lands. Reachable without signing in, by definition -
 * the person following it cannot.
 *
 * The token comes from the query string, which is how a link in an email
 * can carry one at all. That has a real cost: a query string is visible in
 * browser history and, with an ordinary <a>, in the Referer header of
 * anything the page loads. It is bounded by the token being single-use and
 * expiring in thirty minutes, and by this page loading nothing external.
 */
export function ResetPasswordPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const token = new URLSearchParams(location.search).get('token') ?? '';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || mismatch || newPassword.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token, newPassword);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset the password. The link may have expired.');
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

        {/*
          A missing token is its own case. Sending someone to a password form
          that cannot possibly work, and only telling them after they have
          chosen one, wastes the one thing they came here to do.
        */}
        {token.length === 0 ? (
          <>
            <h1 className="mb-1 text-display font-semibold text-fg">That link is incomplete</h1>
            <p className="mb-6 text-body text-fg-secondary">
              The reset link is missing its code. Some email apps cut long links in half — try opening it again, or ask for a new one.
            </p>
            <button type="button" onClick={() => navigate('/login')} className="text-body font-medium text-accent hover:underline">
              Back to sign in
            </button>
          </>
        ) : done ? (
          <>
            <h1 className="mb-1 text-display font-semibold text-fg">Password changed</h1>
            <p className="mb-6 text-body text-fg-secondary">
              You&rsquo;ve been signed out everywhere else. Sign in with your new password.
            </p>
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="rounded-lg bg-accent px-3 py-2.5 text-body font-medium text-white transition hover:bg-accent-dim"
            >
              Go to sign in
            </button>
          </>
        ) : (
          <>
            <h1 className="mb-1 text-display font-semibold text-fg">Choose a new password</h1>
            <p className="mb-6 text-body text-fg-secondary">This signs you out on every device.</p>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <label className="block">
                <span className="mb-1 block text-caption font-medium text-fg-secondary">New password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  disabled={busy}
                  className="block w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2.5 text-body text-fg outline-none focus:border-accent disabled:opacity-50"
                />
                <span className="mt-1 block text-meta text-fg-muted">At least 8 characters.</span>
              </label>

              <label className="block">
                <span className="mb-1 block text-caption font-medium text-fg-secondary">Confirm new password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  disabled={busy}
                  className={`block w-full rounded-lg border bg-surface-1 px-3 py-2.5 text-body text-fg outline-none focus:border-accent disabled:opacity-50 ${
                    mismatch ? 'border-error' : 'border-border-subtle'
                  }`}
                />
                {mismatch && <span className="mt-1 block text-meta text-error">The two passwords do not match.</span>}
              </label>

              {error && <p role="alert" className="text-body text-error">{error}</p>}

              <button
                type="submit"
                disabled={busy || mismatch || newPassword.length === 0}
                className="mt-2 rounded-lg bg-accent px-3 py-2.5 text-body font-medium text-white transition hover:bg-accent-dim disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Set new password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
