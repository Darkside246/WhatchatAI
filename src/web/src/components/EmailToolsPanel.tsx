import { useEffect, useRef, useState } from 'react';
import { GripVertical, Search, Users, Clock, StickyNote, Sparkles, Plus, Trash2, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';

export type EmailSearchFilter = { fromContains?: string; subjectContains?: string; unreadOnly?: boolean } | null;

type CardType = 'ai_suggestions' | 'quick_actions' | 'contacts' | 'reminders' | 'notes';
const DEFAULT_ORDER: CardType[] = ['ai_suggestions', 'quick_actions', 'contacts', 'reminders', 'notes'];
const CARD_TITLES: Record<CardType, string> = {
  ai_suggestions: 'Suggestions',
  quick_actions: 'Quick actions',
  contacts: 'Contacts',
  reminders: 'Reminders',
  notes: 'Notes',
};

function CardShell({
  type,
  onDragStart,
  onDragOver,
  onDrop,
  isDragging,
  children,
}: {
  type: CardType;
  onDragStart: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: () => void;
  isDragging: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`rounded-xl border border-border-subtle bg-surface-1 p-4 transition-opacity ${isDragging ? 'opacity-40' : ''}`}
    >
      <div className="mb-2 flex cursor-grab items-center gap-1.5 text-caption font-semibold text-fg active:cursor-grabbing">
        <GripVertical size={13} className="text-fg-muted" aria-hidden />
        {CARD_TITLES[type]}
      </div>
      {children}
    </div>
  );
}

function QuickActionsCard({ onFilterChange }: { onFilterChange: (filter: EmailSearchFilter) => void }) {
  const [from, setFrom] = useState('');
  const [subject, setSubject] = useState('');

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="From a sender…"
          className="w-full rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-caption text-fg"
        />
        <button type="button" onClick={() => onFilterChange(from.trim() ? { fromContains: from.trim() } : null)} className="shrink-0 rounded-lg border border-border-subtle p-1.5 text-fg-muted hover:text-fg">
          <Search size={13} aria-hidden />
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject contains…"
          className="w-full rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-caption text-fg"
        />
        <button type="button" onClick={() => onFilterChange(subject.trim() ? { subjectContains: subject.trim() } : null)} className="shrink-0 rounded-lg border border-border-subtle p-1.5 text-fg-muted hover:text-fg">
          <Search size={13} aria-hidden />
        </button>
      </div>
      <button
        type="button"
        onClick={() => onFilterChange({ unreadOnly: true })}
        className="w-full rounded-lg border border-border-subtle px-2.5 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-2"
      >
        Unread only
      </button>
      <button type="button" onClick={() => onFilterChange(null)} className="w-full text-caption text-fg-muted hover:text-fg">
        Clear filter
      </button>
    </div>
  );
}

function ContactsCard({ onFilterChange }: { onFilterChange: (filter: EmailSearchFilter) => void }) {
  const [contacts, setContacts] = useState<{ address: string; name: string | null }[] | null>(null);

  useEffect(() => {
    api.getEmailContacts().then((res) => setContacts(res.contacts)).catch(() => setContacts([]));
  }, []);

  if (contacts === null) return <p className="text-caption text-fg-muted">Loading…</p>;
  if (contacts.length === 0) return <p className="text-caption text-fg-muted">No senders synced yet.</p>;

  return (
    <div className="space-y-1">
      {contacts.slice(0, 8).map((contact) => (
        <button
          key={contact.address}
          type="button"
          onClick={() => onFilterChange({ fromContains: contact.address })}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-caption text-fg-secondary hover:bg-surface-2"
        >
          <Users size={12} className="shrink-0 text-fg-muted" aria-hidden />
          <span className="truncate">{contact.name || contact.address}</span>
        </button>
      ))}
    </div>
  );
}

