import { useEffect, useState, type FormEvent } from 'react';
import { Bot, ShieldAlert, Plus, ArrowLeft, Clock, GitBranch, LayoutGrid, Network, Sparkles, Lightbulb } from 'lucide-react';
import {
  api,
  ApiError,
  AGENT_CATEGORIES,
  ADVICE_RESTRICTED_CATEGORIES,
  type AiAgentSummary,
  type AgentCategory,
  type CreateAgentBody,
  type AgentTemplate,
  type ApprovalPatternSuggestion,
} from '../lib/api.js';
import { ToggleSwitch } from '../components/ToggleSwitch.js';
import { AgentCanvas } from '../components/AgentCanvas.js';
import { AiEngineStrip } from '../components/AiEngineStrip.js';
import { PromptOptimizationsPanel } from '../components/PromptOptimizationsPanel.js';
import { BuildAgentWizard } from '../components/BuildAgentWizard.js';

/** Real tool names this codebase actually registers (aiToolPolicy.ts) - never a capability toggle with nothing behind it. */
const TOGGLEABLE_TOOLS: { name: string; label: string }[] = [
  { name: 'get_current_time', label: 'Time awareness' },
  { name: 'update_conversation_memory', label: 'Conversation memory' },
  { name: 'schedule_google_meet', label: 'Book Google Meet calls' },
  { name: 'schedule_zoom_meeting', label: 'Book Zoom calls' },
  { name: 'list_properties', label: 'List properties' },
  { name: 'check_property_status', label: 'Check property/incident status' },
];

/**
 * Every level here maps to a real, distinct backend behaviour - never
 * cosmetic slider positions over one boolean. See aiReplyService.ts's
 * buildReplyTools/createPendingApprovalAction/notifyAutonomousAction and
 * agentGuard.ts's guardToolInvocation for where each is actually enforced.
 */
const AUTONOMY_LEVELS: { level: number; label: string; description: string }[] = [
  { level: 1, label: 'Read-only', description: 'This agent can answer questions but never takes a real action - no meetings booked, nothing saved to memory. Every action-tool is withheld entirely.' },
  { level: 2, label: 'Manual', description: 'Real actions (like booking a meeting) always wait for a teammate to approve in the Approvals queue before they happen.' },
  { level: 3, label: 'Balanced', description: 'This agent takes real actions immediately - the default. No approval step, no extra notification.' },
  { level: 4, label: 'Trusted', description: 'Same as Balanced - actions happen immediately - but your team gets a real notification every time this agent acts on its own, so nothing slips by unnoticed.' },
  { level: 5, label: 'Fully autonomous', description: 'This agent acts immediately with no approval step and no extra notification - full trust, no oversight overhead.' },
];

const CATEGORY_LABEL: Record<AgentCategory, string> = {
  general: 'General',
  sales: 'Sales',
  support: 'Support',
  billing: 'Billing',
  bookings: 'Bookings',
  logistics: 'Logistics',
  plumbing: 'Plumbing',
  electrical: 'Electrical',
  mechanical: 'Mechanical',
  hvac: 'HVAC',
  construction: 'Construction',
  cleaning: 'Cleaning',
  landscaping: 'Landscaping',
  it_services: 'IT services',
  beauty: 'Beauty',
  hospitality: 'Hospitality',
};

interface AgentForm {
  name: string;
  category: AgentCategory;
  specialization: string;
  description: string;
  persona: string;
  tone: string;
  language: string;
  greeting: string;
  businessContext: string;
  responseStyle: string;
  systemInstruction: string;
  humanTakeoverPolicy: string;
  triggerKeywords: string;
  blockedKeywords: string;
  protectedFacts: string;
  blockedReplyMessage: string;
  responseDelaySeconds: number;
  priority: number;
  parentAgentId: string;
  escalateToAgentId: string;
  allowedToolsEnabled: boolean;
  allowedTools: string[];
  autonomyLevel: number;
  sourceTemplateKey: string | null;
  sourceTemplateVersion: number | null;
}

