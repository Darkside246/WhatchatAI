import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle, XCircle, Loader2, ArrowRight } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';

type State =
  | { phase: 'loading' }
  | { phase: 'confirmed'; fullName: string; email: string }
  | { phase: 'already_confirmed' }
  | { phase: 'expired' }
  | { phase: 'error'; message: string };

export function ConsentConfirmPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    if (!token) {
      setState({ phase: 'error', message: 'No confirmation token found in this link.' });
      return;
    }

    api.confirmConsent(token)
      .then((result) => {
        if (result.status === 'confirmed') {
          setState({ phase: 'confirmed', fullName: result.fullName, email: result.email });
        } else if (result.status === 'already_confirmed' || result.status === 'already_used') {
          setState({ phase: 'already_confirmed' });
        } else if (result.status === 'expired') {
          setState({ phase: 'expired' });
        } else {
          setState({ phase: 'error', message: 'This confirmation link is not valid.' });
        }
      })
      .catch((err) => {
        setState({ phase: 'error', message: err instanceof ApiError ? err.message : 'Something went wrong.' });
      });
  }, []);

  return (
    <main className="flex min-h-full items-center justify-center bg-surface-0 px-6 py-10 text-fg">
      <section className="w-full max-w-md rounded-2xl border border-border-subtle bg-surface-1 p-8 shadow-sm text-center">
        {state.phase === 'loading' && (
          <>
            <Loader2 size={36} className="mx-auto mb-4 animate-spin text-accent" aria-hidden />
            <p className="text-body text-fg-secondary">Confirming your consent…</p>
          </>
        )}

        {state.phase === 'confirmed' && (
          <>
            <CheckCircle size={40} className="mx-auto mb-4 text-success" aria-hidden />
            <h1 className="text-xl font-semibold text-fg">Consent confirmed</h1>
            <p className="mt-2 text-body leading-7 text-fg-secondary">
              Thank you, {state.fullName}. Your agreement to the AURA Terms of Service and Privacy Policy has been recorded.
              A copy was sent to <strong className="text-fg">{state.email}</strong>.
            </p>
            <p className="mt-4 text-caption text-fg-muted">
              Your data is encrypted and protected. You may request deletion at any time by contacting privacy@whatchat.ai.
            </p>
            <button
              type="button"
              onClick={() => navigate('/register')}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-body font-semibold text-white hover:bg-accent-dim"
            >
              Continue to account setup
              <ArrowRight size={16} aria-hidden />
            </button>
          </>
        )}

        {state.phase === 'already_confirmed' && (
          <>
            <CheckCircle size={40} className="mx-auto mb-4 text-success" aria-hidden />
            <h1 className="text-xl font-semibold text-fg">Already confirmed</h1>
            <p className="mt-2 text-body text-fg-secondary">
              Your consent has already been confirmed. You're all set.
            </p>
            <button
              type="button"
              onClick={() => navigate('/register')}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-body font-semibold text-white hover:bg-accent-dim"
            >
              Continue to account setup
              <ArrowRight size={16} aria-hidden />
            </button>
          </>
        )}

        {state.phase === 'expired' && (
          <>
            <XCircle size={40} className="mx-auto mb-4 text-error" aria-hidden />
            <h1 className="text-xl font-semibold text-fg">Link expired</h1>
            <p className="mt-2 text-body text-fg-secondary">
              This confirmation link has expired (links are valid for 48 hours). Please return to the sign-up page and submit the form again.
            </p>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="mt-6 w-full rounded-xl border border-border-subtle py-3 text-body font-medium hover:bg-surface-2"
            >
              Back to sign-up
            </button>
          </>
        )}

        {state.phase === 'error' && (
          <>
            <XCircle size={40} className="mx-auto mb-4 text-error" aria-hidden />
            <h1 className="text-xl font-semibold text-fg">Something went wrong</h1>
            <p className="mt-2 text-body text-fg-secondary">{state.message}</p>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="mt-6 w-full rounded-xl border border-border-subtle py-3 text-body font-medium hover:bg-surface-2"
            >
              Back to sign-up
            </button>
          </>
        )}
      </section>
    </main>
  );
}
