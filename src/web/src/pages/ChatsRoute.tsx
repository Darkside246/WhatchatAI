import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChatListPane } from '../components/ChatListPane.js';
import { ChatThread } from '../components/ChatThread.js';
import { ContactDetailPanel } from '../components/ContactDetailPanel.js';

export function ChatsRoute() {
  const { chatId } = useParams<{ chatId: string }>();
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      <ChatListPane
        className={`w-full shrink-0 border-r border-border-subtle lg:flex lg:w-80 ${chatId ? 'hidden' : 'flex'}`}
      />

      <div className={`min-w-0 flex-1 lg:flex ${chatId ? 'flex' : 'hidden'}`}>
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
    </div>
  );
}