const EMPTY_FORM: AgentForm = {
  name: '',
  category: 'general',
  specialization: '',
  description: '',
  persona: '',
  tone: '',
  language: '',
  greeting: '',
  businessContext: '',
  responseStyle: '',
  systemInstruction: '',
  humanTakeoverPolicy: '',
  triggerKeywords: '',
  blockedKeywords: '',
  protectedFacts: '',
  blockedReplyMessage: '',
  responseDelaySeconds: 0,
  priority: 0,
  parentAgentId: '',
  escalateToAgentId: '',
  allowedToolsEnabled: false,
  allowedTools: TOGGLEABLE_TOOLS.map((t) => t.name),
  autonomyLevel: 3,
  sourceTemplateKey: null,
  sourceTemplateVersion: null,
};

function toForm(agent: AiAgentSummary): AgentForm {
  return {
    name: agent.name,
    category: agent.category,
    specialization: agent.specialization ?? '',
    description: agent.description ?? '',
    persona: agent.persona ?? '',
    tone: agent.tone ?? '',
    language: agent.language ?? '',
    greeting: agent.greeting ?? '',
    businessContext: agent.businessContext ?? '',
    responseStyle: agent.responseStyle ?? '',
    systemInstruction: agent.systemInstruction ?? '',
    humanTakeoverPolicy: agent.humanTakeoverPolicy ?? '',
    triggerKeywords: agent.triggerKeywords.join(', '),
    blockedKeywords: agent.blockedKeywords.join(', '),
    protectedFacts: agent.protectedFacts.join(', '),
    blockedReplyMessage: agent.blockedReplyMessage ?? '',
    responseDelaySeconds: agent.responseDelaySeconds,
    priority: agent.priority,
    parentAgentId: agent.parentAgentId ?? '',
    escalateToAgentId: agent.escalateToAgentId ?? '',
    allowedToolsEnabled: agent.allowedToolsEnabled,
    allowedTools: agent.allowedToolsEnabled ? agent.allowedTools : TOGGLEABLE_TOOLS.map((t) => t.name),
    autonomyLevel: agent.autonomyLevel,
    sourceTemplateKey: agent.sourceTemplateKey,
    sourceTemplateVersion: agent.sourceTemplateVersion,
  };
}

function parseKeywords(raw: string): string[] {
  return raw
    .split(',')
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);
}

function toBody(form: AgentForm): CreateAgentBody {
  const text = (value: string) => (value.trim() ? value.trim() : null);
  return {
    name: form.name.trim(),
    category: form.category,
    specialization: text(form.specialization),
    description: text(form.description),
    persona: text(form.persona),
    tone: text(form.tone),
    language: text(form.language),
    greeting: text(form.greeting),
    businessContext: text(form.businessContext),
    responseStyle: text(form.responseStyle),
    systemInstruction: text(form.systemInstruction),
    humanTakeoverPolicy: text(form.humanTakeoverPolicy),
    triggerKeywords: parseKeywords(form.triggerKeywords),
    blockedKeywords: parseKeywords(form.blockedKeywords),
    protectedFacts: parseKeywords(form.protectedFacts),
    blockedReplyMessage: text(form.blockedReplyMessage),
    responseDelaySeconds: form.responseDelaySeconds,
    priority: form.priority,
    parentAgentId: form.parentAgentId || null,
    escalateToAgentId: form.escalateToAgentId || null,
    allowedToolsEnabled: form.allowedToolsEnabled,
    allowedTools: form.allowedTools,
    autonomyLevel: form.autonomyLevel,
    sourceTemplateKey: form.sourceTemplateKey,
    sourceTemplateVersion: form.sourceTemplateVersion,
  };
}

const FIELD = 'w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none';
const LABEL = 'block text-caption font-medium text-fg-secondary';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={LABEL}>{label}</span>
      {children}
      {hint && <span className="text-meta text-fg-muted">{hint}</span>}
    </label>
  );
}

/**
 * The full agent editor. Every field here maps to a real persisted column
 * that genuinely changes behaviour - the category drives a real guardrail in
 * the reply prompt, keywords are real routing/blocking inputs, the delay is a
 * real wait before dispatch, and the hierarchy fields are real foreign keys.
 * Nothing is a decorative setting with no effect behind it.
 */
