import { useEffect, useState } from 'react';
import { Bot, Check, X, Loader2, ArrowLeft, Clock, Brain, Video, Building2, Sparkles } from 'lucide-react';
import { api, ApiError, type AgentTemplate, type AiAgentSummary, type ParsedAgentConfig } from '../lib/api.js';

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
  // No connectionProvider - gated server-side on the business actually
  // having property data (see hasPropertyData in aiContextGathererService.ts),
  // not an OAuth connection this wizard can check up front.
  list_properties: { label: 'List your properties', icon: Building2 },
  check_property_status: { label: 'Check property/incident status', icon: Building2 },
};

/** What the preview screen needs, whether it came from a real template or a freshly-parsed custom description. */
interface PreviewSource {
  kind: 'template' | 'custom';
  name: string;
  role: string;
  description: string;
  recommendedTools: string[];
}

export function BuildAgentWizard({ onCreated, onCancel }: { onCreated: (agent: AiAgentSummary) => void; onCancel: () => void }) {
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  const [connected, setConnected] = useState<{ google_meet: boolean; zoom: boolean } | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);
  const [customConfig, setCustomConfig] = useState<ParsedAgentConfig | null>(null);
  const [describing, setDescribing] = useState(false);
  const [description, setDescription] = useState('');
  const [parsing, setParsing] = useState(false);
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

  async function handleGenerate() {
    if (!description.trim()) return;
    setParsing(true);
    setError(null);
    try {
      const res = await api.parseAgentDescription(description.trim());
      setCustomConfig(res.config);
      setDescribing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate a configuration from that description.');
    } finally {
      setParsing(false);
    }
  }

  async function handleActivate() {
    setActivating(true);
    setError(null);
    try {
      if (selectedTemplate) {
        const res = await api.createAgentFromTemplate(selectedTemplate.templateKey, name.trim() || undefined);
        onCreated(res.agent);
      } else if (customConfig) {
        const res = await api.createAgent({
          name: name.trim() || customConfig.name,
          description: customConfig.description,
          persona: customConfig.persona,
          tone: customConfig.tone,
          systemInstruction: customConfig.systemInstruction,
          greeting: customConfig.greeting,
          category: customConfig.category,
          triggerKeywords: customConfig.triggerKeywords,
          allowedToolsEnabled: true,
          allowedTools: customConfig.recommendedTools,
        });
        onCreated(res.agent);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not activate that agent.');
    } finally {
      setActivating(false);
    }
  }

  function reset() {
    setSelectedTemplate(null);
    setCustomConfig(null);
    setDescribing(false);
    setDescription('');
    setName('');
    setError(null);
  }

  const preview: PreviewSource | null = selectedTemplate
    ? { kind: 'template', name: selectedTemplate.name, role: selectedTemplate.role, description: selectedTemplate.description, recommendedTools: selectedTemplate.recommendedTools }
    : customConfig
      ? { kind: 'custom', name: customConfig.name, role: customConfig.role, description: customConfig.description, recommendedTools: customConfig.recommendedTools }
      : null;

  // ── Screen 1: pick a template or start a custom description ──
  if (!preview && !describing) {
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
              onClick={() => setSelectedTemplate(template)}
              className="flex flex-col items-start gap-2 rounded-xl border border-border-subtle bg-surface-1 p-5 text-left transition-colors hover:border-accent"
            >
              <div className="flex items-center gap-2">
                <Bot size={18} className="text-accent" aria-hidden />
                <p className="text-body font-semibold text-fg">{template.role}</p>
              </div>
              <p className="text-caption text-fg-muted">{template.description}</p>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDescribing(true)}
            className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-border-subtle bg-surface-1 p-5 text-left transition-colors hover:border-accent"
          >
            <div className="flex items-center gap-2">
              <Sparkles size={18} className="text-accent" aria-hidden />
              <p className="text-body font-semibold text-fg">Something else</p>
            </div>
            <p className="text-caption text-fg-muted">Describe what you need in your own words - AURA builds a starting configuration from it.</p>
          </button>
        </div>

        <button type="button" onClick={onCancel} className="mt-5 text-caption font-medium text-fg-muted hover:text-fg">
          Cancel
        </button>
      </div>
    );
  }

  // ── Screen 2: describe a custom agent in free text ──
  if (describing) {
    return (
      <div className="mx-auto max-w-3xl">
        <button
          type="button"
          onClick={() => { setDescribing(false); setError(null); }}
          className="mb-4 flex items-center gap-1.5 text-caption font-medium text-fg-muted hover:text-fg"
        >
          <ArrowLeft size={13} aria-hidden />
          Choose a template instead
        </button>

        <div className="rounded-xl border border-border-subtle bg-surface-1 p-6">
          <h2 className="text-title font-semibold text-fg">What should this agent do?</h2>
          <p className="mt-1 text-caption text-fg-muted">
            Describe it like you would to a new hire. AURA will only ever offer capabilities that actually exist - if you ask for
            something not built yet, it'll say so honestly instead of pretending.
          </p>
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder='e.g. "I want an agent that handles rental maintenance requests and can book a video walkthrough with the vendor."'
            className="mt-4 w-full resize-none rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
          {error && <p className="mt-3 text-caption text-error">{error}</p>}
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={parsing || !description.trim()}
            className="mt-4 flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-body font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            {parsing && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {parsing ? 'Generating…' : 'Generate agent'}
          </button>
        </div>
      </div>
    );
  }

  if (!preview) return null;

  // ── Screen 3: preview (works for either a template or a generated custom config) ──
  return (
    <div className="mx-auto max-w-3xl">
      <button type="button" onClick={reset} className="mb-4 flex items-center gap-1.5 text-caption font-medium text-fg-muted hover:text-fg">
        <ArrowLeft size={13} aria-hidden />
        {preview.kind === 'template' ? 'Choose a different template' : 'Start over'}
      </button>

      <div className="rounded-xl border border-border-subtle bg-surface-1 p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft">
            <Bot size={20} className="text-accent" aria-hidden />
          </div>
          <div>
            <p className="text-title font-semibold text-fg">Meet {preview.name}</p>
            <p className="text-caption text-fg-muted">{preview.role}</p>
          </div>
        </div>
        <p className="mt-3 text-body text-fg-secondary">{preview.description}</p>

        <div className="mt-5">
          <p className="text-caption font-medium text-fg-secondary">Can do</p>
          <div className="mt-2 space-y-1.5">
            {preview.recommendedTools.map((toolName) => {
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
            {preview.recommendedTools.length === 0 && (
              <p className="text-meta text-fg-muted">This agent can hold a conversation, but nothing it asked for maps to a real built capability yet.</p>
            )}
          </div>
          {connected && (connected.google_meet === false || connected.zoom === false) && (
            <p className="mt-2 text-meta text-fg-muted">
              Connect Google Meet or Zoom under Settings → Meetings any time - {preview.name} will pick it up automatically, no need to recreate the agent.
            </p>
          )}
        </div>

        <div className="mt-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-fg-secondary">Name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={preview.name}
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
