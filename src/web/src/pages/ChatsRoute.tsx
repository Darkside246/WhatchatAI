import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Phone } from 'lucide-react';
import { ChatListPane } from '../components/ChatListPane.js';
import { ChatThread } from '../components/ChatThread.js';
import { ContactDetailPanel } from '../components/ContactDetailPanel.js';
import { InboxNavRail, type InboxView } from '../components/InboxNavRail.js';
import { CallHistoryPanel } from '../components/CallHistoryPanel.js';
import { StatusesPanel } from '../components/StatusesPanel.js';

const DETAIL_PANEL_OPEN_KEY = 'contact_detail_panel_open';

/** Hidden by default - the panel takes real horizontal space every chat had to share before, for information most messages never need. Persisted per-browser so a deliberate "keep it open" choice survives a reload. */
function getDetailPanelOpenDefault(): boolean {
  try {
    return localStorage.getItem(DETAIL_PANEL_OPEN_KEY) === 'true';
  } catch {
    return false;
  }
}

export function ChatsRoute() {
  const { chatId } = useParams<{ chatId: string }>();
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [desktopDetailOpen, setDesktopDetailOpen] = useState(getDetailPanelOpenDefault);
  const [view, setView] = useState<InboxView>('chats');

  function toggleDetailPanel() {
    // Whichever of the two renderings (inline desktop panel vs mobile
    // overlay) is actually visible for the current viewport is the one
    // this has a real effect on - the other's state change is inert since
    // its own container is hidden by the lg: breakpoint classes below.
    setDesktopDetailOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem(DETAIL_PANEL_OPEN_KEY, String(next));
      } catch {}
      return next;
    });
    setMobileDetailOpen(true);
  }

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      <InboxNavRail view={view} onChange={setView} />

      {view === 'chats' ? (
        <>
          <ChatListPane
            className={`w-full shrink-0 border-r border-border-subtle md:flex md:w-80 ${chatId ? 'hidden' : 'flex'}`}
          />

          <div className={`min-w-0 flex-1 md:flex ${chatId ? 'flex' : 'hidden'}`}>
            <ChatThread onOpenDetail={toggleDetailPanel} detailPanelOpen={desktopDetailOpen} />
          </div>

          {chatId && desktopDetailOpen && (
            <div className="hidden border-l border-border-subtle lg:block">
              <ContactDetailPanel />
            </div>
          )}

          {chatId && mobileDetailOpen && (
            <div className="fixed inset-0 z-20 flex lg:hidden">
              <div className="flex-1 bg-black/60" onClick={() => setMobileDetailOpen(false)} />
              <div className="w-80 max-w-[85vw]">
                <ContactDetailPanel onClose={() => setMobileDetailOpen(false)} />
              </div>
            </div>
          )}
        </>
      ) : view === 'calls' ? (
        <>
          <CallHistoryPanel className="flex w-full shrink-0 border-r border-border-subtle md:flex md:w-80" />
          <div className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-2 text-fg-muted md:flex">
            <Phone size={40} strokeWidth={1.5} aria-hidden />
            <p className="text-body">Select a call to view details</p>
          </div>
        </>
      ) : (
        <StatusesPanel className="flex w-full flex-1" />
      )}
    </div>
  );
}
