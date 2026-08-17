import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, GitBranch, Plus, Trash2, Play, Pause, ArrowUp, ArrowDown, UserPlus2 } from 'lucide-react';
import {
  api,
  ApiError,
  type FunnelDto,
  type FunnelDetailDto,
  type FunnelStepDto,
  type FunnelNodeType,
  type MemberDto,
  type TeamDto,
  type EligibleRecipientDto,
} from '../lib/api.js';

const NODE_LABEL: Record<FunnelNodeType, string> = {
  MESSAGE: 'Send message',
  WAIT: 'Wait',
  CONDITION: 'Condition',
  ASSIGN_HUMAN: 'Assign to person',
  ASSIGN_TEAM: 'Assign to team',
  ADD_TAG: 'Add tag',
  REMOVE_TAG: 'Remove tag',
  UPDATE_STAGE: 'Update CRM stage',
  NOTIFY_USER: 'Notify a teammate',
};

interface EditableStep {
  nodeType: FunnelNodeType;
  config: Record<string, unknown>;
}

function StepEditorRow({
  step,
  index,
  total,
  members,
  teams,
  onChange,
  onRemove,
  onMove,
}: {
  step: EditableStep;
  index: number;
  total: number;
  members: MemberDto[];
  teams: TeamDto[];
  onChange: (step: EditableStep) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  function setConfig(key: string, value: unknown) {
    onChange({ ...step, config: { ...step.config, [key]: value } });
  }

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent">{index + 1}</span>
        <select
          value={step.nodeType}
          onChange={(event) => onChange({ nodeType: event.target.value as FunnelNodeType, config: {} })}
          className="flex-1 rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-fg outline-none focus:border-accent"
        >
          {(Object.keys(NODE_LABEL) as FunnelNodeType[]).map((type) => (
            <option key={type} value={type}>
              {NODE_LABEL[type]}
            </option>
          ))}
        </select>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            aria-label="Move step up"
            className="text-fg-muted hover:text-fg disabled:opacity-30"
          >
            <ArrowUp size={13} aria-hidden />
          </button>
          <button
            type="button"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            aria-label="Move step down"
            className="text-fg-muted hover:text-fg disabled:opacity-30"
          >
            <ArrowDown size={13} aria-hidden />
          </button>
          <button type="button" onClick={onRemove} aria-label="Remove step" className="text-fg-muted hover:text-error">
            <Trash2 size={13} aria-hidden />
          </button>
        </div>
      </div>

      <div className="mt-2 pl-7">
        {step.nodeType === 'MESSAGE' && (
          <textarea
            rows={2}
            placeholder="Message text"
            value={typeof step.config.text === 'string' ? step.config.text : ''}
            onChange={(event) => setConfig('text', event.target.value)}
            className="w-full rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-fg outline-none focus:border-accent"
          />
        )}
        {step.nodeType === 'WAIT' && (
          <label className="flex items-center gap-2 text-xs text-fg-secondary">
            Wait
            <input
              type="number"
              min={1}
              value={typeof step.config.minutes === 'number' ? step.config.minutes : ''}
              onChange={(event) => setConfig('minutes', Number(event.target.value))}
              className="w-20 rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-fg outline-none focus:border-accent"
            />
            minutes
          </label>
        )}
        {step.nodeType === 'CONDITION' && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-secondary">
            If
            <select value={typeof step.config.field === 'string' ? step.config.field : 'stage'} onChange={(event) => setConfig('field', event.target.value)} className="rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-fg">
              <option value="stage">stage</option>
              <option value="leadStatus">lead status</option>
              <option value="tag">has tag</option>
            </select>
            equals
            <input
              type="text"
              value={typeof step.config.equals === 'string' ? step.config.equals : ''}
              onChange={(event) => setConfig('equals', event.target.value)}
              className="w-28 rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-fg"
            />
            go to step
            <input
              type="number"
              min={1}
              value={typeof step.config.matchStepPosition === 'number' ? step.config.matchStepPosition + 1 : ''}
              onChange={(event) => setConfig('matchStepPosition', Number(event.target.value) - 1)}
              className="w-14 rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-fg"
            />
          </div>
        )}
        {step.nodeType === 'ASSIGN_HUMAN' && (
          <select value={typeof step.config.userId === 'string' ? step.config.userId : ''} onChange={(event) => setConfig('userId', event.target.value)} className="rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-fg">
            <option value="">Select a teammate…</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.displayName}
              </option>
            ))}
          </select>
        )}
        {step.nodeType === 'ASSIGN_TEAM' && (
          <select value={typeof step.config.teamId === 'string' ? step.config.teamId : ''} onChange={(event) => setConfig('teamId', event.target.value)} className="rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-fg">
            <option value="">Select a team…</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        )}
        {(step.nodeType === 'ADD_TAG' || step.nodeType === 'REMOVE_TAG') && (
          <input
            type="text"
            placeholder="Tag"
            value={typeof step.config.tag === 'string' ? step.config.tag : ''}
            onChange={(event) => setConfig('tag', event.target.value)}
            className="rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-fg"
          />
        )}
        {step.nodeType === 'UPDATE_STAGE' && (
          <input
            type="text"
            placeholder="New stage (e.g. qualified)"
            value={typeof step.config.stage === 'string' ? step.config.stage : ''}
            onChange={(event) => setConfig('stage', event.target.value)}
            className="rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-fg"
          />
        )}
        {step.nodeType === 'NOTIFY_USER' && (
          <div className="flex flex-wrap gap-1.5">
            <select value={typeof step.config.userId === 'string' ? step.config.userId : ''} onChange={(event) => setConfig('userId', event.target.value)} className="rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-fg">
              <option value="">Select a teammate…</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.displayName}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Notification title"
              value={typeof step.config.title === 'string' ? step.config.title : ''}
              onChange={(event) => setConfig('title', event.target.value)}
              className="flex-1 rounded-lg border border-border-subtle bg-surface-1 px-2 py-1 text-xs text-fg"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function FunnelDetailView({ funnelId, onBack }: { funnelId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<FunnelDetailDto | null>(null);
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [eligible, setEligible] = useState<EligibleRecipientDto[]>([]);
  const [editableSteps, setEditableSteps] = useState<EditableStep[] | null>(null);
  const [enrollContactId, setEnrollContactId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [detailResult, membersResult, teamsResult, eligibleResult] = await Promise.all([
        api.getFunnel(funnelId),
        api.listMembers(),
        api.listTeams(),
        api.listEligibleCampaignRecipients(),
      ]);
      setDetail(detailResult);
      setMembers(membersResult.members);
      setTeams(teamsResult.teams);
      setEligible(eligibleResult.recipients);
      setEditableSteps(detailResult.steps.map((s) => ({ nodeType: s.nodeType, config: s.config })));
    } catch {
      setError('Could not load this funnel.');
    }
  }

  useEffect(() => {
    void load();
  }, [funnelId]);

  function addStep() {
    setEditableSteps((current) => [...(current ?? []), { nodeType: 'MESSAGE', config: {} }]);
  }

  function updateStep(index: number, step: EditableStep) {
    setEditableSteps((current) => (current ?? []).map((s, i) => (i === index ? step : s)));
  }

  function removeStep(index: number) {
    setEditableSteps((current) => (current ?? []).filter((_, i) => i !== index));
  }

  function moveStep(index: number, direction: -1 | 1) {
    setEditableSteps((current) => {
      const steps = [...(current ?? [])];
      const target = index + direction;
      if (target < 0 || target >= steps.length) return steps;
      [steps[index], steps[target]] = [steps[target] as EditableStep, steps[index] as EditableStep];
      return steps;
    });
  }

  async function handleSaveSteps() {
    if (!editableSteps) return;
    setBusy(true);
    setError(null);
    try {
      await api.replaceFunnelSteps(funnelId, editableSteps);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save steps.');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleActive() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      if (detail.funnel.isActive) await api.deactivateFunnel(funnelId);
      else await api.activateFunnel(funnelId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change funnel status.');
    } finally {
      setBusy(false);
    }
  }

  async function handleEnroll(event: FormEvent) {
    event.preventDefault();
    if (!enrollContactId) return;
    setBusy(true);
    setError(null);
    try {
      await api.enrollInFunnel(funnelId, enrollContactId);
      setEnrollContactId('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not enroll that contact.');
    } finally {
      setBusy(false);
    }
  }

  if (!detail || !editableSteps) return <p className="text-xs text-fg-muted">Loading…</p>;

  return (
    <div className="mx-auto max-w-2xl">
      <button type="button" onClick={onBack} className="mb-4 flex items-center gap-1.5 text-xs font-medium text-fg-muted hover:text-fg">
        <ArrowLeft size={13} aria-hidden />
        Back to funnels
      </button>

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-fg">{detail.funnel.name}</h2>
        <button
          type="button"
          disabled={busy}
          onClick={handleToggleActive}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ${
            detail.funnel.isActive ? 'border border-border-subtle text-fg-secondary hover:bg-surface-3' : 'bg-accent text-white hover:bg-accent-dim'
          } disabled:opacity-50`}
        >
          {detail.funnel.isActive ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
          {detail.funnel.isActive ? 'Deactivate' : 'Activate'}
        </button>
      </div>
      {detail.funnel.description && <p className="mt-1 text-xs text-fg-muted">{detail.funnel.description}</p>}

      <div className="mt-4 grid grid-cols-5 gap-2">
        {(['entered', 'active', 'completed', 'failed', 'cancelled'] as const).map((key) => (
          <div key={key} className="rounded-lg border border-border-subtle bg-surface-2 p-2 text-center">
            <p className="text-lg font-semibold text-fg">{detail.counts[key]}</p>
            <p className="text-[10px] uppercase tracking-wide text-fg-muted">{key}</p>
          </div>
        ))}
      </div>

      {error && <p className="mt-3 text-xs text-error">{error}</p>}

      <h3 className="mt-6 flex items-center justify-between text-sm font-semibold text-fg">
        Steps
        <button type="button" onClick={addStep} className="flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-dim">
          <Plus size={12} aria-hidden />
          Add step
        </button>
      </h3>
      <div className="mt-2 space-y-2">
        {editableSteps.length === 0 && <p className="text-xs text-fg-muted">No steps yet - add one to get started.</p>}
        {editableSteps.map((step, index) => (
          <StepEditorRow
            key={index}
            step={step}
            index={index}
            total={editableSteps.length}
            members={members}
            teams={teams}
            onChange={(next) => updateStep(index, next)}
            onRemove={() => removeStep(index)}
            onMove={(direction) => moveStep(index, direction)}
          />
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={handleSaveSteps}
        className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-50"
      >
        Save steps
      </button>

      <h3 className="mt-6 text-sm font-semibold text-fg">Enroll a contact</h3>
      <form onSubmit={handleEnroll} className="mt-2 flex items-center gap-2">
        <select value={enrollContactId} onChange={(event) => setEnrollContactId(event.target.value)} className="flex-1 rounded-lg border border-border-subtle bg-surface-1 px-2 py-1.5 text-xs text-fg">
          <option value="">Select a contact with an existing conversation…</option>
          {eligible.map((recipient) => (
            <option key={recipient.crmContactId} value={recipient.crmContactId}>
              {recipient.displayName}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy || !enrollContactId} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dim disabled:opacity-50">
          <UserPlus2 size={13} aria-hidden />
          Enroll
        </button>
      </form>

      <h3 className="mt-6 text-sm font-semibold text-fg">Instances ({detail.instances.length})</h3>
      <div className="mt-2 rounded-lg border border-border-subtle">
        {detail.instances.length === 0 && <p className="p-3 text-xs text-fg-muted">No one enrolled yet.</p>}
        {detail.instances.map((instance) => (
          <div key={instance.id} className="flex items-center justify-between border-b border-border-subtle px-3 py-2 last:border-b-0">
            <p className="text-xs text-fg">Step {instance.currentPosition + 1}{instance.lastError ? ` · ${instance.lastError}` : ''}</p>
            <span className="text-xs font-medium text-fg-secondary">{instance.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FunnelsRoute() {
  const [searchParams] = useSearchParams();
  const initialFunnelId = searchParams.get('funnelId');
  const [funnels, setFunnels] = useState<FunnelDto[] | null>(null);
  const [view, setView] = useState<{ mode: 'list' } | { mode: 'detail'; funnelId: string }>(
    initialFunnelId ? { mode: 'detail', funnelId: initialFunnelId } : { mode: 'list' },
  );
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const result = await api.listFunnels();
      setFunnels(result.funnels);
    } catch {
      setFunnels([]);
    }
  }

  useEffect(() => {
    if (view.mode === 'list') void load();
  }, [view.mode]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const result = await api.createFunnel(name.trim(), null);
    setName('');
    setView({ mode: 'detail', funnelId: result.funnel.id });
  }

  if (view.mode === 'detail') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <FunnelDetailView funnelId={view.funnelId} onBack={() => setView({ mode: 'list' })} />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-lg font-semibold text-fg">Funnels</h1>
        <p className="mt-1 text-sm text-fg-muted">Real, ordered WhatsApp follow-up sequences - every step actually executes.</p>

        {creating ? (
          <form onSubmit={handleCreate} className="mt-4 flex items-center gap-2">
            <input
              type="text"
              autoFocus
              required
              placeholder="Funnel name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="flex-1 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            />
            <button type="submit" className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-dim">
              Create
            </button>
            <button type="button" onClick={() => setCreating(false)} className="text-sm text-fg-muted hover:text-fg">
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mt-4 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-dim"
          >
            <GitBranch size={14} aria-hidden />
            New funnel
          </button>
        )}

        <div className="mt-4 space-y-2">
          {funnels === null && <p className="text-xs text-fg-muted">Loading…</p>}
          {funnels?.length === 0 && !creating && <p className="text-xs text-fg-muted">No funnels yet.</p>}
          {funnels?.map((funnel) => (
            <button
              key={funnel.id}
              type="button"
              onClick={() => setView({ mode: 'detail', funnelId: funnel.id })}
              className="flex w-full items-center justify-between rounded-xl border border-border-subtle bg-surface-2 p-4 text-left hover:bg-surface-3"
            >
              <div>
                <p className="text-sm font-medium text-fg">{funnel.name}</p>
                <p className="mt-0.5 text-xs text-fg-muted">
                  {funnel.stepCount} steps · {funnel.counts.active} active · {funnel.counts.completed} completed
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${funnel.isActive ? 'bg-success/15 text-success' : 'bg-fg-muted/15 text-fg-muted'}`}>
                {funnel.isActive ? 'Active' : 'Inactive'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
