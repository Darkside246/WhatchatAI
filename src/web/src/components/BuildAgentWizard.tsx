import { useEffect, useState } from 'react';
import { Bot, Check, X, Loader2, ArrowLeft, Clock, Brain, Video } from 'lucide-react';
import { api, ApiError, type AgentTemplate, type AiAgentSummary } from '../lib/api.js';

/**
 * Real capability descriptions for the tool names a template can recommend
 * - never a marketing label detached from what the tool actually is.
 * connectionProvider ties a capability to a real, checkable connection
 * state (see loadConnections below) - Time awareness/Conversation memory
 * have no external connection, so they show as always available.
 */
const TOOL_INFO: Record<string, { label: string; icon: typeof Clock; connectionProvider?: 'google_meet' | 'zoom' }> = {
  get_current_time: { label: 'Time awareness', icon: Clock },
  update_conversation_memory: { label: 'Conversation memory', icon: Brain },
  schedule_google_meet: { label: 'Book Google Meet calls', icon: Video, connectionProvider: 'google_meet' },
  schedule_zoom_meeting: { label: 'Book Zoom calls', icon: Video, connectionProvider: 'zoom' },
};

export function BuildAgentWizard({ onCreated, onCancel }: { onCreated: (agent: AiAgentSummary) => void; onCancel: () => void }) {
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  const [connected, setConnected] = useState<{ google_meet: boolean; zoom: boolean } | null>(null);
  const [selected, setSelected] = useState<AgentTemplate | null>(null);
  const [name, setName] = useState('');
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listAgentTemplates().then((res) => setTemplates(res.templates)).catch(() => setTemplates([]));
    Promise.all([
      api.getMeetingConnection('google_meet').catch(() => ({ connection: null })),
      api.getMeetingConnection('zoom').catch(() => ({ connection: null })),
    ]).then(([google, zoom]) => setConnected({ google_meet: !!google.connection, zoom: !!zoom.connection }));
  }, []);

  async function handleActivate() {
    if (!selected) return;
    setActivating(true);
    setError(null);
    try {
      const res = await api.createAgentFromTemplate(selected.templateKey, name.trim() || undefined);
      onCreated(res.agent);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not activate that agent.');
    } finally {
      setActivating(false);
    }
  }

  if (!selected) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-title font-semibold text-fg">Build my agent</h1>
        <p className="mt-1 text-body text-fg-muted">Choose a starting point - you can customize everything after it's created.</p>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {templates === null && <p className="text-caption text-fg-muted">Loading…</p>}
          {templates?.map((template) => (
            <button
              key={template.templateKey}
              type="button"
              onClick={() => setSelected(template)}
              className="flex flex-col items-start gap-2 rounded-xl border border-border-subtle bg-surface-1 p-5 text-left transition-colors hover:border-accent"
            >
              <div className="flex items-center gap-2">
                <Bot size={18} className="text-accent" aria-hidden />
                <p className="text-body font-semibold text-fg">{template.role}</p>
              </div>
              <p className="text-caption text-fg-muted">{template.description}</p>
            </button>
          ))}
        </div>

        <button type="button" onClick={onCancel} className="mt-5 text-caption font-medium text-fg-muted hover:text-fg">
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <button
        type="button"
        onClick={() => setSelected(null)}
        className="mb-4 flex items-center gap-1.5 text-caption font-medium text-fg-muted hover:text-fg"
      >
        <ArrowLeft size={13} aria-hidden />
        Choose a different template
      </button>

      <div className="rounded-xl border border-border-subtle bg-surface-1 p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft">
            <Bot size={20} className="text-accent" aria-hidden />
          </div>
          <div>
            <p className="text-title font-semibold text-fg">Meet {selected.name}</p>
            <p className="text-caption text-fg-muted">{selected.role}</p>
          </div>
        </div>
        <p className="mt-3 text-body text-fg-secondary">{selected.description}</p>

        <div className="mt-5">
          <p className="text-caption font-medium text-fg-secondary">Can do</p>
          <div className="mt-2 space-y-1.5">
            {selected.recommendedTools.map((toolName) => {
              const info = TOOL_INFO[toolName];
              if (!info) return null;
              const available = !info.connectionProvider || (connected?.[info.connectionProvider] ?? false);
              const Icon = info.icon;
              return (
                <div key={toolName} className="flex items-center gap-2 text-caption">
                  <Icon size={14} className="shrink-0 text-fg-muted" aria-hidden />
                  <span className="text-fg-secondary">{info.label}</span>
                  {connected === null ? (
                    <span className="ml-auto text-meta text-fg-muted">checking…</span>
                  ) : available ? (
                    <Check size={14} className="ml-auto shrink-0 text-success" aria-hidden />
                  ) : (
                    <span className="ml-auto flex items-center gap-1 text-meta text-fg-muted">
                      <X size={12} aria-hidden />
                      not connected yet
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {connected && (connected.google_meet === false || connected.zoom === false) && (
            <p className="mt-2 text-meta text-fg-muted">
              Connect Google Meet or Zoom under Settings → Meetings any time - {selected.name} will pick it up automatically, no need to recreate the agent.
            </p>
          )}
        </div>

        <div className="mt-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-fg-secondary">Name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={selected.name}
              className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
            />
          </label>
        </div>

        {error && <p className="mt-3 text-caption text-error">{error}</p>}

        <button
          type="button"
          onClick={() => void handleActivate()}
          disabled={activating}
          className="mt-5 flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-body font-medium text-white hover:bg-accent-dim disabled:opacity-50"
        >
          {activating && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {activating ? 'Activating…' : 'Activate agent'}
        </button>
      </div>
    </div>
  );
}
