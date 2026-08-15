import { useEffect, useState } from 'react';
import { api, type AiAgentSummary } from '../lib/api.js';

export function AgentsPage() {
  const [agents, setAgents] = useState<AiAgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listAgents()
      .then((res) => setAgents(res.agents))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load agents.'));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold text-white">AI Agents</h1>
      <p className="mt-1 text-sm text-gray-500">Real agent configurations for this business.</p>

      {error && <p className="mt-4 text-xs text-red-400">{error}</p>}
      {agents && agents.length === 0 && (
        <p className="mt-6 text-sm text-gray-500">No AI agents created yet. Agent creation UI is not built yet.</p>
      )}

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {agents?.map((agent) => (
          <div key={agent.id} className="rounded-xl border border-border-subtle bg-surface-2 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-white">{agent.name}</p>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  agent.status === 'ACTIVE'
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : agent.status === 'PAUSED'
                      ? 'bg-amber-500/15 text-amber-400'
                      : 'bg-gray-500/15 text-gray-400'
                }`}
              >
                {agent.status}
              </span>
            </div>
            <p className="mt-2 text-xs text-gray-500">{agent.persona ?? 'No persona set.'}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
