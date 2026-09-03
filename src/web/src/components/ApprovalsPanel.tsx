import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, ThumbsDown, ThumbsUp } from 'lucide-react';

/**
 * Section 45 (Approval Centre) of the AURA master directive: this used to
 * be a tab embedded only inside PropertyOperationsPage.tsx, even though the
 * backend (platformApprovalRouter.ts, ApprovalService) has always been
 * completely action-type-agnostic - it just happened to be the only place
 * a human could see or act on a pending action_request, and only for
 * businesses on the property vertical (the only one with that page linked
 * in the nav). A real, non-hypothetical gap this surfaced: the autonomy
 * ladder (migration 961) lets ANY vertical's agent create a real pending
 * meeting-booking approval at autonomy level 1-2 - with no way for that
 * business to ever see or act on it, since they had no route to this UI at
 * all. Extracted here so it can be used both as PropertyOperationsPage's
 * own tab (unchanged behavior there) and as a real, universally-reachable
 * /approvals page for every vertical.
 */

export type ActionRequestRec = {
  id: string;
  type: string;
  riskLevel: string;
  payload: {
    summary?: string;
    category?: string;
    urgency?: string;
    confidence?: number;
    messageText?: string;
    propertyId?: string;
    title?: string;
    startDateTimeIso?: string;
    attendeeEmail?: string;
  };
  approvalStatus: string;
  status: string;
  createdAt: string;
};

export async function platformApi<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/platform${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as { error?: string }).error ?? `Request failed (${response.status})`);
  return payload as T;
}

