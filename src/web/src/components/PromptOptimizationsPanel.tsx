import { useEffect, useState, type FormEvent } from 'react';
import { FlaskConical, Loader2, Check, X } from 'lucide-react';
import { api, ApiError, type PromptOptimizationDto } from '../lib/api.js';

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const STATUS_LABEL: Record<PromptOptimizationDto['status'], string> = {
  pending_review: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
};

const STATUS_CLASS: Record<PromptOptimizationDto['status'], string> = {
  pending_review: 'bg-warning/10 text-warning',
  approved: 'bg-success/10 text-success',
  rejected: 'bg-surface-3 text-fg-muted',
};

/**
 * Reviews and applies (or discards) the output of the separate, offline
 * DSPy prompt-optimizer (services/prompt-optimizer/ - a Python tool an
 * operator runs by hand; this app never runs it and never talks to it
 * directly). Importing an artifact here never changes this agent's live
 * behavior - only "Approve" does, by copying the optimized text into the
 * exact same system_instruction field a manual edit above would.
 */
export function PromptOptimizationsPanel({ agentId }: { agentId: string }) {
  const [optimizations, setOptimizations] = useState<PromptOptimizationDto[] | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [artifactJson, setArtifactJson] = useState('');
  const [importing, setImporting] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  async function load() {
    const result = await api.listPromptOptimizations(agentId);
    setOptimizations(result.optimizations);
  }

  useEffect(() => {
    void load().catch(() => setOptimizations([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  async function handleImport(event: FormEvent) {
    event.preventDefault();
    setImporting(true);
    setNotice(null);
    try {
      const parsed = JSON.parse(artifactJson) as {
        optimizedInstruction?: unknown;
        metricName?: unknown;
        metricScore?: unknown;
        datasetSummary?: unknown;
      };
      if (typeof parsed.optimizedInstruction !== 'string' || !parsed.optimizedInstruction.trim()) {
        throw new Error('The artifact JSON must have a non-empty "optimizedInstruction" string field.');
      }
      await api.importPromptOptimization(agentId, {
        optimizedInstruction: parsed.optimizedInstruction,
        metricName: typeof parsed.metricName === 'string' ? parsed.metricName : null,
        metricScore: typeof parsed.metricScore === 'number' ? parsed.metricScore : null,
        datasetSummary: typeof parsed.datasetSummary === 'object' && parsed.datasetSummary !== null ? (parsed.datasetSummary as Record<string, unknown>) : undefined,
      });
      setArtifactJson('');
      setImportOpen(false);
      await load();
      setNotice({ kind: 'ok', text: 'Imported for review - the agent is unaffected until you approve it below.' });
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'That did not look like a valid artifact.',
      });
    } finally {
      setImporting(false);
    }
  }

  async function handleApprove(optimization: PromptOptimizationDto) {
    if (!window.confirm('Apply this optimized instruction to the live agent now? It will replace the current system instruction.')) return;
    setDecidingId(optimization.id);
    setNotice(null);
    try {
      await api.approvePromptOptimization(agentId, optimization.id);
      await load();
      setNotice({ kind: 'ok', text: 'Applied - the live agent now uses this instruction. Reopen this agent to see it in the form above.' });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not approve that optimization.' });
    } finally {
      setDecidingId(null);
    }
  }

  async function handleReject(optimization: PromptOptimizationDto) {
    setDecidingId(optimization.id);
    setNotice(null);
    try {
      await api.rejectPromptOptimization(agentId, optimization.id);
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not reject that optimization.' });
    } finally {
      setDecidingId(null);
    }
  }

  const pending = optimizations?.filter((o) => o.status === 'pending_review') ?? [];
  const decided = optimizations?.filter((o) => o.status !== 'pending_review') ?? [];

  return (
    <section className="space-y-4 rounded-xl border border-border-subtle bg-surface-1 p-5">
      <div className="flex items-center gap-2">
        <FlaskConical size={16} className="text-accent" aria-hidden />
        <h2 className="text-body font-semibold text-fg">Prompt optimization (DSPy)</h2>
      </div>
      <p className="text-caption text-fg-muted">
        Results from the separate <code className="text-meta">services/prompt-optimizer/</code> tool - run manually against your own
        conversation data, never automatically. Importing an artifact below only queues it for review; nothing changes about how this
        agent replies until you approve it.
      </p>

      {notice ? <p className={`text-caption ${notice.kind === 'ok' ? 'text-success' : 'text-error'}`}>{notice.text}</p> : null}

      <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
        <button
          type="button"
          onClick={() => setImportOpen((open) => !open)}
          className="text-caption font-medium text-accent hover:underline"
        >
          {importOpen ? 'Cancel import' : 'Import an optimization artifact'}
        </button>
        {importOpen ? (
          <form onSubmit={handleImport} className="mt-2 space-y-2">
            <textarea
              required
              value={artifactJson}
              onChange={(event) => setArtifactJson(event.target.value)}
              placeholder='Paste the JSON the optimizer wrote, e.g. {"optimizedInstruction": "...", "metricName": "reply_quality_metric", "metricScore": 0.87, "datasetSummary": {...}}'
              rows={5}
              className="field w-full resize-y border border-border-subtle bg-surface-1 font-mono text-meta text-fg"
            />
            <button
              type="submit"
              disabled={importing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
            >
              {importing ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
              Import for review
            </button>
          </form>
        ) : null}
      </div>

      <div className="space-y-2">
        {optimizations === null ? (
          <p className="text-caption text-fg-muted">Loading...</p>
        ) : pending.length === 0 ? (
          <p className="text-caption text-fg-muted">No optimizations pending review.</p>
        ) : (
          pending.map((optimization) => (
            <div key={optimization.id} className="rounded-lg border border-warning/40 bg-warning/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${STATUS_CLASS[optimization.status]}`}>
                  {STATUS_LABEL[optimization.status]}
                </span>
                <span className="text-meta text-fg-muted">{formatWhen(optimization.createdAt)}</span>
              </div>
              {optimization.metricScore !== null ? (
                <p className="mt-1 text-meta text-fg-muted">
                  {optimization.metricName ?? 'metric'}: {optimization.metricScore.toFixed(2)}
                </p>
              ) : null}
              <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-caption text-fg">{optimization.optimizedInstruction}</p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleApprove(optimization)}
                  disabled={decidingId === optimization.id}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-success px-3 py-1.5 text-caption font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {decidingId === optimization.id ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />}
                  Approve &amp; apply
                </button>
                <button
                  type="button"
                  onClick={() => void handleReject(optimization)}
                  disabled={decidingId === optimization.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:border-error hover:text-error disabled:opacity-50"
                >
                  <X size={13} aria-hidden />
                  Reject
                </button>
              </div>
            </div>
          ))
        )}

        {decided.length > 0 ? (
          <details className="rounded-lg border border-border-subtle bg-surface-2 p-3">
            <summary className="cursor-pointer text-caption font-medium text-fg-secondary">
              {decided.length} past decision{decided.length === 1 ? '' : 's'}
            </summary>
            <div className="mt-2 space-y-2">
              {decided.map((optimization) => (
                <div key={optimization.id} className="rounded-lg border border-border-subtle bg-surface-1 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${STATUS_CLASS[optimization.status]}`}>
                      {STATUS_LABEL[optimization.status]}
                    </span>
                    <span className="text-meta text-fg-muted">
                      {optimization.reviewedAt ? formatWhen(optimization.reviewedAt) : ''}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-meta text-fg-muted">{optimization.optimizedInstruction}</p>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}