function AgentEditor({
  form,
  setForm,
  siblings,
  saving,
  error,
  submitLabel,
  onSubmit,
  onCancel,
  sourceTemplate,
}: {
  form: AgentForm;
  setForm: (form: AgentForm) => void;
  siblings: AiAgentSummary[];
  saving: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  /** The real, current system template this agent was created from, if any and if it's still loaded - null means either no source template or the template lookup hasn't resolved yet. */
  sourceTemplate?: AgentTemplate | null;
}) {
  const restricted = ADVICE_RESTRICTED_CATEGORIES.includes(form.category);

  const [testReply, setTestReply] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function handleTestReply() {
    if (!testReply.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testProtectedFacts(parseKeywords(form.protectedFacts), testReply.trim());
      setTestResult(
        result.allowed
          ? { kind: 'ok', text: result.eventType === 'ai_output_leak_check_unavailable' ? `Would be allowed through (${result.reason ?? 'check unavailable'}).` : 'Would be allowed through - no protected fact detected.' }
          : { kind: 'error', text: `Would be blocked: ${result.reason ?? 'matches a protected fact'}` },
      );
    } catch (err) {
      setTestResult({ kind: 'error', text: err instanceof ApiError ? err.message : 'The test failed.' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-3xl space-y-6">
      <section className="space-y-4 rounded-xl border border-border-subtle bg-surface-1 p-5">
        <h2 className="text-body font-semibold text-fg">Identity</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={FIELD} required />
          </Field>
          <Field label="Category">
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value as AgentCategory })}
              className={FIELD}
            >
              {AGENT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {CATEGORY_LABEL[category]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Specialization" hint="Optional refinement inside the category.">
            <input
              value={form.specialization}
              onChange={(e) => setForm({ ...form, specialization: e.target.value })}
              placeholder="e.g. emergency callouts only"
              className={FIELD}
            />
          </Field>
          <Field label="Description">
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={FIELD} />
          </Field>
        </div>

        {restricted && (
          <div className="flex gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
            <p className="text-caption text-fg-secondary">
              <span className="font-semibold text-fg">Business operations only.</span> This is a regulated or hazardous trade,
              so the agent is hard-limited server-side to bookings, quotes, job status, and scheduling. It is instructed never
              to give technical, diagnostic, safety, repair, or DIY advice, and to hand anything urgent straight to a human.
              This is enforced in the reply prompt, not just shown here.
            </p>
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-xl border border-border-subtle bg-surface-1 p-5">
        <h2 className="text-body font-semibold text-fg">Voice</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Persona">
            <input value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} className={FIELD} />
          </Field>
          <Field label="Tone">
            <input value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} className={FIELD} />
          </Field>
          <Field label="Language">
            <input value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} className={FIELD} />
          </Field>
          <Field label="Response style">
            <input value={form.responseStyle} onChange={(e) => setForm({ ...form, responseStyle: e.target.value })} className={FIELD} />
          </Field>
        </div>
        <Field label="Greeting">
          <input value={form.greeting} onChange={(e) => setForm({ ...form, greeting: e.target.value })} className={FIELD} />
        </Field>
        <Field label="Business context" hint="Real facts about the business the agent may rely on.">
          <textarea
            rows={3}
            value={form.businessContext}
            onChange={(e) => setForm({ ...form, businessContext: e.target.value })}
            className={FIELD}
          />
        </Field>
        <Field label="System instruction" hint="Appended to the generated prompt - it cannot override the safety rules above.">
          <textarea
            rows={4}
            value={form.systemInstruction}
            onChange={(e) => setForm({ ...form, systemInstruction: e.target.value })}
            className={FIELD}
          />
        </Field>
        <Field
          label="Protected facts (never disclosed)"
          hint="Comma separated - real names, school, address, or anything else this agent must never say. Unlike the fields above, this is checked automatically before every reply is sent, not just asked of the AI as an instruction."
        >
          <input
            value={form.protectedFacts}
            onChange={(e) => setForm({ ...form, protectedFacts: e.target.value })}
            placeholder="Hasani, Hachiko, The Lodge School"
            className={FIELD}
          />
        </Field>
        <Field
          label="Message when a reply is blocked"
          hint="Sent to the customer instead of a blocked reply, so the conversation doesn't just go silent. Leave blank to use the default below."
        >
          <input
            value={form.blockedReplyMessage}
            onChange={(e) => setForm({ ...form, blockedReplyMessage: e.target.value })}
            placeholder="Let me get someone from the team to help with that."
            maxLength={500}
            className={FIELD}
          />
        </Field>
        <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
          <p className="text-caption font-medium text-fg-secondary">Test a reply</p>
          <p className="mt-0.5 text-meta text-fg-muted">
            Paste a sample reply to check it against the Protected Facts list above - before saving, and before a real customer sees it.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              value={testReply}
              onChange={(e) => setTestReply(e.target.value)}
              placeholder="e.g. Nah that was Hasani on your phone!"
              className={`${FIELD} flex-1`}
            />
            <button
              type="button"
              onClick={() => void handleTestReply()}
              disabled={testing || !testReply.trim()}
              className="control-sm shrink-0 border border-border-subtle font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
            >
              {testing ? 'Checking…' : 'Check'}
            </button>
          </div>
          {testResult && (
            <p className={`mt-2 text-caption ${testResult.kind === 'ok' ? 'text-success' : 'text-error'}`}>{testResult.text}</p>
          )}
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-border-subtle bg-surface-1 p-5">
        <h2 className="text-body font-semibold text-fg">Rules &amp; routing</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Trigger keywords" hint="Comma separated. Used to pick this agent when several could handle a chat.">
            <input
              value={form.triggerKeywords}
              onChange={(e) => setForm({ ...form, triggerKeywords: e.target.value })}
              placeholder="quote, booking, appointment"
              className={FIELD}
            />
          </Field>
          <Field label="Blocked keywords" hint="A match never gets an AI reply - it escalates to a human instead.">
            <input
              value={form.blockedKeywords}
              onChange={(e) => setForm({ ...form, blockedKeywords: e.target.value })}
              placeholder="refund, legal, complaint"
              className={FIELD}
            />
          </Field>
          <Field label="Response delay (seconds)" hint="A real wait before the reply is dispatched. 0 sends immediately.">
            <input
              type="number"
              min={0}
              max={300}
              value={form.responseDelaySeconds}
              onChange={(e) => setForm({ ...form, responseDelaySeconds: Number(e.target.value) })}
              className={FIELD}
            />
          </Field>
          <Field label="Priority" hint="Higher wins when more than one agent's keywords match.">
            <input
              type="number"
              min={0}
              max={1000}
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
              className={FIELD}
            />
          </Field>
        </div>
        <Field label="Human takeover policy">
          <textarea
            rows={2}
            value={form.humanTakeoverPolicy}
            onChange={(e) => setForm({ ...form, humanTakeoverPolicy: e.target.value })}
            className={FIELD}
          />
        </Field>
      </section>

      <section className="space-y-4 rounded-xl border border-border-subtle bg-surface-1 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-body font-semibold text-fg">Capabilities</h2>
            <p className="text-caption text-fg-muted">Which real tools this agent may use - not a suggestion, actually enforced.</p>
          </div>
          <ToggleSwitch
            checked={form.allowedToolsEnabled}
            onChange={() => setForm({ ...form, allowedToolsEnabled: !form.allowedToolsEnabled })}
            label="Restrict to selected capabilities"
          />
        </div>
        <div className="space-y-2">
          {TOGGLEABLE_TOOLS.map((tool) => (
            <label
              key={tool.name}
              className={`flex items-center gap-2.5 rounded-lg border border-border-subtle px-3 py-2 text-caption ${form.allowedToolsEnabled ? 'text-fg-secondary' : 'text-fg-muted opacity-60'}`}
            >
              <input
                type="checkbox"
                disabled={!form.allowedToolsEnabled}
                checked={form.allowedTools.includes(tool.name)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    allowedTools: e.target.checked
                      ? [...form.allowedTools, tool.name]
                      : form.allowedTools.filter((name) => name !== tool.name),
                  })
                }
                className="h-4 w-4 rounded border-border-subtle accent-accent"
              />
              {tool.label}
            </label>
          ))}
        </div>
        {!form.allowedToolsEnabled && (
          <p className="text-meta text-fg-muted">Off means every capability this business has connected is available - the same as today.</p>
        )}
      </section>

      <section className="space-y-4 rounded-xl border border-border-subtle bg-surface-1 p-5">
        <div>
          <h2 className="text-body font-semibold text-fg">Autonomy</h2>
          <p className="text-caption text-fg-muted">How much this agent can do on its own before a teammate needs to step in.</p>
        </div>
        <div className="px-1">
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={form.autonomyLevel}
            onChange={(e) => setForm({ ...form, autonomyLevel: Number(e.target.value) })}
            className="w-full accent-accent"
            aria-label="Autonomy level"
          />
          <div className="mt-1.5 flex justify-between text-meta text-fg-muted">
            {AUTONOMY_LEVELS.map(({ level, label }) => (
              <span key={level} className={level === form.autonomyLevel ? 'font-semibold text-accent' : ''}>{level}</span>
            ))}
          </div>
        </div>
        {AUTONOMY_LEVELS.filter((l) => l.level === form.autonomyLevel).map((l) => (
          <div key={l.level} className="rounded-lg bg-surface-2 p-3">
            <p className="text-caption font-semibold text-fg">{l.label}</p>
            <p className="mt-1 text-meta text-fg-muted">{l.description}</p>
          </div>
        ))}
      </section>

      {form.sourceTemplateKey && (
        <section className="space-y-3 rounded-xl border border-border-subtle bg-surface-1 p-5">
          <h2 className="text-body font-semibold text-fg">Template</h2>
          {sourceTemplate ? (
            <>
              <p className="text-caption text-fg-muted">
                Built from the <strong className="text-fg">{sourceTemplate.role}</strong> template
                {form.sourceTemplateVersion !== null && form.sourceTemplateVersion < sourceTemplate.version && (
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-accent/15 px-2 py-0.5 text-meta font-medium text-accent">
                    updated since you built this agent
                  </span>
                )}
                .
              </p>
              {form.sourceTemplateVersion !== null && form.sourceTemplateVersion < sourceTemplate.version ? (
                <div>
                  <p className="text-meta text-fg-muted">
                    This won't change anything unless you save afterward - review the fields below before submitting.
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      setForm({
                        ...form,
                        persona: sourceTemplate.defaultPersona ?? form.persona,
                        tone: sourceTemplate.defaultTone ?? form.tone,
                        systemInstruction: sourceTemplate.defaultSystemInstruction,
                        greeting: sourceTemplate.defaultGreeting ?? form.greeting,
                        triggerKeywords: sourceTemplate.defaultTriggerKeywords.join(', '),
                        allowedToolsEnabled: true,
                        allowedTools: sourceTemplate.recommendedTools,
                        sourceTemplateVersion: sourceTemplate.version,
                      })
                    }
                    className="mt-2 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-caption font-medium text-fg hover:bg-surface-3"
                  >
                    Reset to template defaults
                  </button>
                </div>
              ) : (
                <p className="text-meta text-fg-muted">Up to date with the template.</p>
              )}
            </>
          ) : (
            <p className="text-caption text-fg-muted">Built from a system template that no longer exists.</p>
          )}
        </section>
      )}

      <section className="space-y-4 rounded-xl border border-border-subtle bg-surface-1 p-5">
        <h2 className="text-body font-semibold text-fg">Structure</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reports to" hint="Where this agent sits under another in your structure.">
            <select
              value={form.parentAgentId}
              onChange={(e) => setForm({ ...form, parentAgentId: e.target.value })}
              className={FIELD}
            >
              <option value="">No parent</option>
              {siblings.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Escalates to" hint="Handed the conversation when this agent cannot answer.">
            <select
              value={form.escalateToAgentId}
              onChange={(e) => setForm({ ...form, escalateToAgentId: e.target.value })}
              className={FIELD}
            >
              <option value="">No escalation agent</option>
              {siblings.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      {error && <p className="text-caption text-error">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={saving || !form.name.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-body font-medium text-white hover:bg-accent-dim disabled:opacity-50"
        >
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-body text-fg-secondary hover:text-fg">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function AgentsPage() {
  const [agents, setAgents] = useState<AiAgentSummary[] | null>(null);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [approvalSuggestions, setApprovalSuggestions] = useState<ApprovalPatternSuggestion[]>([]);
  const [dismissingApprovalFor, setDismissingApprovalFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<{ mode: 'list' } | { mode: 'wizard' } | { mode: 'new' } | { mode: 'edit'; agentId: string }>({ mode: 'list' });
  const [form, setForm] = useState<AgentForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [tab, setTab] = useState<'tiles' | 'canvas'>('tiles');

  function load() {
    api
      .listAgents()
      .then((res) => setAgents(res.agents))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load agents.'));
  }

  useEffect(load, []);
  useEffect(() => {
    api.listAgentTemplates().then((res) => setTemplates(res.templates)).catch(() => setTemplates([]));
  }, []);

  function loadApprovalSuggestions() {
    api.getApprovalPatternSuggestions().then((res) => setApprovalSuggestions(res.suggestions)).catch(() => setApprovalSuggestions([]));
  }
  useEffect(loadApprovalSuggestions, []);

  async function handleDismissApprovalRequirement(suggestion: ApprovalPatternSuggestion) {
    setDismissingApprovalFor(suggestion.agentId);
    try {
      await api.updateAgentAutonomyLevel(suggestion.agentId, 3);
      setApprovalSuggestions((current) => current.filter((s) => s.agentId !== suggestion.agentId));
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update that agent.');
    } finally {
      setDismissingApprovalFor(null);
    }
  }

  async function handleToggleStatus(agent: AiAgentSummary) {
    const nextStatus = agent.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    setTogglingId(agent.id);
    setError(null);
    try {
      const res = await api.updateAgentStatus(agent.id, nextStatus);
      setAgents((current) => current?.map((a) => (a.id === agent.id ? res.agent : a)) ?? current);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update agent status.');
    } finally {
      setTogglingId(null);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      if (view.mode === 'edit') {
        await api.updateAgent(view.agentId, toBody(form));
      } else {
        await api.createAgent(toBody(form));
      }
      setView({ mode: 'list' });
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not save that agent.');
    } finally {
      setSaving(false);
    }
  }

  if (view.mode === 'wizard') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <BuildAgentWizard
          onCreated={() => {
            setView({ mode: 'list' });
            load();
          }}
          onCancel={() => setView({ mode: 'list' })}
        />
      </div>
    );
  }

  if (view.mode !== 'list') {
    const editing = view.mode === 'edit' ? agents?.find((agent) => agent.id === view.agentId) : undefined;
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <button
          type="button"
          onClick={() => setView({ mode: 'list' })}
          className="mb-4 flex items-center gap-1.5 text-caption font-medium text-fg-muted hover:text-fg"
        >
          <ArrowLeft size={13} aria-hidden />
          Back to agents
        </button>
        <h1 className="mx-auto mb-5 max-w-3xl text-title font-semibold text-fg">
          {view.mode === 'edit' ? `Edit ${editing?.name ?? 'agent'}` : 'New AI agent'}
        </h1>
        <AgentEditor
          form={form}
          setForm={setForm}
          siblings={(agents ?? []).filter((agent) => view.mode !== 'edit' || agent.id !== view.agentId)}
          saving={saving}
          error={formError}
          submitLabel={view.mode === 'edit' ? 'Save changes' : 'Create agent'}
          onSubmit={handleSubmit}
          onCancel={() => setView({ mode: 'list' })}
          sourceTemplate={form.sourceTemplateKey ? (templates.find((t) => t.templateKey === form.sourceTemplateKey) ?? null) : null}
        />
        {view.mode === 'edit' && (
          <div className="mx-auto mt-6 max-w-3xl">
            <PromptOptimizationsPanel agentId={view.agentId} />
          </div>
        )}
      </div>
    );
  }

  if (tab === 'canvas') {
    return (
      <div className="flex h-full flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-6 py-3">
          <h1 className="text-body-lg font-semibold text-fg">Agent structure</h1>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setTab('tiles')}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-2"
            >
              <LayoutGrid size={13} aria-hidden />
              Tiles
            </button>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-lg bg-accent-soft px-3 py-1.5 text-caption font-medium text-accent"
            >
              <Network size={13} aria-hidden />
              Canvas
            </button>
          </div>
        </div>
        <div className="shrink-0 px-6 pt-3">
          <AiEngineStrip />
        </div>
        <AgentCanvas agents={agents ?? []} onChanged={load} />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-title font-semibold text-fg">AI agents</h1>
            <p className="mt-1 text-body text-fg-muted">
              Each agent replies on WhatsApp using only real conversation and CRM data.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTab('canvas')}
              className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-body font-medium text-fg-secondary hover:border-accent hover:text-accent"
            >
              <Network size={14} aria-hidden />
              Canvas
            </button>
            <button
              type="button"
              onClick={() => {
                setForm(EMPTY_FORM);
                setFormError(null);
                setView({ mode: 'new' });
              }}
              className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-body font-medium text-fg-secondary hover:border-accent hover:text-accent"
            >
              <Plus size={14} aria-hidden />
              New agent
            </button>
            <button
              type="button"
              onClick={() => setView({ mode: 'wizard' })}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-body font-medium text-white hover:bg-accent-dim"
            >
              <Sparkles size={14} aria-hidden />
              Build my agent
            </button>
          </div>
        </div>

        <div className="mt-4">
          <AiEngineStrip />
        </div>

        {agents && agents.length > 0 && agents.every((agent) => agent.status !== 'ACTIVE' || agent.triggerKeywords.length > 0) && (
          <div className="mt-4 flex gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
            <p className="text-caption text-fg-secondary">
              <span className="font-semibold text-fg">No agent can catch everything.</span> Every active agent here has trigger
              keywords, so a message that matches none of them gets no AI reply at all - it is handed to a human instead. If you
              want one agent to answer anything else, remove its trigger keywords (or add a second agent with none).
            </p>
          </div>
        )}

        {approvalSuggestions.map((suggestion) => (
          <div key={suggestion.agentId} className="mt-4 flex items-start gap-2.5 rounded-lg border border-accent/40 bg-accent-soft p-3">
            <Lightbulb size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
            <div className="flex flex-1 flex-wrap items-center justify-between gap-2">
              <p className="text-caption text-fg-secondary">
                <span className="font-semibold text-fg">{suggestion.agentName}</span> has had its last {suggestion.approvedStreak} action
                requests approved, with none rejected. Turn off approval so it can act on its own from now on?
              </p>
              <button
                type="button"
                onClick={() => handleDismissApprovalRequirement(suggestion)}
                disabled={dismissingApprovalFor === suggestion.agentId}
                className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
              >
                {dismissingApprovalFor === suggestion.agentId ? 'Updating…' : 'Turn off approval'}
              </button>
            </div>
          </div>
        ))}

        {error && <p className="mt-4 text-caption text-error">{error}</p>}

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {agents === null && <p className="text-caption text-fg-muted">Loading…</p>}
          {agents?.length === 0 && (
            <div className="col-span-full flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-subtle p-10 text-center">
              <Bot size={22} className="text-fg-muted" aria-hidden />
              <div>
                <p className="text-body text-fg-secondary">No agents yet.</p>
                <p className="text-caption text-fg-muted">Let AURA build your first one - pick a template and it's ready in about a minute.</p>
              </div>
              <button
                type="button"
                onClick={() => setView({ mode: 'wizard' })}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-body font-medium text-white hover:bg-accent-dim"
              >
                <Sparkles size={14} aria-hidden />
                Build my agent
              </button>
            </div>
          )}
          {agents?.map((agent) => {
            const parent = agents.find((candidate) => candidate.id === agent.parentAgentId);
            return (
              <div key={agent.id} className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface-1 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-body font-semibold text-fg">{agent.name}</p>
                      <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-meta font-medium text-fg-secondary">
                        {CATEGORY_LABEL[agent.category]}
                      </span>
                    </div>
                    {agent.specialization && <p className="mt-0.5 truncate text-caption text-fg-muted">{agent.specialization}</p>}
                  </div>
                  <ToggleSwitch
                    checked={agent.status === 'ACTIVE'}
                    disabled={togglingId === agent.id}
                    onChange={() => void handleToggleStatus(agent)}
                    label={agent.status === 'ACTIVE' ? 'Active' : 'Paused'}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-fg-muted">
                  {ADVICE_RESTRICTED_CATEGORIES.includes(agent.category) && (
                    <span className="flex items-center gap-1 text-warning">
                      <ShieldAlert size={11} aria-hidden />
                      Operations only
                    </span>
                  )}
                  {agent.responseDelaySeconds > 0 && (
                    <span className="flex items-center gap-1">
                      <Clock size={11} aria-hidden />
                      {agent.responseDelaySeconds}s delay
                    </span>
                  )}
                  {parent && (
                    <span className="flex items-center gap-1">
                      <GitBranch size={11} aria-hidden />
                      Reports to {parent.name}
                    </span>
                  )}
                  {agent.triggerKeywords.length > 0 && <span>{agent.triggerKeywords.length} trigger keywords</span>}
                  {agent.blockedKeywords.length > 0 && <span>{agent.blockedKeywords.length} blocked</span>}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setForm(toForm(agent));
                    setFormError(null);
                    setView({ mode: 'edit', agentId: agent.id });
                  }}
                  className="self-start rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:border-accent hover:text-accent"
                >
                  Edit agent
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