function fmtDatetime(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** True only for the property-maintenance triage payload shape - the one action type with a real AI-confidence/triage-feedback loop behind it today. Every other action type (e.g. meeting bookings) gets the generic copy below. */
function isMaintenanceTriage(item: ActionRequestRec): boolean {
  return typeof item.payload.messageText === 'string' && typeof item.payload.category === 'string';
}

/** A human-readable summary for any action type, not just the ones with a payload.summary field - meeting bookings, for example, carry title/startDateTimeIso instead. */
function describeAction(item: ActionRequestRec): string | null {
  const p = item.payload;
  if (p.summary) return p.summary;
  if (item.type.startsWith('meeting.') && p.title) {
    const when = p.startDateTimeIso
      ? new Date(p.startDateTimeIso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'a time to be confirmed';
    return `"${p.title}"${p.attendeeEmail ? ` with ${p.attendeeEmail}` : ''}, ${when}.`;
  }
  return null;
}

function UrgencyBadge({ label }: { label: string }) {
  const cls = label === 'EMERGENCY' ? 'bg-error/10 text-error' : label === 'PRIORITY' ? 'bg-warning/10 text-warning' : 'bg-surface-2 text-fg-muted';
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-meta font-medium ${cls}`}>{label}</span>;
}

function RiskBadge({ level }: { level: string }) {
  const cls = level === 'CRITICAL' ? 'bg-error/10 text-error' : level === 'HIGH' ? 'bg-warning/10 text-warning' : 'bg-surface-2 text-fg-muted';
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-meta font-medium ${cls}`}>{level}</span>;
}

/**
 * The real, generic Approval Centre panel: every pending platform_action_requests
 * row for this business, of any type, with approve/reject/bulk-approve wired
 * to the real ApprovalService-backed routes. No props - fetches and manages
 * everything itself, so it can be dropped into any page unchanged.
 */
export function ApprovalsPanel() {
  const [items, setItems] = useState<ActionRequestRec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [approveNote, setApproveNote] = useState<Record<string, string>>({});
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [bulkApproving, setBulkApproving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await platformApi<{ approvals: ActionRequestRec[] }>('/approvals/pending');
      setItems(data.approvals);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load pending approvals'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleApprove(id: string) {
    setBusyId(id);
    try {
      await platformApi(`/approvals/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ reason: approveNote[id] ?? undefined }),
      });
      setApprovingId(null);
      setItems((prev) => prev.filter((a) => a.id !== id));
    } catch (err) { setError(err instanceof Error ? err.message : 'Approval failed'); }
    finally { setBusyId(null); }
  }

  async function handleApproveAll() {
    setBulkApproving(true);
    try {
      const actionIds = items.map((item) => item.id);
      const data = await platformApi<{ results: Array<{ actionId: string; status: 'approved' | 'failed'; error?: string }> }>('/approvals/bulk-approve', {
        method: 'POST',
        body: JSON.stringify({ actionIds }),
      });
      const approvedIds = new Set(data.results.filter((r) => r.status === 'approved').map((r) => r.actionId));
      const failedCount = data.results.length - approvedIds.size;
      setItems((prev) => prev.filter((item) => !approvedIds.has(item.id)));
      if (failedCount > 0) setError(`${failedCount} of ${actionIds.length} could not be approved (already decided or removed) - refresh to see the current list.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk approval failed');
    } finally {
      setBulkApproving(false);
    }
  }

  async function handleReject(id: string) {
    if (!rejectReason.trim()) return;
    setBusyId(id);
    try {
      await platformApi(`/approvals/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: rejectReason.trim() }) });
      setRejectingId(null);
      setRejectReason('');
      setItems((prev) => prev.filter((a) => a.id !== id));
    } catch (err) { setError(err instanceof Error ? err.message : 'Rejection failed'); }
    finally { setBusyId(null); }
  }

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 size={24} className="animate-spin text-fg-muted" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-body font-semibold text-fg">Pending approvals</h2>
          <p className="mt-0.5 text-caption text-fg-muted">Real actions your AI agents want to take, waiting for your decision.</p>
        </div>
        <div className="flex items-center gap-2">
          {items.length > 1 && (
            <button
              type="button"
              disabled={bulkApproving}
              onClick={() => void handleApproveAll()}
              title="Approve every pending item shown here - each is approved independently, so one failure never blocks the rest."
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
            >
              {bulkApproving ? <Loader2 size={13} className="animate-spin" /> : <ThumbsUp size={13} />}
              Approve all ({items.length})
            </button>
          )}
          <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-0 px-3 py-2 text-caption text-fg hover:bg-surface-2">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-error/30 bg-error/5 p-4 text-caption text-error">{error}</div>}

      {items.length === 0 && !error && (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-fg-muted"><CheckCircle2 size={22} /></div>
          <p className="text-caption text-fg-muted">No pending approvals. When an agent needs your sign-off before acting, it will appear here.</p>
        </div>
      )}

      {items.map((item) => {
        const p = item.payload;
        const isApproving = approvingId === item.id;
        const isRejecting = rejectingId === item.id;
        const busy = busyId === item.id;
        const summary = describeAction(item);
        const triage = isMaintenanceTriage(item);

        return (
          <div key={item.id} className="rounded-xl border border-border-subtle bg-surface-1 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-caption font-semibold text-fg">{p.category ?? item.type.split('.').pop()?.toUpperCase() ?? 'ACTION'}</span>
                  {p.urgency && <UrgencyBadge label={p.urgency} />}
                  <RiskBadge level={item.riskLevel} />
                  {p.confidence != null && (
                    <span className="text-meta text-fg-muted">AI confidence: {Math.round(p.confidence * 100)}%</span>
                  )}
                </div>
                {summary && <p className="mt-2 text-caption text-fg-secondary">{summary}</p>}
                {p.messageText && p.messageText !== p.summary && (
                  <p className="mt-1 rounded-lg bg-surface-2 px-3 py-2 text-meta text-fg-muted italic">
                    &ldquo;{p.messageText.length > 300 ? `${p.messageText.slice(0, 300)}…` : p.messageText}&rdquo;
                  </p>
                )}
                <p className="mt-2 text-meta text-fg-muted">{fmtDatetime(item.createdAt)}</p>
              </div>

              {!isApproving && !isRejecting && (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { setRejectingId(item.id); setApprovingId(null); setRejectReason(''); }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-error/30 px-3 py-2 text-caption font-medium text-error hover:bg-error/8 disabled:opacity-50"
                  >
                    <ThumbsDown size={13} aria-hidden /> Reject
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { setApprovingId(item.id); setRejectingId(null); }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
                  >
                    <ThumbsUp size={13} aria-hidden /> Approve
                  </button>
                </div>
              )}
            </div>

            {isApproving && (
              <div className="mt-4 rounded-xl border border-success/20 bg-success/5 p-4">
                <p className="mb-2 text-caption font-medium text-fg">Approve this action?</p>
                <p className="mb-3 text-meta text-fg-muted">
                  {triage ? 'A work order will be created automatically. You can add an optional note.' : 'This will proceed exactly as the agent proposed. You can add an optional note.'}
                </p>
                <textarea
                  rows={2}
                  placeholder="Optional note…"
                  value={approveNote[item.id] ?? ''}
                  onChange={(e) => setApproveNote((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  className="mb-3 w-full resize-none rounded-lg border border-border-subtle bg-surface-0 px-3 py-2 text-caption text-fg outline-none focus:border-accent"
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => setApprovingId(null)} className="rounded-lg border border-border-subtle px-3 py-1.5 text-caption hover:bg-surface-2">Cancel</button>
                  <button type="button" disabled={busy} onClick={() => void handleApprove(item.id)} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50">
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <ThumbsUp size={13} />}
                    Confirm approval
                  </button>
                </div>
              </div>
            )}

            {isRejecting && (
              <div className="mt-4 rounded-xl border border-error/20 bg-error/5 p-4">
                <p className="mb-2 text-caption font-medium text-fg">Reason for rejection</p>
                <p className="mb-3 text-meta text-fg-muted">
                  {triage ? 'Your reason is saved as feedback to improve future AI triage decisions.' : 'Your reason is shown to your team and recorded on this action.'}
                </p>
                <textarea
                  rows={2}
                  placeholder="Why is this being rejected?"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  className="mb-3 w-full resize-none rounded-lg border border-border-subtle bg-surface-0 px-3 py-2 text-caption text-fg outline-none focus:border-accent"
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => { setRejectingId(null); setRejectReason(''); }} className="rounded-lg border border-border-subtle px-3 py-1.5 text-caption hover:bg-surface-2">Cancel</button>
                  <button type="button" disabled={busy || !rejectReason.trim()} onClick={() => void handleReject(item.id)} className="inline-flex items-center gap-1.5 rounded-lg bg-error px-4 py-1.5 text-caption font-medium text-white hover:opacity-90 disabled:opacity-50">
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <ThumbsDown size={13} />}
                    Confirm rejection
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
