import { useState, type FormEvent } from 'react';
import { useAuth } from '../hooks/useAuth.js';

export function RegisterPage() {
  const auth = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    auth.clearError();
    setBusy(true);
    try {
      await auth.register({ email, password, displayName });
    } catch {
      // auth.error already carries the message.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-surface-0 px-6 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-title font-bold text-accent">W</div>
          <span className="text-title font-semibold tracking-tight text-fg">WhatchatAI</span>
        </div>

        <h1 className="mb-1 text-display font-semibold text-fg">Create your workspace</h1>
        <p className="mb-6 text-body text-fg-secondary">
          You&apos;re the first person here, so this account becomes the workspace owner.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-body text-fg-secondary">
            Your name
            <input
              type="text"
              required
              autoFocus
              autoComplete="name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-body text-fg outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-body text-fg-secondary">
            Email
            <input
              type="email"
              required
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
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-body text-fg outline-none focus:border-accent"
            />
          </label>
          <p className="text-caption text-fg-muted">At least 8 characters.</p>

          {auth.error && <p className="text-body text-error">{auth.error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="mt-2 rounded-lg bg-accent px-3 py-2.5 text-body font-medium text-white transition hover:bg-accent-dim disabled:opacity-50"
          >
            {busy ? 'Creating workspace…' : 'Create workspace'}
          </button>
        </form>
      </div>
    </div>
  );
}
