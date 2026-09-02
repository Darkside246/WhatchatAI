import { MessageCircle, Phone, CircleDashed } from 'lucide-react';

export type InboxView = 'chats' | 'calls' | 'statuses';

interface Props {
  view: InboxView;
  onChange: (view: InboxView) => void;
}

/**
 * A slim WhatsApp-style sub-nav scoped to the Inbox pane only - it switches
 * between real data views (Chats, Calls, Status) inside the workspace. This
 * is intentionally separate from SaasNavRail (the app-wide product nav for
 * Dashboard/CRM/Billing/etc.): AURA is a SaaS platform built on top of
 * WhatsApp, not a WhatsApp Web clone, so the global nav stays as-is.
 */
export function InboxNavRail({ view, onChange }: Props) {
  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border-subtle bg-surface-1 py-3">
      <button
        type="button"
        onClick={() => onChange('chats')}
        title="Chats"
        className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
          view === 'chats' ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-2 hover:text-fg-secondary'
        }`}
      >
        <MessageCircle size={19} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => onChange('calls')}
        title="Calls"
        className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
          view === 'calls' ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-2 hover:text-fg-secondary'
        }`}
      >
        <Phone size={19} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => onChange('statuses')}
        title="Status"
        className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
          view === 'statuses' ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-2 hover:text-fg-secondary'
        }`}
      >
        <CircleDashed size={19} strokeWidth={1.75} aria-hidden />
      </button>
    </nav>
  );
}
