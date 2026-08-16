import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Phone } from 'lucide-react';
import { ChatListPane } from '../components/ChatListPane.js';
import { ChatThread } from '../components/ChatThread.js';
import { ContactDetailPanel } from '../components/ContactDetailPanel.js';
import { InboxNavRail, type InboxView } from '../components/InboxNavRail.js';
import { CallHistoryPanel } from '../components/CallHistoryPanel.js';

export function ChatsRoute() {
  const { chatId } = useParams<{ chatId: string }>();
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [view, setView] = useState<InboxView>('chats');

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      <InboxNavRail view={view} onChange={setView} />

      {view === 'chats' ? (
        <>
          <ChatListPane
            className={`w-full shrink-0 border-r border-border-subtle md:flex md:w-80 ${chatId ? 'hidden' : 'flex'}`}
          />

          <div className={`min-w-0 flex-1 md:flex ${chatId ? 'flex' : 'hidden'}`}>
            <ChatThread onOpenDetail={() => setMobileDetailOpen(true)} />
          </div>

          {chatId && (
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
      ) : (
        <>
          <CallHistoryPanel className="flex w-full shrink-0 border-r border-border-subtle md:flex md:w-80" />
          <div className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-2 text-fg-muted md:flex">
            <Phone size={40} strokeWidth={1.5} aria-hidden />
            <p className="text-sm">Select a call to view details</p>
          </div>
        </>
      )}
    </div>
  );
}
