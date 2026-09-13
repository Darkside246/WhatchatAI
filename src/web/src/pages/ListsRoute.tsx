import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { api, ApiError, type ListDto,
  type ListMemberDto, type ListAgentAssignmentDto, type AiAgentSummary, type ChatRelationshipSignalDto } from '../lib/api.js';
import { ToggleSwitch } from '../components/ToggleSwitch.js';
import { useAuth } from '../hooks/useAuth.js';

/**
 * AURA Lists (Phase 1): organise WhatsApp chats/contacts/groups into named
 * Lists and optionally assign a specific AI Agent to each - a List never
 * automatically grants an agent access, assignment is always explicit.
 * Follows AiAgentSettingsPanels.tsx's card conventions (rounded-xl border
 * border-border-subtle bg-surface-1 p-5, ToggleSwitch) rather than
 * inventing a new visual language.
 */

function CreateListForm({ onCreated }: { onCreated: (list: ListDto) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true); setError(null);
    try {
      const { list } = await api.createList({ name: name.trim(), description: description.trim() || null });
      onCreated(list);
      setName(''); setDescription('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create List.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-2 rounded-xl border border-border-subtle bg-surface-1 p-4">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="List name (e.g. Work, Family, Clients)"
        className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-body text-fg"
        maxLength={100}
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-caption text-fg"
        maxLength={500}
      />
      <button
        type="submit"
        disabled={saving || !name.trim()}
        className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-body font-medium text-white hover:bg-accent-dim disabled:opacity-50"
      >
        <Plus size={14} aria-hidden /> New List
      </button>
      {error && <p className="text-caption text-error">{error}</p>}
    </form>
  );
}

const AUTONOMY_LABELS: Record<number, string> = {
  1: 'Read-only',
  2: 'Manual (approval required)',
  3: 'Balanced',
  4: 'Trusted',
  5: 'Fully autonomous',
};

/**
 * Who is actually in a list.
 *
 * The membership API has always existed and nothing read it, so a list was a
 * name with an agent attached and no way to see - or correct - what it
 * applied to. An agent assigned to a list nobody can inspect is an agent
 * answering for conversations nobody knows about.
 *
 * Conversations are added from the chat list's own right-click menu, which
 * is where somebody is when they decide a conversation belongs somewhere.
 * This panel is for seeing and removing.
 */
function ListMembersPanel({ list }: { list: ListDto }) {
  const [members, setMembers] = useState<ListMemberDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    api
      .getListMembers(list.id)
      .then((res) => setMembers(res.members))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load members.'));
  }
  useEffect(load, [list.id]);

  async function remove(member: ListMemberDto) {
    setBusyId(member.id);
    try {
      await api.removeListMember(list.id, member.id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove that.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-1 p-4">
      <p className="text-caption font-semibold text-fg">In this list</p>
      {error && <p className="mt-2 text-meta text-error">{error}</p>}

      {members === null && <p className="mt-2 text-meta text-fg-muted">Loading…</p>}
      {members !== null && members.length === 0 && (
        <p className="mt-2 text-meta text-fg-muted">
          Nothing yet. Right-click a conversation in the Inbox and choose “Add to list”.
        </p>
      )}

      <ul className="mt-2 space-y-1">
        {(members ?? []).map((member) => (
          <li key={member.id} className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5">
            {/* The member's own id rather than a name: this panel does not
                have the chat list in scope, and inventing a display name it
                has not loaded would be worse than showing the real thing it
                does know. */}
            <span className="min-w-0 flex-1 truncate font-mono text-meta text-fg-secondary">
              {member.chatId ?? member.contactId ?? member.groupId ?? member.id}
            </span>
            <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-meta text-fg-muted">{member.memberType}</span>
            <button
              type="button"
              disabled={busyId === member.id}
              onClick={() => void remove(member)}
              aria-label="Remove from this list"
              className="shrink-0 rounded p-1 text-fg-muted hover:text-error disabled:opacity-40"
            >
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ListAgentAssignmentPanel({ list, agents }: { list: ListDto; agents: AiAgentSummary[] }) {
  const [assignments, setAssignments] = useState<ListAgentAssignmentDto[] | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.getListAssignments(list.id).then((res) => setAssignments(res.assignments)).catch(() => setAssignments([]));
  }
  useEffect(load, [list.id]);

  async function handleAssign() {
    if (!selectedAgentId) return;
    setSaving(true); setError(null);
    try {
      await api.upsertListAssignment(list.id, { agentId: selectedAgentId, enabled: true });
      setSelectedAgentId('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign agent.');
    } finally {
      setSaving(false);
    }
  }

  async function handlePatch(agentId: string, patch: Partial<Pick<ListAgentAssignmentDto, 'enabled' | 'useConversationHistory' | 'useLearnProfile' | 'rememberListSpecificInfo' | 'requireApproval'>>) {
    setSaving(true); setError(null);
    try {
      await api.upsertListAssignment(list.id, { agentId, ...patch });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update assignment.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(agentId: string) {
    setSaving(true); setError(null);
    try {
      await api.removeListAssignment(list.id, agentId);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove assignment.');
    } finally {
      setSaving(false);
    }
  }

  const assignedAgentIds = new Set((assignments ?? []).map((a) => a.agentId));
  const availableAgents = agents.filter((a) => !assignedAgentIds.has(a.id));

  return (
    <div className="space-y-3 rounded-xl border border-border-subtle bg-surface-1 p-5">
      <h2 className="text-body font-semibold text-fg">Assigned agents</h2>
      <p className="text-caption text-fg-muted">
        Assignment does not automatically mean autonomous sending - the agent still obeys its own permissions, safety rules, and approval requirements.
      </p>

      {assignments?.map((assignment) => {
        const agent = agents.find((a) => a.id === assignment.agentId);
        return (
          <div key={assignment.id} className="space-y-2 rounded-lg bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-caption font-semibold text-fg">{agent?.name ?? 'Unknown agent'}</span>
              <div className="flex items-center gap-2">
                <span className="text-meta text-fg-secondary">{assignment.enabled ? 'Active' : 'Disabled'}</span>
                <ToggleSwitch checked={assignment.enabled} onChange={() => void handlePatch(assignment.agentId, { enabled: !assignment.enabled })} disabled={saving} label="Assignment enabled" />
                <button type="button" onClick={() => void handleRemove(assignment.agentId)} className="rounded p-1 text-fg-muted hover:text-error" aria-label="Remove assignment">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <label className="flex items-center gap-2 text-meta text-fg-secondary">
                <input type="checkbox" checked={assignment.useConversationHistory} onChange={(e) => void handlePatch(assignment.agentId, { useConversationHistory: e.target.checked })} disabled={saving} />
                Use conversation history
              </label>
              <label className="flex items-center gap-2 text-meta text-fg-secondary">
                <input type="checkbox" checked={assignment.useLearnProfile} onChange={(e) => void handlePatch(assignment.agentId, { useLearnProfile: e.target.checked })} disabled={saving} />
                Use Learn profile
              </label>
              <label className="flex items-center gap-2 text-meta text-fg-secondary">
                <input type="checkbox" checked={assignment.rememberListSpecificInfo} onChange={(e) => void handlePatch(assignment.agentId, { rememberListSpecificInfo: e.target.checked })} disabled={saving} />
                Remember List-specific info
              </label>
              <label className="flex items-center gap-2 text-meta text-fg-secondary">
                <input type="checkbox" checked={assignment.requireApproval} onChange={(e) => void handlePatch(assignment.agentId, { requireApproval: e.target.checked })} disabled={saving} />
                Require approval before sending
              </label>
            </div>
            {assignment.autonomyOverride !== null && (
              <p className="text-meta text-fg-muted">List-restricted autonomy: {AUTONOMY_LABELS[assignment.autonomyOverride] ?? assignment.autonomyOverride}</p>
            )}
          </div>
        );
      })}

      {availableAgents.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={selectedAgentId}
            onChange={(e) => setSelectedAgentId(e.target.value)}
            className="flex-1 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-caption text-fg"
          >
            <option value="">Assign an agent…</option>
            {availableAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleAssign()}
            disabled={saving || !selectedAgentId}
            className="rounded-lg bg-accent px-3 py-2 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            Assign
          </button>
        </div>
      )}
      {error && <p className="text-caption text-error">{error}</p>}
    </div>
  );
}

/**
 * Relationship-Confidence Engine (Phase 3): the developer/admin must be
 * able to see and adjust this at all times - real, always-current
 * candidates (never a fabricated example row), a single ON/OFF toggle,
 * and real links to the actual chat and Lists involved, never abstract
 * IDs. This never auto-applies anything - "set active List" here calls
 * the exact same human-override action Lists Phase 1 already built;
 * the engine only ever pre-fills its own suggestion, always overridable.
 */
function RelationshipResolutionPanel({ lists }: { lists: ListDto[] }) {
  const auth = useAuth();
  const canEdit = auth.role === 'OWNER' || auth.role === 'ADMIN';
  const enabled = auth.business?.relationshipConfidenceEnabled ?? false;
  const [signals, setSignals] = useState<ChatRelationshipSignalDto[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [resolvingChatId, setResolvingChatId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadSignals() {
    if (!enabled) return;
    api.getRelationshipSignals().then((res) => setSignals(res.signals)).catch(() => setSignals([]));
  }
  useEffect(loadSignals, [enabled]);

  async function handleToggle() {
    setSaving(true); setError(null);
    try { await api.setRelationshipConfidenceEnabled(!enabled); await auth.refresh(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to update.'); }
    finally { setSaving(false); }
  }

  async function handleResolve(chatId: string, listId: string) {
    setResolvingChatId(chatId);
    try {
      await api.setChatActiveList(chatId, listId);
      loadSignals();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to set the active List.');
    } finally {
      setResolvingChatId(null);
    }
  }

  const listNameById = new Map(lists.map((l) => [l.id, l.name]));

  return (
    <div className="space-y-3 rounded-xl border border-border-subtle bg-surface-1 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-body font-semibold text-fg">Relationship resolution</h2>
          <p className="mt-1 max-w-lg text-caption text-fg-muted">
            When a contact belongs to more than one List, suggest which one applies to the current message - a real, deterministic keyword match against each List's own assigned agent, never a guess and never auto-applied. You can always override it below.
          </p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-caption font-medium text-fg-secondary">{enabled ? 'On' : 'Off'}</span>
            <ToggleSwitch checked={enabled} onChange={() => void handleToggle()} disabled={saving} label="Relationship-confidence suggestions enabled" />
          </div>
        )}
      </div>

      {!enabled && (
        <p className="text-caption text-fg-muted">
          Off - ambiguous chats fall back to the existing keyword+priority routing, exactly as before this existed.
        </p>
      )}

      {enabled && (
        <div className="space-y-2">
          {(signals ?? []).map((signal) => (
            <div key={signal.id} className="space-y-2 rounded-lg bg-surface-2 p-3">
              <div className="flex items-center justify-between gap-3">
                <a href={`/chats/${signal.chatId}`} className="text-caption font-semibold text-accent hover:underline">
                  Open chat →
                </a>
                <span className="text-meta text-fg-muted">Computed {new Date(signal.computedAt).toLocaleString()}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {signal.candidates.map((candidate) => (
                  <div
                    key={candidate.listId}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-meta ${
                      signal.suggestedListId === candidate.listId ? 'border-accent bg-accent-soft' : 'border-border-subtle bg-surface-1'
                    }`}
                  >
                    <span className="font-medium text-fg">{listNameById.get(candidate.listId) ?? candidate.listName}</span>
                    <span className="text-fg-muted">→ {candidate.agentName}</span>
                    <span className="text-fg-muted">({candidate.score} keyword{candidate.score === 1 ? '' : 's'})</span>
                    {candidate.lastActiveAt && (
                      <span className="text-fg-muted">· last active {new Date(candidate.lastActiveAt).toLocaleDateString()} ({candidate.engagementCount}×)</span>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => void handleResolve(signal.chatId, candidate.listId)}
                        disabled={resolvingChatId === signal.chatId}
                        className="ml-1 rounded-md bg-accent px-2 py-0.5 text-meta font-medium text-white hover:bg-accent-dim disabled:opacity-50"
                      >
                        Set active
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {signals?.length === 0 && <p className="text-caption text-fg-muted">No ambiguous chats right now.</p>}
          {signals === null && <p className="text-caption text-fg-muted">Loading…</p>}
        </div>
      )}
      {error && <p className="text-caption text-error">{error}</p>}
    </div>
  );
}

export function ListsRoute() {
  const [lists, setLists] = useState<ListDto[] | null>(null);
  const [agents, setAgents] = useState<AiAgentSummary[]>([]);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadLists() {
    api.getLists().then((res) => setLists(res.lists)).catch((err) => setError(err instanceof Error ? err.message : 'Failed to load Lists.'));
  }
  useEffect(loadLists, []);
  useEffect(() => {
    api.listAgents().then((res) => setAgents(res.agents)).catch(() => setAgents([]));
  }, []);

  async function handleRename(list: ListDto) {
    const name = window.prompt('Rename this list', list.name);
    if (name === null) return;
    const trimmed = name.trim();
    // An empty name is not a rename, and a list with no name is unusable on
    // every screen that shows one.
    if (!trimmed || trimmed === list.name) return;
    try {
      await api.updateList(list.id, { name: trimmed });
      loadLists();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rename List.');
    }
  }

  async function handleDelete(list: ListDto) {
    try {
      await api.deleteList(list.id);
      if (selectedListId === list.id) setSelectedListId(null);
      loadLists();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete List.');
    }
  }

  const selectedList = lists?.find((l) => l.id === selectedListId) ?? null;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl">
        <div>
          <h1 className="text-title font-semibold text-fg">Lists</h1>
          <p className="mt-1 text-body text-fg-muted">
            Organise your WhatsApp chats, contacts and groups into Lists, and optionally assign a specific AI Agent to each one.
          </p>
        </div>

        {error && <p className="mt-4 text-caption text-error">{error}</p>}

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
          <div className="space-y-3">
            <CreateListForm onCreated={(list) => { loadLists(); setSelectedListId(list.id); }} />
            <div className="space-y-2">
              {(lists ?? []).map((list) => (
                <button
                  key={list.id}
                  type="button"
                  onClick={() => setSelectedListId(list.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-xl border p-3 text-left ${
                    selectedListId === list.id ? 'border-accent bg-accent-soft' : 'border-border-subtle bg-surface-1 hover:border-accent'
                  }`}
                >
                  <div>
                    <p className="text-caption font-semibold text-fg">{list.name}</p>
                    {list.description && <p className="text-meta text-fg-muted">{list.description}</p>}
                  </div>
                  <span className="flex shrink-0 items-center gap-1">
                    {/* Renaming. Without it a typo meant deleting the list and
                        starting again, which threw away every chat in it and
                        whichever agent had been assigned. */}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); void handleRename(list); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void handleRename(list); } }}
                      className="rounded p-1 text-fg-muted hover:text-fg"
                      aria-label={`Rename ${list.name}`}
                    >
                      <Pencil size={13} />
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); void handleDelete(list); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void handleDelete(list); } }}
                      className="rounded p-1 text-fg-muted hover:text-error"
                      aria-label={`Delete ${list.name}`}
                    >
                      <X size={14} />
                    </span>
                  </span>
                </button>
              ))}
              {lists && lists.length === 0 && <p className="text-caption text-fg-muted">No Lists yet - create one to get started.</p>}
            </div>
          </div>

          <div>
            {selectedList ? (
              <div className="space-y-4">
                <ListAgentAssignmentPanel list={selectedList} agents={agents} />
                <ListMembersPanel list={selectedList} />
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border-subtle p-6 text-center text-caption text-fg-muted">
                Select a List to assign an AI Agent to it.
              </div>
            )}
          </div>
        </div>

        <div className="mt-4">
          <RelationshipResolutionPanel lists={lists ?? []} />
        </div>
      </div>
    </div>
  );
}
