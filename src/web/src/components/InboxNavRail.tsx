import { useNavigate } from 'react-router-dom';
import { MessageCircle, Phone, ListChecks } from 'lucide-react';

export type InboxView = 'chats' | 'calls';

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
  const navigate = useNavigate();
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
        Chats/Calls. Red, deliberately distinct from Chats/Calls' own
        accent color, signals "this mirrors a genuine WhatsApp feature"
        rather than something AURA invented. Opens List management
        (ListsRoute.tsx) directly; the actual per-chat filtering by List
        lives as pills inside ChatListPane.tsx's own filter bar.
      */}
      <button
        type="button"
        onClick={() => navigate('/lists')}
        title="Lists"
        className="flex h-10 w-10 items-center justify-center rounded-lg text-red-500 transition-colors hover:bg-red-500/10"
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
