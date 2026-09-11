import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Lock, MessageSquare, Trash2, RefreshCw, ShieldCheck, PenLine } from 'lucide-react';
import { api, ApiError, type HandoffLogEntryDto, type WritingSampleDto } from '../lib/api.js';
import { hashPin } from '../lib/pinCrypto.js';

/**
 * Plain-English text for each takeover reason. Mirrors
 * HANDOFF_REASON_LABELS in humanHandoffLogRepository.ts - the server stores
 * a short token to keep the log small, and this is where it becomes
 * readable.
 */
const REASON_LABELS: Record<string, string> = {
  no_agent: 'No AI agent matched this message',
  blocked_keyword: 'A blocked keyword matched',
  ai_unavailable: 'The AI was unavailable',
  output_leak_blocked: 'Reply withheld by the outbound leak guard',
  ai_to_ai_loop_prevented: 'Other side is another AI account — loop prevented',
  manual_reply_detected: 'A person replied from the phone',
  operator_pause: 'The operator paused the AI',
};

const REASON_TONE: Record<string, string> = {
  blocked_keyword: 'bg-warning/15 text-warning',
  output_leak_blocked: 'bg-error/15 text-error',
  ai_unavailable: 'bg-error/15 text-error',
  ai_to_ai_loop_prevented: 'bg-warning/15 text-warning',
};

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The real record behind "N messages needed a human".
 *
 * Deliberately a LOG, not a jump into a conversation: the operator's
 * question here is "what happened, to whom, and why did the AI stop" across
 * many chats at once. Each row still links to its conversation for when
 * they do want to go there.
 *
 * Every entry holds real customer identity and real message content, so the
 * page is gated behind the app-lock PIN. The gate is enforced server-side
 * on every request (see requireAppLock) - this screen is the way in, not
 * the protection itself, so hiding it would not be security.
 */
