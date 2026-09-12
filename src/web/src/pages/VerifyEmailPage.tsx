import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';

/**
 * Where the link in the welcome email lands.
 *
 * Verifies on load rather than behind a button. The person has already
 * acted - they clicked a link in their own inbox - and asking them to
 * confirm that they meant to click the thing they just clicked is a step
 * that exists only to make the page feel busy.
 */
export function VerifyEmailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const token = new URLSearchParams(location.search).get('token') ?? '';

  const [state, setState] = useState<'working' | 'done' | 'failed' | 'missing'>(token ? 'working' : 'missing');
  const [error, setError] = useState<string | null>(null);
  // React runs effects twice in development StrictMode. The token is
  // single-use, so without this the second run spends a token the first
  // already consumed and reports failure for a verification that worked.
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;
    api
      .verifyEmail(token)
      .then(() => setState('done'))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'That link could not be verified.');
        setState('failed');
      });
  }, [token]);

  return (
    <div className="flex min-h-full items-center justify-center bg-surface-0 px-6 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-title font-bold text-accent">A</div>
          <span className="text-title font-semibold tracking-tight text-fg">AURA</span>
        </div>

        {state === 'working' && <p className="text-body text-fg-secondary">Confirming your email…</p>}

        {state === 'missing' && (
          <>
            <h1 className="mb-1 text-display font-semibold text-fg">That link is incomplete</h1>
            <p className="mb-6 text-body text-fg-secondary">
              The confirmation link is missing its code. Some email apps cut long links in half — try opening it again from the
              original message.
            </p>
          </>
        )}

        {state === 'done' && (
          <>
            <h1 className="mb-1 text-display font-semibold text-fg">Email confirmed</h1>
            <p className="mb-6 text-body text-fg-secondary">
              Thanks — that&rsquo;s your address confirmed. Next, connect your WhatsApp number so AURA can start handling your
              conversations.
            </p>
          </>
        )}

        {state === 'failed' && (
          <>
            <h1 className="mb-1 text-display font-semibold text-fg">That link didn&rsquo;t work</h1>
            <p className="mb-2 text-body text-fg-secondary">{error}</p>
            <p className="mb-6 text-caption text-fg-muted">
              Links expire after 48 hours and can only be used once. Sign in and ask for a new one from Settings.
            </p>
          </>
        )}

        {state !== 'working' && (
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="rounded-lg bg-accent px-3 py-2.5 text-body font-medium text-white transition hover:bg-accent-dim"
          >
            Go to AURA
          </button>
        )}
      </div>
    </div>
  );
}