function RemindersCard() {
  const [reminders, setReminders] = useState<{ id: string; body: string; remindAt: string | null }[] | null>(null);

  useEffect(() => {
    api.getEmailReminders().then((res) => setReminders(res.reminders)).catch(() => setReminders([]));
  }, []);

  if (reminders === null) return <p className="text-caption text-fg-muted">Loading…</p>;
  if (reminders.length === 0) return <p className="text-caption text-fg-muted">Nothing upcoming - add a due date to a note to see it here.</p>;

  return (
    <div className="space-y-1.5">
      {reminders.map((reminder) => (
        <div key={reminder.id} className="flex items-start gap-2 text-caption">
          <Clock size={12} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-fg-secondary">{reminder.body}</p>
            {reminder.remindAt && <p className="text-meta text-fg-muted">{new Date(reminder.remindAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

function NotesCard({ onChange }: { onChange: () => void }) {
  const [notes, setNotes] = useState<{ id: string; body: string; remindAt: string | null }[] | null>(null);
  const [text, setText] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    api.getEmailNotes().then((res) => setNotes(res.notes)).catch(() => setNotes([]));
  }
  useEffect(load, []);

  async function handleAdd() {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await api.createEmailNote({ body: text.trim(), remindAt: remindAt ? new Date(remindAt).toISOString() : null });
      setText('');
      setRemindAt('');
      load();
      onChange();
    } catch {
      // Left as a silent failure surface only in this small card - the
      // input stays populated so the user can just retry the click.
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    await api.deleteEmailNote(id).catch(() => undefined);
    load();
    onChange();
  }

  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="Note to yourself…"
        className="w-full rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-caption text-fg"
      />
      <div className="flex items-center gap-1.5">
        <input
          type="datetime-local"
          value={remindAt}
          onChange={(e) => setRemindAt(e.target.value)}
          className="w-full rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1 text-meta text-fg"
        />
        <button type="button" onClick={() => void handleAdd()} disabled={saving || !text.trim()} className="shrink-0 rounded-lg bg-accent p-1.5 text-white disabled:opacity-50">
          <Plus size={13} aria-hidden />
        </button>
      </div>
      <div className="space-y-1">
        {notes?.map((note) => (
          <div key={note.id} className="flex items-start gap-2 rounded-lg bg-surface-2 px-2 py-1.5 text-caption">
            <StickyNote size={12} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
            <p className="min-w-0 flex-1 truncate text-fg-secondary">{note.body}</p>
            <button type="button" onClick={() => void handleDelete(note.id)} className="shrink-0 text-fg-muted hover:text-error">
              <Trash2 size={12} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AiSuggestionsCard() {
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.getEmailAiSuggestions().then((res) => setSuggestions(res.status === 'ok' ? res.suggestions : [])).catch(() => setSuggestions([]));
  }
  useEffect(load, []);

  async function handleRegenerate() {
    setRegenerating(true);
    setError(null);
    try {
      const result = await api.regenerateEmailAiSuggestions();
      if (result.status === 'ok') setSuggestions(result.suggestions);
      else setError(result.reason);
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 429 ? 'Already generated today - check back tomorrow.' : err.message) : 'Could not generate suggestions.');
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className="space-y-2">
      {suggestions === null && <p className="text-caption text-fg-muted">Loading…</p>}
      {suggestions?.length === 0 && <p className="text-caption text-fg-muted">No suggestions yet today.</p>}
      {suggestions?.map((suggestion, i) => (
        <p key={i} className="flex items-start gap-1.5 text-caption text-fg-secondary">
          <Sparkles size={12} className="mt-0.5 shrink-0 text-accent" aria-hidden />
          {suggestion}
        </p>
      ))}
      <button
        type="button"
        onClick={() => void handleRegenerate()}
        disabled={regenerating}
        className="flex items-center gap-1.5 text-meta font-medium text-accent hover:underline disabled:opacity-50"
      >
        <RefreshCw size={11} className={regenerating ? 'animate-spin' : ''} aria-hidden />
        {regenerating ? 'Generating…' : 'Generate today\'s suggestions'}
      </button>
      {error && <p className="text-meta text-warning">{error}</p>}
    </div>
  );
}

/**
 * Email Redesign Phase C/D: the right-hand rearrangeable panel - real,
 * one-click search shortcuts and a real contact list (deterministic,
 * Phase C), plus reminders/notes (backed by email_notes, migration 992)
 * and an AI daily-suggestions card (Phase D, rate-limited to once/day
 * server-side). Reordering uses plain native HTML5 drag events (no new
 * dependency - see the plan's own reasoning) and persists via the same
 * user_preferences JSONB-array mechanism navigation_order already
 * proved out, just actually used this time.
 */
export function EmailToolsPanel({ onFilterChange }: { onFilterChange?: (filter: EmailSearchFilter) => void }) {
  const [order, setOrder] = useState<CardType[]>(DEFAULT_ORDER);
  const dragIndex = useRef<number | null>(null);

  useEffect(() => {
    api.getPreferences().then((res) => {
      const stored = res.preferences.emailPanelCardOrder;
      if (stored && stored.length > 0) {
        const valid = stored.filter((c): c is CardType => DEFAULT_ORDER.includes(c as CardType));
        const missing = DEFAULT_ORDER.filter((c) => !valid.includes(c));
        setOrder([...valid, ...missing]);
      }
    }).catch(() => undefined);
  }, []);

  function persistOrder(next: CardType[]) {
    setOrder(next);
    void api.updatePreferences({ emailPanelCardOrder: next }).catch(() => undefined);
  }

  function handleDrop(targetIndex: number) {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === null || from === targetIndex) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(targetIndex, 0, moved);
    persistOrder(next);
  }

  const applyFilter = onFilterChange ?? (() => undefined);

  return (
    <div className="flex h-full w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border-subtle bg-surface-2 p-3">
      {order.map((type, index) => (
        <CardShell
          key={type}
          type={type}
          isDragging={dragIndex.current === index}
          onDragStart={() => { dragIndex.current = index; }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => handleDrop(index)}
        >
          {type === 'ai_suggestions' && <AiSuggestionsCard />}
          {type === 'quick_actions' && <QuickActionsCard onFilterChange={applyFilter} />}
          {type === 'contacts' && <ContactsCard onFilterChange={applyFilter} />}
          {type === 'reminders' && <RemindersCard />}
          {type === 'notes' && <NotesCard onChange={() => undefined} />}
        </CardShell>
      ))}
    </div>
  );
}
