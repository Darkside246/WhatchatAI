import { useEffect, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { api, ApiError, type ListDto, type WorkspaceChatSummary } from '../lib/api.js';

/**
 * Which Lists a conversation belongs to.
 *
 * Lists have existed with a full API - members, membership, agent
 * assignment - and no way to put a conversation into one. The Lists page
 * could create and delete a list and assign an agent to it; nothing
 * anywhere could add a chat. So every list was permanently empty, and the
 * per-list agent assignment it feeds had nothing to act on.
 *
 * A dialog rather than a submenu: a business with a dozen lists does not fit
 * in a context menu, and this is a thing somebody does deliberately rather
 * than in passing.
 */
export function ChatListPicker({
  chat,
  onClose,
  onChanged,
}: {
  chat: WorkspaceChatSummary;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [lists, setLists] = useState<ListDto[] | null>(null);
  const [memberOf, setMemberOf] = useState<Set<string>>(new Set());
  const [busyListId, setBusyListId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [all, mine] = await Promise.all([api.getLists(), api.getListsForChat(chat.id)]);
        if (cancelled) return;
        setLists(all.lists);
        setMemberOf(new Set(mine.lists.map((list) => list.id)));
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load your lists.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chat.id]);

  async function toggle(list: ListDto) {
    setBusyListId(list.id);
    setError(null);
    try {
      if (memberOf.has(list.id)) {
        /**
         * Removal needs the membership row, not the chat.
         *
         * The API deletes by list_members.id, so the row has to be found
         * first. Only fetched for the one list being changed - loading every
         * list's members up front to save this would be a request per list
         * on a dialog most people open to add, not remove.
         */
        const { members } = await api.getListMembers(list.id);
        const membership = members.find((member) => member.chatId === chat.id);
        if (!membership) {
          // Somebody else removed it while this was open. Nothing to undo,
          // so the honest thing is to agree with them.
          setMemberOf((current) => new Set([...current].filter((id) => id !== list.id)));
          return;
        }
        await api.removeListMember(list.id, membership.id);
        setMemberOf((current) => new Set([...current].filter((id) => id !== list.id)));
      } else {
        await api.addListMember(list.id, 'chat', chat.id);
        setMemberOf((current) => new Set(current).add(list.id));
      }
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    } finally {
      setBusyListId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-t-2xl bg-surface-1 sm:rounded-2xl">
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-body font-semibold text-fg">Add to list</p>
            <p className="truncate text-meta text-fg-muted">{chat.displayName}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded p-1 text-fg-muted hover:text-fg">
            <X size={16} aria-hidden />
          </button>
        </div>

        {error && <p className="border-b border-error/30 bg-error/10 px-4 py-2 text-caption text-error">{error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {lists === null && <p className="p-3 text-caption text-fg-muted">Loading…</p>}
          {lists !== null && lists.length === 0 && (
            <p className="p-3 text-caption text-fg-muted">
              No lists yet. Make one on the Lists page and it will show up here.
            </p>
          )}

          {(lists ?? []).map((list) => {
            const member = memberOf.has(list.id);
            return (
              <button
                key={list.id}
                type="button"
                disabled={busyListId !== null}
                onClick={() => void toggle(list)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-caption disabled:opacity-50 ${
                  member ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2'
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    member ? 'border-accent bg-accent text-white' : 'border-border-subtle'
                  }`}
                  aria-hidden
                >
                  {busyListId === list.id ? <Loader2 size={10} className="animate-spin" /> : member ? <Check size={10} /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{list.name}</span>
                {/* The list's own colour, where it has one - the same marker the Lists page uses. */}
                {list.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: list.color }} aria-hidden />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
