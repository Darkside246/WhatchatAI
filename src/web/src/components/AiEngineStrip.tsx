import { useEffect, useState } from 'react';
import { Cpu, AlertTriangle, PlugZap, Power } from 'lucide-react';
import { api, ApiError, type AiEnginesDto } from '../lib/api.js';

const DISABLED_KEY = (id: string) => `ai_engine_${id}_disabled`;

function loadDisabled(id: string): boolean {
  try { return localStorage.getItem(DISABLED_KEY(id)) === '1'; } catch { return false; }
}
function saveDisabled(id: string, val: boolean) {
  try { val ? localStorage.setItem(DISABLED_KEY(id), '1') : localStorage.removeItem(DISABLED_KEY(id)); } catch {}
}

type TestResult = { status: 'ok' | 'failed'; detail?: string; reason?: string };

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium ${ok ? 'bg-success/15 text-success' : 'bg-fg-muted/15 text-fg-muted'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-success' : 'bg-fg-muted/60'}`} aria-hidden />
      {label}
    </span>
  );
}

export function AiEngineStrip() {
  const [status, setStatus] = useState<AiEnginesDto | null>(null);
  const [disabled, setDisabled] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, TestResult>>({});

  useEffect(() => {
    let cancelled = false;
    api.getAiEngines().then((result) => {
      if (cancelled) return;
      setStatus(result);
      const initial: Record<string, boolean> = {};
      for (const e of result.engines) initial[e.id] = loadDisabled(e.id);
      setDisabled(initial);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  function toggle(id: string) {
    setDisabled((prev) => {
      const nextVal = !prev[id];
      saveDisabled(id, nextVal);
      return { ...prev, [id]: nextVal };
    });
  }

  async function testEngine(id: string) {
    setTesting((p) => ({ ...p, [id]: true }));
    setResults((p) => { const n = { ...p }; delete n[id]; return n; });
    try {
      let result: TestResult;
      if (id === 'gemini') {
        const r = await api.testGeminiConnection();
        result = r.status === 'ok'
          ? { status: 'ok', detail: r.detail }
          : { status: 'failed', reason: r.reason };
      } else {
        // Goose (Section 117-122: a developer-provisioned global secret,
        // just like Gemini - never a per-business setting a business owner
        // could point at their own third-party URL) has no dedicated test
        // endpoint of its own: getAiEngineStatus already live-probes it on
        // every load (checkedBy: 'live_probe'), unlike Gemini's coarse
        // presence-only check - so "testing" Goose again is just refetching
        // that same already-live result.
        const refreshed = await api.getAiEngines();
        setStatus(refreshed);
        const engine = refreshed.engines.find((e) => e.id === id);
        result = engine?.state === 'available'
          ? { status: 'ok', detail: 'Goose answered a real health check.' }
          : { status: 'failed', reason: engine?.reason ?? 'Not reachable.' };
      }
      setResults((p) => ({ ...p, [id]: result }));
    } catch (err) {
      setResults((p) => ({ ...p, [id]: { status: 'failed', reason: err instanceof ApiError ? err.message : 'Test failed.' } }));
    } finally {
      setTesting((p) => ({ ...p, [id]: false }));
    }
  }

  if (!status) return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-meta font-semibold uppercase tracking-wide text-fg-muted">
        <Cpu size={12} aria-hidden />
        Reply engines
      </div>

      <div className="flex flex-col gap-2">
        {status.engines.map((engine) => {
          const isOff = disabled[engine.id];
          const isConnected = engine.state === 'available' || engine.state === 'configured';
          const isTesting = testing[engine.id];
          const result = results[engine.id];

          return (
            <div key={engine.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="min-w-[60px] text-caption font-medium text-fg">{engine.label}</span>
              <span className="text-meta text-fg-muted">{engine.role === 'primary' ? 'primary' : 'failover'}</span>

              {isOff ? (
                <span className="rounded-full bg-fg-muted/15 px-2 py-0.5 text-meta text-fg-muted">Disabled</span>
              ) : (
                <StatusPill ok={isConnected} label={isConnected ? 'Connected' : engine.state === 'unavailable' ? 'Not reachable' : 'Not configured'} />
              )}

              {result && (
                <span className={`text-meta ${result.status === 'ok' ? 'text-success' : 'text-error'}`}>
                  {result.status === 'ok' ? '✓ Connected' : `✗ ${result.reason ?? 'Not connected'}`}
                </span>
              )}

              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void testEngine(engine.id)}
                  disabled={isTesting || isOff}
                  className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-0.5 text-meta text-fg-secondary hover:border-accent hover:text-accent disabled:opacity-40"
                >
                  <PlugZap size={10} aria-hidden />
                  {isTesting ? 'Testing…' : 'Test'}
                </button>

                <button
                  type="button"
                  onClick={() => toggle(engine.id)}
                  title={isOff ? `Enable ${engine.label}` : `Disable ${engine.label}`}
                  className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-meta transition-colors ${
                    isOff
                      ? 'border-border-subtle text-fg-muted hover:border-accent hover:text-accent'
                      : 'border-accent/30 text-accent hover:border-error/40 hover:text-error'
                  }`}
                >
                  <Power size={10} aria-hidden />
                  {isOff ? 'Enable' : 'On'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {!status.canGenerate && (
        <div className="flex items-center gap-1.5 text-caption font-medium text-warning">
          <AlertTriangle size={12} aria-hidden />
          No engine configured — agents cannot reply until one is set up.
        </div>
      )}
    </div>
  );
}
