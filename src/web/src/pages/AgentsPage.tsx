import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type AiAgentSummary } from '../lib/api.js';

const EMPTY_FORM = { name: '', persona: '', tone: '', language: '', systemInstruction: '' };

export function AgentsPage() {
  const [agents, setAgents] = useState<AiAgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function load() {
    api
      .listAgents()
      .then((res) => setAgents(res.agents))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load agents.'));
  }

  useEffect(load, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      await api.createAgent({
        name: form.name.trim(),
        persona: form.persona.trim() || undefined,
        tone: form.tone.trim() || undefined,
        language: form.language.trim() || undefined,
        systemInstruction: form.systemInstruction.trim() || undefined,
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to create agent.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-fg">AI Agents</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Real agent configurations for this business - a new inbound message on an AI_ACTIVE chat is answered by
            the most recently created ACTIVE agent below.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-dim"
        >
          {showForm ? 'Cancel' : 'New agent'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="mt-4 max-w-lg space-y-3 rounded-xl border border-border-subtle bg-surface-2 p-4">
          <div>
            <label className="text-xs font-medium text-fg-secondary" htmlFor="agent-name">
              Name *
            </label>
            <input
              id="agent-name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Reception Agent"
              className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-fg-secondary" htmlFor="agent-persona">
              Persona
            </label>
            <input
              id="agent-persona"
              value={form.persona}
              onChange={(e) => setForm({ ...form, persona: e.target.value })}
              placeholder="Friendly and concise"
              className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-fg-secondary" htmlFor="agent-tone">
                Tone
              </label>
              <input
                id="agent-tone"
                value={form.tone}
                onChange={(e) => setForm({ ...form, tone: e.target.value })}
                placeholder="warm"
                className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-fg-secondary" htmlFor="agent-language">
                Language
              </label>
              <input
                id="agent-language"
                value={form.language}
                onChange={(e) => setForm({ ...form, language: e.target.value })}
                placeholder="English"
                className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-fg-secondary" htmlFor="agent-instruction">
              System instruction
            </label>
            <textarea
              id="agent-instruction"
              rows={3}
              value={form.systemInstruction}
              onChange={(e) => setForm({ ...form, systemInstruction: e.target.value })}
              placeholder="Help qualify inbound leads. Never quote prices you aren't sure of."
              className="mt-1 w-full resize-none rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            />
          </div>
          {formError && <p className="text-xs text-error">{formError}</p>}
          <button
            type="submit"
            disabled={saving || !form.name.trim()}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            {saving ? 'Creating…' : 'Create agent'}
          </button>
        </form>
      )}

      {error && <p className="mt-4 text-xs text-error">{error}</p>}
      {agents && agents.length === 0 && !showForm && (
        <p className="mt-6 text-sm text-fg-muted">No AI agents created yet. Click "New agent" to create one.</p>
      )}

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {agents?.map((agent) => (
          <div key={agent.id} className="rounded-xl border border-border-subtle bg-surface-2 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-fg">{agent.name}</p>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  agent.status === 'ACTIVE'
                    ? 'bg-accent-soft text-accent'
                    : agent.status === 'PAUSED'
                      ? 'bg-warning/15 text-warning'
                      : 'bg-fg-muted/15 text-fg-muted'
                }`}
              >
                {agent.status}
              </span>
            </div>
            <p className="mt-2 text-xs text-fg-muted">{agent.persona ?? 'No persona set.'}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
