import { useEffect, useRef, useState } from 'react';
import { BarChart3, Camera, FileText, Headphones, Image as ImageIcon, Plus, UserRound, X } from 'lucide-react';

/**
 * The attachment menu behind the paperclip.
 *
 * Every entry here reaches a real send path - nothing is rendered that does
 * nothing when clicked. WhatsApp's own menu also lists Event and New
 * sticker; those are deliberately absent rather than shown greyed out or
 * wired to a no-op, because a menu item that cannot do its job is worse
 * than one that is not there. See the note in AttachmentMenu's own tests.
 */

export type AttachmentAction =
  | { kind: 'file'; accept: string }
  | { kind: 'camera' }
  | { kind: 'contact' }
  | { kind: 'poll' };

interface MenuEntry {
  id: string;
  label: string;
  icon: typeof FileText;
  tint: string;
  action: AttachmentAction;
}

/** Ordered to match WhatsApp's own menu, so the muscle memory carries over. */
const ENTRIES: MenuEntry[] = [
  { id: 'document', label: 'Document', icon: FileText, tint: 'text-[#7f66ff]', action: { kind: 'file', accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,application/*,text/*' } },
  { id: 'media', label: 'Photos & videos', icon: ImageIcon, tint: 'text-[#007bfc]', action: { kind: 'file', accept: 'image/*,video/*' } },
  { id: 'camera', label: 'Camera', icon: Camera, tint: 'text-[#ff2e74]', action: { kind: 'camera' } },
  { id: 'audio', label: 'Audio', icon: Headphones, tint: 'text-[#ff8a00]', action: { kind: 'file', accept: 'audio/*' } },
  { id: 'contact', label: 'Contact', icon: UserRound, tint: 'text-[#009de2]', action: { kind: 'contact' } },
  { id: 'poll', label: 'Poll', icon: BarChart3, tint: 'text-[#ffb800]', action: { kind: 'poll' } },
];

export function AttachmentMenu({ disabled, onSelect }: { disabled: boolean; onSelect: (action: AttachmentAction) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title="Attach"
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-fg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
      >
        {open ? <X size={18} strokeWidth={1.75} aria-hidden /> : <Plus size={18} strokeWidth={1.75} aria-hidden />}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-2 w-56 overflow-hidden rounded-xl border border-border-subtle bg-surface-2 py-1 shadow-2xl"
        >
          {ENTRIES.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onSelect(entry.action);
                }}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-body text-fg hover:bg-surface-3"
              >
                <Icon size={18} strokeWidth={1.75} className={entry.tint} aria-hidden />
                {entry.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Composer for a shared contact card. Both fields are required because a card with neither a name nor a number is not a contact. */
export function ContactComposer({
  onCancel,
  onSend,
  sending,
}: {
  onCancel: () => void;
  onSend: (contact: { displayName: string; phoneNumber: string }) => void;
  sending: boolean;
}) {
  const [displayName, setDisplayName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const ready = displayName.trim().length > 0 && phoneNumber.trim().length > 2;

  return (
    <div className="border-t border-border-subtle bg-surface-1 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-caption font-semibold text-fg">Send a contact</p>
        <button type="button" onClick={onCancel} className="text-fg-muted hover:text-fg" aria-label="Cancel">
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Name"
          className="flex-1 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-body text-fg outline-none focus:border-accent"
        />
        <input
          value={phoneNumber}
          onChange={(event) => setPhoneNumber(event.target.value)}
          inputMode="tel"
          placeholder="Phone number"
          className="flex-1 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-body text-fg outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={!ready || sending}
          onClick={() => onSend({ displayName: displayName.trim(), phoneNumber: phoneNumber.trim() })}
          className="rounded-lg bg-accent px-3 py-1.5 text-body font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

/** Composer for a poll. Enforces WhatsApp's own 2-12 option range in the UI; the server enforces it again. */
export function PollComposer({
  onCancel,
  onSend,
  sending,
}: {
  onCancel: () => void;
  onSend: (poll: { question: string; options: string[]; selectableCount: number }) => void;
  sending: boolean;
}) {
  const MAX_OPTIONS = 12;
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multiSelect, setMultiSelect] = useState(false);

  const filled = options.map((option) => option.trim()).filter((option) => option.length > 0);
  const ready = question.trim().length > 0 && filled.length >= 2;

  function setOption(index: number, value: string) {
    setOptions((current) => current.map((option, position) => (position === index ? value : option)));
  }

  return (
    <div className="border-t border-border-subtle bg-surface-1 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-caption font-semibold text-fg">Create a poll</p>
        <button type="button" onClick={onCancel} className="text-fg-muted hover:text-fg" aria-label="Cancel">
          <X size={14} aria-hidden />
        </button>
      </div>

      <input
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        placeholder="Ask a question"
        className="w-full rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-body text-fg outline-none focus:border-accent"
      />

      <div className="mt-2 space-y-1.5">
        {options.map((option, index) => (
          <input
            key={index}
            value={option}
            onChange={(event) => setOption(index, event.target.value)}
            placeholder={`Option ${index + 1}`}
            className="w-full rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-body text-fg outline-none focus:border-accent"
          />
        ))}
      </div>

      {options.length < MAX_OPTIONS && (
        <button
          type="button"
          onClick={() => setOptions((current) => [...current, ''])}
          className="mt-1.5 text-caption font-medium text-accent hover:underline"
        >
          Add option
        </button>
      )}

      <label className="mt-2 flex items-center gap-2 text-caption text-fg-secondary">
        <input type="checkbox" checked={multiSelect} onChange={(event) => setMultiSelect(event.target.checked)} />
        Allow more than one answer
      </label>

      <button
        type="button"
        disabled={!ready || sending}
        onClick={() =>
          onSend({
            question: question.trim(),
            options: filled,
            // Multi-select means "any number up to all of them", which is how
            // WhatsApp itself expresses it.
            selectableCount: multiSelect ? filled.length : 1,
          })
        }
        className="mt-2 w-full rounded-lg bg-accent px-3 py-1.5 text-body font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {sending ? 'Sending…' : 'Send poll'}
      </button>
    </div>
  );
}
