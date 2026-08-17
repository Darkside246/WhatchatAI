import { useEffect, useState } from 'react';
import { api, mediaUrl, ApiError, type WorkspaceBusiness, type WhatsAppConnectionSnapshot } from '../lib/api.js';
import { Avatar } from '../components/Avatar.js';
import { useTheme } from '../hooks/useTheme.js';
import { THEMES } from '../theme.js';

const STATUS_COLOR: Record<WhatsAppConnectionSnapshot['status'], string> = {
  CONNECTED: 'bg-success/15 text-success',
  CONNECTING: 'bg-info/15 text-info',
  QR_READY: 'bg-info/15 text-info',
  RECONNECTING: 'bg-warning/15 text-warning',
  DISCONNECTED: 'bg-fg-muted/15 text-fg-muted',
  LOGGED_OUT: 'bg-error/15 text-error',
  ERROR: 'bg-error/15 text-error',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function BusinessProfileCard() {
  const [business, setBusiness] = useState<WorkspaceBusiness | null>(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getBusiness()
      .then((res) => {
        setBusiness(res.business);
        setName(res.business.name);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load business profile.'));
  }, []);

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.updateBusiness(name.trim());
      setBusiness(res.business);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <h2 className="text-sm font-semibold text-fg">Business profile</h2>
      {error && <p className="mt-2 text-xs text-error">{error}</p>}
      {business && !editing && (
        <div className="mt-3 flex items-center justify-between">
          <p className="text-sm text-fg">{business.name}</p>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-3"
          >
            Rename
          </button>
        </div>
      )}
      {business && editing && (
        <div className="mt-3 flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
            className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setName(business.name);
            }}
            className="rounded-lg px-3 py-2 text-xs text-fg-muted hover:text-fg"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function WhatsAppAccountCard({ connection }: { connection: WhatsAppConnectionSnapshot | null }) {
  const [busy, setBusy] = useState<'disconnect' | 'logout' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDisconnect() {
    setBusy('disconnect');
    setError(null);
    try {
      await api.disconnectWhatsApp();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect.');
    } finally {
      setBusy(null);
    }
  }

  async function handleLogout() {
    if (!window.confirm('Log out of WhatsApp? You will need to re-scan a QR code on your phone to reconnect.')) return;
    setBusy('logout');
    setError(null);
    try {
      await api.logoutWhatsApp();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log out.');
    } finally {
      setBusy(null);
    }
  }

  if (!connection) return null;

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">WhatsApp account</h2>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_COLOR[connection.status]}`}>
          {connection.status.replace('_', ' ')}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Avatar
          label={connection.pushName ?? connection.phoneNumber ?? '?'}
          photoUrl={connection.avatarMediaId ? mediaUrl(connection.avatarMediaId) : null}
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{connection.pushName ?? '—'}</p>
          <p className="truncate text-xs text-fg-muted">{connection.phoneNumber ?? '—'}</p>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-fg-muted">Name</dt>
          <dd className="mt-0.5 text-fg-secondary">{connection.pushName ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-fg-muted">Phone number</dt>
          <dd className="mt-0.5 text-fg-secondary">{connection.phoneNumber ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-fg-muted">Connected since</dt>
          <dd className="mt-0.5 text-fg-secondary">{formatDate(connection.connectedAt)}</dd>
        </div>
        <div>
          <dt className="text-fg-muted">Last disconnect</dt>
          <dd className="mt-0.5 text-fg-secondary">{formatDate(connection.lastDisconnectAt)}</dd>
        </div>
      </dl>

      {connection.lastError && <p className="mt-3 text-xs text-error">{connection.lastError}</p>}
      {error && <p className="mt-3 text-xs text-error">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => void handleDisconnect()}
          disabled={busy !== null || connection.status === 'DISCONNECTED' || connection.status === 'LOGGED_OUT'}
          title="Closes the connection but keeps your session - reconnect without re-scanning"
          className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
        >
          {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
        </button>
        <button
          type="button"
          onClick={() => void handleLogout()}
          disabled={busy !== null}
          title="Ends the session entirely - you'll need to scan a new QR code"
          className="rounded-lg border border-error/30 px-3 py-1.5 text-xs font-medium text-error hover:bg-error/10 disabled:opacity-50"
        >
          {busy === 'logout' ? 'Logging out…' : 'Log out'}
        </button>
      </div>
    </div>
  );
}

/** Representative (background, accent) swatch pair per theme - matches index.css's [data-theme] token overrides exactly. */
const THEME_SWATCHES: Record<string, [string, string]> = {
  sleek: ['#f0f2f5', '#4f46e5'],
  dark: ['#0c1317', '#00a884'],
  light: ['#d1d7db', '#00a884'],
  midnight: ['#000000', '#238636'],
  forest: ['#0a1612', '#2ec4b6'],
  sunset: ['#140c1a', '#d946ef'],
};

function ThemeCard() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-2 p-5">
      <h2 className="text-sm font-semibold text-fg">Theme</h2>
      <p className="mt-1 text-xs text-fg-muted">Saved to this browser - applies instantly, everywhere in the app.</p>
      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {THEMES.map((option) => {
          const [bg, accent] = THEME_SWATCHES[option.id] ?? ['#000000', '#000000'];
          const selected = theme === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setTheme(option.id)}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                selected ? 'border-accent bg-accent-soft' : 'border-border-subtle hover:bg-surface-3'
              }`}
            >
              <span
                className="h-7 w-7 shrink-0 rounded-full border border-border-subtle"
                style={{ background: `conic-gradient(${accent} 0deg 180deg, ${bg} 180deg 360deg)` }}
                aria-hidden
              />
              <span className={`text-xs font-medium ${selected ? 'text-accent' : 'text-fg-secondary'}`}>{option.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SettingsRoute({ connection }: { connection: WhatsAppConnectionSnapshot | null }) {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold text-fg">Settings</h1>
      <p className="mt-1 text-sm text-fg-muted">Only settings with a real backend - or a real, persisted client-side effect - appear here.</p>

      <div className="mt-6 max-w-2xl space-y-4">
        <ThemeCard />
        <BusinessProfileCard />
        <WhatsAppAccountCard connection={connection} />
      </div>
    </div>
  );
}