export function HandoffLogPage() {
  const navigate = useNavigate();
  const [pin, setPin] = useState('');
  const [pinHash, setPinHash] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);

  /** The log section has two distinct categories - they answer different questions and are deliberately not mixed together. */
  const [category, setCategory] = useState<'handoff' | 'writing'>('handoff');
  const [samples, setSamples] = useState<Array<{ scope: string; examples: WritingSampleDto[] }>>([]);
  const [entries, setEntries] = useState<HandoffLogEntryDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const load = useCallback(async (hash: string) => {
    setLoading(true);
    try {
      const result = await api.listHandoffLog(hash);
      setEntries(result.entries);
      setTotal(result.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the handoff log.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSamples = useCallback(async (hash: string) => {
    setLoading(true);
    try {
      const result = await api.listWritingSamples(hash);
      setSamples(result.scopes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the writing samples.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!pinHash) return;
    if (category === 'handoff') void load(pinHash);
    else void loadSamples(pinHash);
  }, [pinHash, category, load, loadSamples]);

  async function handleUnlock() {
    if (pin.trim().length === 0 || unlocking) return;
    setUnlocking(true);
    setLockError(null);
    try {
      // The same Argon2id derivation the lock screen uses, against the
      // server's own stored salt/params - the raw PIN never leaves this
      // device.
      const challenge = await api.getUnlockChallenge();
      const hash = await hashPin(pin, challenge.salt, challenge.argon2Params);
      // Proven by actually fetching: if the server rejects the hash, the
      // request fails and we never show an "unlocked" screen with no data
      // behind it.
      const result = await api.listHandoffLog(hash);
      setEntries(result.entries);
      setTotal(result.total);
      setPinHash(hash);
      setPin('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) {
        setLockError('This app lock has been revoked after too many failed attempts. Reset it in Settings.');
      } else if (err instanceof ApiError && err.status === 409) {
        setLockError('No app lock PIN has been set up yet. Set one in Settings before opening this log.');
      } else if (err instanceof ApiError && err.status === 401) {
        setLockError('That PIN was not correct.');
      } else {
        setLockError(err instanceof Error ? err.message : 'Could not unlock the log.');
      }
    } finally {
      setUnlocking(false);
    }
  }

  async function handleDelete(id: string) {
    if (!pinHash) return;
    const previous = entries;
    setEntries((current) => current.filter((entry) => entry.id !== id));
    setTotal((current) => Math.max(0, current - 1));
    try {
      await api.deleteHandoffLogEntry(pinHash, id);
    } catch (err) {
      setEntries(previous);
      setError(err instanceof Error ? err.message : 'Could not delete that entry.');
    }
  }

  async function handleClear() {
    if (!pinHash) return;
    try {
      await api.clearHandoffLog(pinHash);
      setEntries([]);
      setTotal(0);
      setConfirmingClear(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear the log.');
    }
  }

  if (!pinHash) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-surface-0 px-4">
        <div className="w-full max-w-sm rounded-xl border border-border-subtle bg-surface-1 p-6">
          <div className="flex items-center gap-2 text-fg">
            <Lock size={18} strokeWidth={1.75} aria-hidden />
            <h1 className="text-title font-semibold">Handoff log</h1>
          </div>
          <p className="mt-2 text-caption leading-5 text-fg-secondary">
            This log contains real customer names, numbers and message content. Enter your app lock PIN to open it.
          </p>

          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleUnlock();
            }}
            placeholder="App lock PIN"
            className="mt-4 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg outline-none focus:border-accent"
          />

          {lockError && <p className="mt-2 text-caption text-error">{lockError}</p>}

          <button
            type="button"
            onClick={() => void handleUnlock()}
            disabled={unlocking || pin.trim().length === 0}
            className="mt-3 w-full rounded-lg bg-accent px-3 py-2 text-body font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {unlocking ? 'Checking…' : 'Unlock'}
          </button>

          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="mt-2 w-full rounded-lg px-3 py-2 text-caption text-fg-secondary hover:text-fg"
          >
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface-0">
      <div className="flex items-center gap-3 border-b border-border-subtle bg-surface-1 px-4 py-3">
        <button type="button" onClick={() => navigate('/dashboard')} className="text-fg-secondary hover:text-fg" aria-label="Back">
          <ArrowLeft size={18} strokeWidth={1.75} aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-title font-semibold text-fg">Handoff log</h1>
          <p className="text-meta text-fg-muted">
            {category === 'handoff'
              ? `${total} recorded handover${total !== 1 ? 's' : ''} — every time a conversation left the AI`
              : 'What the Writing Twin has learned from how you write'}
          </p>
        </div>
        <span className="hidden items-center gap-1 rounded-full bg-success/15 px-2 py-1 text-meta font-medium text-success sm:inline-flex">
          <ShieldCheck size={11} aria-hidden />
          Encrypted
        </span>
        <button
          type="button"
          onClick={() => {
            if (!pinHash) return;
            if (category === 'handoff') void load(pinHash);
            else void loadSamples(pinHash);
          }}
          disabled={loading}
          className="text-fg-secondary hover:text-fg disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw size={16} strokeWidth={1.75} className={loading ? 'animate-spin' : ''} aria-hidden />
        </button>
        {category === 'handoff' && entries.length > 0 && (
          <button
            type="button"
            onClick={() => setConfirmingClear(true)}
            className="rounded-lg border border-border-subtle px-2.5 py-1.5 text-caption font-medium text-error hover:bg-error/10"
          >
            Clear log
          </button>
        )}
      </div>

      {confirmingClear && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle bg-error/10 px-4 py-3">
          <AlertTriangle size={16} className="text-error" aria-hidden />
          <p className="flex-1 text-caption text-fg">
            Permanently delete all {total} entries? The conversations themselves are not affected, but this audit record cannot be
            recovered.
          </p>
          <button type="button" onClick={() => void handleClear()} className="rounded-lg bg-error px-3 py-1.5 text-caption font-medium text-white">
            Delete everything
          </button>
          <button type="button" onClick={() => setConfirmingClear(false)} className="text-caption text-fg-secondary hover:text-fg">
            Cancel
          </button>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle bg-surface-1 px-4 pb-2">
        {([
          { id: 'handoff' as const, label: 'Handoff log', icon: MessageSquare },
          { id: 'writing' as const, label: 'Writing samples', icon: PenLine },
        ]).map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setCategory(tab.id)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-caption font-medium transition ${
                category === tab.id ? 'bg-accent text-white' : 'text-fg-secondary hover:bg-surface-3'
              }`}
            >
              <Icon size={12} aria-hidden />
              {tab.label}
            </button>
          );
        })}
      </div>

      {category === 'writing' && (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {error && <p className="mb-3 text-caption text-error">{error}</p>}
          <p className="mb-3 text-caption text-fg-secondary">
            Excerpts of your own real messages that the Writing Twin has learned your style from. These are yours alone - a
            teammate never sees them - and deleting one genuinely removes it.
          </p>
          {samples.every((scope) => scope.examples.length === 0) && !loading && (
            <p className="text-caption text-fg-muted">
              Nothing learned yet. Samples appear here once writing learning is enabled and you have sent messages it could
              learn from.
            </p>
          )}
          {samples.map((scope) =>
            scope.examples.length === 0 ? null : (
              <div key={scope.scope} className="mb-4">
                <p className="mb-1.5 text-meta font-semibold uppercase tracking-wide text-fg-muted">
                  {scope.scope} · {scope.examples.length}
                </p>
                <ul className="space-y-2">
                  {scope.examples.map((example) => (
                    <li key={example.id} className="rounded-xl border border-border-subtle bg-surface-1 p-3">
                      <p className="whitespace-pre-wrap break-words text-caption leading-5 text-fg">{example.exampleText}</p>
                      <div className="mt-2 flex items-center gap-3">
                        <span className="text-meta text-fg-muted">{formatTimestamp(example.addedAt)}</span>
                        <span className="text-meta text-fg-muted">{example.sourceProvenance}</span>
                        <button
                          type="button"
                          onClick={() => {
                            if (!pinHash) return;
                            const previous = samples;
                            setSamples((current) =>
                              current.map((group) => ({
                                ...group,
                                examples: group.examples.filter((item) => item.id !== example.id),
                              })),
                            );
                            api.deleteWritingSample(pinHash, example.id).catch((err: unknown) => {
                              setSamples(previous);
                              setError(err instanceof Error ? err.message : 'Could not forget that sample.');
                            });
                          }}
                          className="ml-auto inline-flex items-center gap-1 text-meta text-fg-muted hover:text-error"
                        >
                          <Trash2 size={11} aria-hidden />
                          Forget
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>
      )}

      {category === 'handoff' && (
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {error && <p className="mb-3 text-caption text-error">{error}</p>}
        {loading && entries.length === 0 && <p className="text-caption text-fg-muted">Loading the real handoff record…</p>}
        {!loading && entries.length === 0 && !error && (
          <p className="text-caption text-fg-muted">
            Nothing recorded yet. Entries appear here whenever a conversation is handed from the AI to a person.
          </p>
        )}

        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-xl border border-border-subtle bg-surface-1 p-3">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium text-fg">
                    {entry.customerLabel ?? entry.customerPhone ?? 'Unidentified contact'}
                  </p>
                  {entry.customerPhone && entry.customerLabel !== entry.customerPhone && (
                    <p className="text-meta text-fg-muted">{entry.customerPhone}</p>
                  )}
                </div>
                <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${REASON_TONE[entry.reason] ?? 'bg-surface-3 text-fg-secondary'}`}>
                  {REASON_LABELS[entry.reason] ?? entry.reason}
                </span>
              </div>

              {entry.reasonDetail && (
                <p className="mt-1.5 text-caption text-fg-secondary">
                  Detail: <span className="font-medium text-fg">{entry.reasonDetail}</span>
                </p>
              )}

              {entry.messageExcerpt && (
                <p className="mt-2 rounded-lg bg-surface-2 px-2.5 py-2 text-caption leading-5 text-fg-secondary">
                  “{entry.messageExcerpt}”
                </p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="text-meta text-fg-muted">{formatTimestamp(entry.createdAt)}</span>
                <button
                  type="button"
                  onClick={() => navigate(`/chats/${entry.chatId}`)}
                  className="inline-flex items-center gap-1 text-meta font-medium text-accent hover:underline"
                >
                  <MessageSquare size={11} aria-hidden />
                  Open conversation
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(entry.id)}
                  className="ml-auto inline-flex items-center gap-1 text-meta text-fg-muted hover:text-error"
                >
                  <Trash2 size={11} aria-hidden />
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      )}
    </div>
  );
}
