import { useEffect, useState } from 'react';
import { Cpu, AlertTriangle, PlugZap } from 'lucide-react';
import { api, ApiError, type AiEnginesDto, type AiEngineStatusDto, type GeminiTestResultDto } from '../lib/api.js';

/**
 * Honest, non-decorative engine status.
 *
 * The wording is chosen so nothing here overstates what we know:
 *  - 'configured' says a key is present, NOT that a call would succeed. We
 *    refuse to burn the operator's quota proving it on every page load.
 *  - 'available' appears only for Goose, where a real HTTP probe ran.
 * Failures show the real reason rather than a generic red dot.
 */
const STATE_TEXT: Record<AiEngineStatusDto['state'], string> = {
  configured: 'configured',
  available: 'reachable',
  unavailable: 'not reachable',
  not_configured: 'not configured',
};

function stateClass(state: AiEngineStatusDto['state']): string {
  if (state === 'available' || state === 'configured') return 'bg-success';
  if (state === 'unavailable') return 'bg-warning';
  return 'bg-fg-muted/40';
}

export function AiEngineStrip() {
  const [status, setStatus] = useState<AiEnginesDto | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<GeminiTestResultDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getAiEngines()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      // A failed status read must not itself claim anything about the
      // engines, so we simply render nothing rather than a misleading state.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleTestGemini() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testGeminiConnection());
    } catch (err) {
      setTestResult({ status: 'failed', reason: err instanceof ApiError ? err.message : 'Could not run the test.' });
    } finally {
      setTesting(false);
    }
  }

  if (!status) return null;

  const geminiConfigured = status.engines.some((engine) => engine.id === 'gemini' && engine.state === 'configured');

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="flex items-center gap-1.5 text-meta font-semibold uppercase tracking-wide text-fg-muted">
          <Cpu size={12} aria-hidden />
          Reply engine
        </span>

        {status.engines.map((engine) => (
          <span key={engine.id} className="flex items-center gap-1.5 text-caption text-fg-secondary">
            <span className={`h-2 w-2 shrink-0 rounded-full ${stateClass(engine.state)}`} aria-hidden />
            <span className="font-medium text-fg">{engine.label}</span>
            <span className="text-fg-muted">
              {engine.role === 'primary' ? 'primary' : 'failover'} · {STATE_TEXT[engine.state]}
            </span>
          </span>
        ))}

        {geminiConfigured && (
          <button
            type="button"
            onClick={() => void handleTestGemini()}
            disabled={testing}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-2 py-1 text-meta font-medium text-fg-secondary hover:border-accent hover:text-accent disabled:opacity-50"
          >
            <PlugZap size={11} aria-hidden />
            {testing ? 'Testing…' : 'Test Gemini connection'}
          </button>
        )}

        {!status.canGenerate && (
          <span className="flex items-center gap-1.5 text-caption font-medium text-warning">
            <AlertTriangle size={12} aria-hidden />
            No engine configured — agents cannot reply until one is set up.
          </span>
        )}
      </div>

      {testResult && (
        <p className={`text-caption ${testResult.status === 'ok' ? 'text-success' : 'text-error'}`}>
          {testResult.status === 'ok'
            ? `✓ ${testResult.detail} — Gemini genuinely works, not just "configured".`
            : `✗ Real call failed: ${testResult.reason}`}
        </p>
      )}
    </div>
  );
}
