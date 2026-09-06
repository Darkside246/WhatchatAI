import { MessageCircle, Phone, ListChecks } from 'lucide-react';

export type InboxView = 'chats' | 'calls' | 'lists';

interface Props {
  view: InboxView;
  onChange: (view: InboxView) => void;
}

/**
 * A slim WhatsApp-style sub-nav scoped to the Inbox pane only - it switches
 * between real data views (Chats, Calls) inside the workspace. Status has no
 * tab of its own here - it's a persistent column inside the Chats view
 * (see ChatsRoute.tsx's StatusesPanel), not a separate destination, since a
 * standalone tab for it was redundant once that column existed. This is
 * intentionally separate from SaasNavRail (the app-wide product nav for
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
      {/*
        Lists (real WhatsApp's own native chat-organizing feature) moved
        here from the general SaaS product nav (SaasNavRail) - it's a
        WhatsApp-native concept, not an AURA "module", so it belongs beside
        Chats/Calls. Uses the same accent color as Chats/Calls, matching
        the rest of this rail's theme. Real, confirmed bug fixed here: this
        used to navigate('/lists'), a full page away from the Inbox -
        every icon on this rail and in the header vanished along with the
        whole 3-pane chat layout, reading as "the interface broke" rather
        than "Lists opened." Switches this rail's own view instead, same
        as Chats/Calls, so List management renders in place - matches the
        directive's own explicit intent (a WhatsApp-native panel, not a
        separate settings page). The actual per-chat filtering by List
        still lives as pills inside ChatListPane.tsx's own filter bar.
      */}
      <button
        type="button"
        onClick={() => onChange('lists')}
        title="Lists"
        className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
          view === 'lists' ? 'bg-accent-soft text-accent' : 'text-accent hover:bg-accent-soft'
        }`}
      >
        <ListChecks size={19} strokeWidth={1.75} aria-hidden />
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
    </nav>
  );
}
