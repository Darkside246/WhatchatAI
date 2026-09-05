import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../hooks/useAuth.js';
import { ToggleSwitch } from './ToggleSwitch.js';

/**
 * AI Agents Page Consolidation: extracted from SettingsRoute.tsx (same
 * relocation pattern as WhatsAppPairingPanels.tsx, Phase 1) so the merged
 * AI agents page can render them without duplicating code - Settings no
 * longer has separate Personalise/AI & Knowledge tabs, this is now the
 * one home for both.
 */
export function AiActionsPauseCard() {
  const auth = useAuth();
  const canEdit = auth.role === 'OWNER' || auth.role === 'ADMIN';
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = auth.business?.aiActionsPaused ?? false;

  async function handleToggle() {
    setSaving(true); setError(null);
    try { await api.setAiActionsPaused(!paused); await auth.refresh(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to update.'); }
    finally { setSaving(false); }
  }

  return (
    <div className={`rounded-xl border p-5 ${paused ? 'border-error/40 bg-error/5' : 'border-border-subtle bg-surface-2'}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-body font-semibold text-fg">
            {paused && <AlertTriangle size={15} className="text-error" aria-hidden />}
            AI actions
          </h2>
          <p className="mt-1 max-w-lg text-caption text-fg-muted">
            {paused
              ? 'AI actions are paused. Every agent can still read and reply to messages, but no meeting booking or other real-world action will run for any agent or chat until you turn this back on.'
              : 'Emergency stop for every AI agent on this business. Turning this off immediately blocks meeting booking and any other action-taking tool, everywhere - agents still reply, they just can\'t act.'}
          </p>
          {paused && auth.business?.aiActionsPausedAt && (
            <p className="mt-1 text-meta text-fg-muted">
              Paused since {new Date(auth.business.aiActionsPausedAt).toLocaleString()}
            </p>
          )}
          {error && <p className="mt-1 text-caption text-error">{error}</p>}
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-caption font-medium text-fg-secondary">{paused ? 'Paused' : 'Enabled'}</span>
            <ToggleSwitch checked={!paused} onChange={() => void handleToggle()} disabled={saving} label="AI actions enabled" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Personalisation Budget (directive §27): every level maps to a real
 * cooldown minute value in identityEngine.ts's NAME_USAGE_COOLDOWN_MINUTES -
 * never a cosmetic slider position, same "real behaviour per level"
 * principle as AgentsPage.tsx's Autonomy slider this reuses the pattern of.
 */
const NAME_USAGE_LEVELS: { level: number; label: string; description: string }[] = [
  { level: 1, label: 'Minimal', description: 'Uses the customer\'s name rarely - about once an hour of active conversation at most.' },
  { level: 2, label: 'Low', description: 'Uses the name occasionally - roughly once every 30 minutes of active conversation.' },
  { level: 3, label: 'Natural', description: 'The default - uses the name naturally, waiting about 15 minutes before using it again.' },
  { level: 4, label: 'Frequent', description: 'Uses the name often - about once every 5 minutes of active conversation.' },
  { level: 5, label: 'Very frequent', description: 'Uses the name whenever there is real evidence for one, with no waiting period between uses.' },
];

export function PersonaliseCard() {
  const auth = useAuth();
  const canEdit = auth.role === 'OWNER' || auth.role === 'ADMIN';
  const [level, setLevel] = useState(3);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auth.business?.nameUsageLevel) setLevel(auth.business.nameUsageLevel);
    if (auth.business?.nameUsageEnabled !== undefined) setEnabled(auth.business.nameUsageEnabled);
  }, [auth.business?.nameUsageLevel, auth.business?.nameUsageEnabled]);

  async function handleChange(next: number) {
    setLevel(next);
    setSaving(true); setError(null);
    try { await api.setNameUsageLevel(next); await auth.refresh(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to update.'); }
    finally { setSaving(false); }
  }

  async function handleToggle() {
    const next = !enabled;
    setEnabled(next);
    setSaving(true); setError(null);
    try { await api.setNameUsageEnabled(next); await auth.refresh(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to update.'); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-4 rounded-xl border border-border-subtle bg-surface-1 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-body font-semibold text-fg">Name usage</h2>
          <p className="text-caption text-fg-muted">
            {enabled
              ? 'How often your AI agents address a customer by name once they know it - real evidence is always required, this only controls repetition.'
              : 'Your AI agents will not address customers by name, even when it is known - unless a customer specifically asks to be called by name.'}
          </p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-caption font-medium text-fg-secondary">{enabled ? 'On' : 'Off'}</span>
            <ToggleSwitch checked={enabled} onChange={() => void handleToggle()} disabled={saving} label="Name usage enabled" />
          </div>
        )}
      </div>
      {enabled && (
        <div className="px-1">
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={level}
            disabled={!canEdit || saving}
            onChange={(e) => void handleChange(Number(e.target.value))}
            className="w-full accent-accent"
            aria-label="Name usage level"
          />
          <div className="mt-1.5 flex justify-between text-meta text-fg-muted">
            {NAME_USAGE_LEVELS.map(({ level: l }) => (
              <span key={l} className={l === level ? 'font-semibold text-accent' : ''}>{l}</span>
            ))}
          </div>
        </div>
      )}
      {enabled &&
        NAME_USAGE_LEVELS.filter((l) => l.level === level).map((l) => (
          <div key={l.level} className="rounded-lg bg-surface-2 p-3">
            <p className="text-caption font-semibold text-fg">{l.label}</p>
            <p className="mt-1 text-meta text-fg-muted">{l.description}</p>
          </div>
        ))}
      {error && <p className="text-caption text-error">{error}</p>}
    </div>
  );
}

/**
 * AI Agents Page Consolidation: cross-conversation "customer memory"
 * (customer_memory table, Section 20) on/off, plus the real, current
 * count against this business's real plan entitlement - "Buy more
 * memory" only ever appears once actually at the cap (never pre-emptive,
 * matching this codebase's own "no fake connections ahead of real need"
 * principle already applied to Billing's token top-up offer).
 */
export function MemoryCard() {
  const auth = useAuth();
  const canEdit = auth.role === 'OWNER' || auth.role === 'ADMIN';
  const [stats, setStats] = useState<{ enabled: boolean; current: number; limit: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.getCustomerMemoryStats().then(setStats).catch(() => undefined);
  }
  useEffect(load, []);

  async function handleToggle() {
    if (!stats) return;
    const next = !stats.enabled;
    setSaving(true); setError(null);
    try { await api.setCustomerMemoryEnabled(next); setStats({ ...stats, enabled: next }); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to update.'); }
    finally { setSaving(false); }
  }

  if (!stats) return null;
  const atCap = stats.limit !== null && stats.current >= stats.limit;

  return (
    <div className="space-y-3 rounded-xl border border-border-subtle bg-surface-1 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-body font-semibold text-fg">Customer memory</h2>
          <p className="mt-1 max-w-lg text-caption text-fg-muted">
            Lets your AI agents remember facts and a preferred name a customer shares, so they don't have to repeat themselves in a later conversation. Turning this off doesn't erase what's already remembered - it just stops learning anything new.
          </p>
        </div>
        {canEdit && (
          <ToggleSwitch checked={stats.enabled} onChange={() => void handleToggle()} disabled={saving} label="Customer memory enabled" />
        )}
      </div>
      <p className="text-caption text-fg-secondary">
        {stats.current.toLocaleString()} customer{stats.current === 1 ? '' : 's'} remembered
        {stats.limit !== null && <> of {stats.limit.toLocaleString()}</>}
        {stats.limit === null && <> · Unlimited</>}
      </p>
      {atCap && (
        <a href="/billing" className="inline-block text-caption font-semibold text-accent hover:underline">
          Buy more memory →
        </a>
      )}
      {error && <p className="text-caption text-error">{error}</p>}
    </div>
  );
}

/**
 * AURA Learn Agent: only the business OWNER can toggle their own Learn
 * settings (server-enforced - see server/index.ts's requireOwnerForLearn),
 * since this is literally the owner's own writing profile, not something
 * an ADMIN manages on their behalf. Follows MemoryCard's stats-fetch +
 * optimistic-toggle shape above.
 */
export function LearnCard() {
  const auth = useAuth();
  const isOwner = auth.role === 'OWNER';
  const [stats, setStats] = useState<{ enabled: boolean; shareEnabled: boolean; exampleCount: number; lastComputedAt: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);

  function load() {
    api.getLearnStats().then(setStats).catch(() => undefined);
  }
  useEffect(load, []);

  async function handleToggle() {
    if (!stats) return;
    const next = !stats.enabled;
    setSaving(true); setError(null);
    try { await api.setLearnEnabled(next); setStats({ ...stats, enabled: next }); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to update.'); }
    finally { setSaving(false); }
  }

  async function handleReset() {
    setSaving(true); setError(null);
    try { await api.resetLearnProfile(); load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to reset.'); }
    finally { setSaving(false); }
  }

  async function handleForget() {
    setSaving(true); setError(null);
    try { await api.deleteLearnData(); setConfirmForget(false); load(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to delete.'); }
    finally { setSaving(false); }
  }

  if (!stats) return null;

  return (
    <div className="space-y-3 rounded-xl border border-border-subtle bg-surface-1 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-body font-semibold text-fg">Learn</h2>
          <p className="mt-1 max-w-lg text-caption text-fg-muted">
            Aura quietly learns how you write - your tone, phrasing, and style - from messages you send, so your AI agents can sound more like you. This is never shared with anyone and never used to impersonate you.
          </p>
        </div>
        {isOwner && (
          <ToggleSwitch checked={stats.enabled} onChange={() => void handleToggle()} disabled={saving} label="Learn enabled" />
        )}
      </div>
      <p className="text-caption text-fg-secondary">
        {stats.exampleCount.toLocaleString()} writing sample{stats.exampleCount === 1 ? '' : 's'} learned
        {stats.lastComputedAt && <> · last updated {new Date(stats.lastComputedAt).toLocaleDateString()}</>}
      </p>
      {isOwner && stats.enabled && (
        <div className="flex flex-wrap items-center gap-3 text-caption">
          <button type="button" onClick={() => void handleReset()} disabled={saving} className="font-medium text-fg-secondary hover:text-fg disabled:opacity-50">
            Reset profile
          </button>
          {!confirmForget ? (
            <button type="button" onClick={() => setConfirmForget(true)} disabled={saving} className="font-medium text-error hover:underline disabled:opacity-50">
              Forget everything
            </button>
          ) : (
            <span className="flex items-center gap-2">
              <span className="text-fg-muted">Delete every learned sample and profile? This can't be undone.</span>
              <button type="button" onClick={() => void handleForget()} className="font-semibold text-error hover:underline">Confirm</button>
              <button type="button" onClick={() => setConfirmForget(false)} className="text-fg-muted hover:text-fg">Cancel</button>
            </span>
          )}
        </div>
      )}
      {error && <p className="text-caption text-error">{error}</p>}
    </div>
  );
}

/** Independent from LearnCard's toggle above - the spec's own 4-state matrix requires Learn and Share to be controlled separately, both enforced server-side. */
export function LearnShareCard() {
  const auth = useAuth();
  const isOwner = auth.role === 'OWNER';
  const [stats, setStats] = useState<{ enabled: boolean; shareEnabled: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.getLearnStats().then(setStats).catch(() => undefined); }, []);

  async function handleToggle() {
    if (!stats) return;
    const next = !stats.shareEnabled;
    setSaving(true); setError(null);
    try { await api.setLearnShareEnabled(next); setStats({ ...stats, shareEnabled: next }); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to update.'); }
    finally { setSaving(false); }
  }

  if (!stats) return null;

  return (
    <div className="space-y-3 rounded-xl border border-border-subtle bg-surface-1 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-body font-semibold text-fg">Share writing style with agents</h2>
          <p className="mt-1 max-w-lg text-caption text-fg-muted">
            {stats.enabled
              ? "Share what Aura has learned about your writing style with your AI agents, so replies can sound more like you. Off by default - turning this on doesn't change what's learned, only whether agents can use it."
              : 'Turn on Learn above first - there is nothing to share yet.'}
          </p>
        </div>
        {isOwner && (
          <ToggleSwitch checked={stats.shareEnabled} onChange={() => void handleToggle()} disabled={saving || !stats.enabled} label="Share writing style with agents" />
        )}
      </div>
      {error && <p className="text-caption text-error">{error}</p>}
    </div>
  );
}

/**
 * One row per this business's AI agents, checkbox bound to
 * writing_twin_agent_access - the inverse shape of AgentEditor's
 * Capabilities checkboxes (AgentsPage.tsx), which list tools for one
 * agent; here every row is a different agent. Only rendered by the
 * caller once both Learn and Share are on (see AgentsPage.tsx).
 */
export function LearnAgentAccessList({ agents }: { agents: { id: string; name: string }[] }) {
  const auth = useAuth();
  const isOwner = auth.role === 'OWNER';
  const [access, setAccess] = useState<Record<string, boolean> | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getLearnAgentAccess()
      .then((res) => setAccess(Object.fromEntries(res.access.map((a) => [a.agentId, a.allowed]))))
      .catch(() => setAccess({}));
  }, []);

  async function handleToggle(agentId: string) {
    if (!access) return;
    const next = !access[agentId];
    setSavingId(agentId); setError(null);
    try { await api.setLearnAgentAccess(agentId, next); setAccess({ ...access, [agentId]: next }); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to update.'); }
    finally { setSavingId(null); }
  }

  if (!access || agents.length === 0) return null;

  return (
    <div className="space-y-2 rounded-xl border border-border-subtle bg-surface-1 p-5">
      <h2 className="text-body font-semibold text-fg">Which agents can use this</h2>
      <p className="text-caption text-fg-muted">A newly created agent starts without access - turn it on per agent below.</p>
      <div className="divide-y divide-border-subtle">
        {agents.map((agent) => (
          <div key={agent.id} className="flex items-center justify-between gap-3 py-2">
            <span className="text-caption text-fg">{agent.name}</span>
            {isOwner && (
              <ToggleSwitch
                checked={access[agent.id] ?? false}
                onChange={() => void handleToggle(agent.id)}
                disabled={savingId === agent.id}
                label={`Let ${agent.name} use Learn`}
              />
            )}
          </div>
        ))}
      </div>
      {error && <p className="text-caption text-error">{error}</p>}
    </div>
  );
}

/**
 * Business Intelligence Agent: completely separate from Learn (its own
 * tables, own pipeline) - a single per-business opt-in for the background
 * scan that turns chats/invoices/documents/reviews into aggregate,
 * quality-gated insights on the Trends page. Off by default (fail-closed,
 * same as Learn) - nothing is analyzed until this is turned on. Follows
 * MemoryCard's stats-fetch + optimistic-toggle shape.
 */
export function BusinessIntelligenceCard() {
  const auth = useAuth();
  const canEdit = auth.role === 'OWNER' || auth.role === 'ADMIN';
  const [stats, setStats] = useState<{ enabled: boolean; lastRunAt: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getBusinessIntelligenceStats().then(setStats).catch(() => undefined);
  }, []);

  async function handleToggle() {
    if (!stats) return;
    const next = !stats.enabled;
    setSaving(true); setError(null);
    try { await api.setBusinessIntelligenceEnabled(next); setStats({ ...stats, enabled: next }); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to update.'); }
    finally { setSaving(false); }
  }

  if (!stats) return null;

  return (
    <div className="space-y-3 rounded-xl border border-border-subtle bg-surface-1 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-body font-semibold text-fg">Business intelligence</h2>
          <p className="mt-1 max-w-lg text-caption text-fg-muted">
            Quietly scans your chats, invoices and documents in the background for aggregate patterns - customer sentiment, product performance, emerging trends - and publishes only reviewed, evidence-backed results to Trends. It never names an individual customer and never acts on its own.
          </p>
          {stats.enabled && stats.lastRunAt && (
            <p className="mt-1 text-meta text-fg-muted">Last ran {new Date(stats.lastRunAt).toLocaleString()}</p>
          )}
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-caption font-medium text-fg-secondary">{stats.enabled ? 'On' : 'Off'}</span>
            <ToggleSwitch checked={stats.enabled} onChange={() => void handleToggle()} disabled={saving} label="Business intelligence enabled" />
          </div>
        )}
      </div>
      {stats.enabled && (
        <a href="/trends" className="inline-block text-caption font-semibold text-accent hover:underline">
          View Trends →
        </a>
      )}
      {error && <p className="text-caption text-error">{error}</p>}
    </div>
  );
}
