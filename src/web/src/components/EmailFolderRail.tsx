import { useEffect, useState } from 'react';
import { Inbox, Send, FileText, AlertTriangle, Trash2, Archive, Folder as FolderIcon, PenSquare } from 'lucide-react';
import { api } from '../lib/api.js';

export type OAuthFolderSelection = { kind: 'oauth'; accountId: string; folderId: string; displayName: string };
export type ComposeQueueSelection = { kind: 'compose' };
export type EmailFolderSelection = OAuthFolderSelection | ComposeQueueSelection;

type Account = { id: string; provider: 'gmail' | 'outlook'; emailAddress: string; displayName: string | null };
type Folder = {
  id: string;
  accountId: string;
  providerFolderId: string;
  displayName: string;
  wellKnownType: 'inbox' | 'sent' | 'drafts' | 'spam' | 'trash' | 'archive' | 'other';
  unreadCount: number;
  totalCount: number;
};

const WELL_KNOWN_ICON: Record<Folder['wellKnownType'], typeof Inbox> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  spam: AlertTriangle,
  trash: Trash2,
  archive: Archive,
  other: FolderIcon,
};

/**
 * Left rail of the Gmail-style Email page (Email Redesign Phase B) - one
 * group per connected Gmail/Outlook account, its real, provider-discovered
 * folders (email_oauth_folders, never a fixed guessed list), plus a fixed
 * "Compose queue" entry that folds in the existing AURA-drafted approve-
 * before-send pipeline (unchanged, just relocated here per the user's own
 * decision to fold it into this layout rather than keep it a separate page).
 */
export function EmailFolderRail({
  selection,
  onSelect,
  composeQueueCount,
}: {
  selection: EmailFolderSelection | null;
  onSelect: (selection: EmailFolderSelection) => void;
  composeQueueCount: number;
}) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [foldersByAccount, setFoldersByAccount] = useState<Record<string, Folder[]>>({});

  useEffect(() => {
    api.listOAuthAccounts().then((res) => setAccounts(res.accounts)).catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    if (!accounts) return;
    for (const account of accounts) {
      api
        .getOAuthFolders(account.id)
        .then((res) => setFoldersByAccount((prev) => ({ ...prev, [account.id]: res.folders })))
        .catch(() => undefined);
    }
  }, [accounts]);

  const isComposeSelected = selection?.kind === 'compose';

  return (
    <nav className="flex h-full w-64 shrink-0 flex-col overflow-y-auto border-r border-border-subtle bg-surface-1 p-3">
      <button
        type="button"
        onClick={() => onSelect({ kind: 'compose' })}
        className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-caption font-semibold transition-colors ${
          isComposeSelected ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2'
        }`}
      >
        <span className="flex items-center gap-2">
          <PenSquare size={14} aria-hidden />
          Compose queue
        </span>
        {composeQueueCount > 0 && <span className="text-meta text-fg-muted">{composeQueueCount}</span>}
      </button>

      {accounts === null && <p className="mt-3 px-3 text-meta text-fg-muted">Loading accounts…</p>}

      {accounts?.length === 0 && (
        <p className="mt-3 px-3 text-meta text-fg-muted">
          No Gmail or Outlook account connected yet. Connect one in Settings → Connected Inbox to see real folders here.
        </p>
      )}

      {accounts?.map((account) => {
        const folders = foldersByAccount[account.id];
        return (
          <div key={account.id} className="mt-4">
            <p className="truncate px-3 text-meta font-semibold uppercase tracking-wide text-fg-muted">
              {account.displayName ?? account.emailAddress}
            </p>
            <div className="mt-1 space-y-0.5">
              {folders === undefined && <p className="px-3 py-1 text-meta text-fg-muted">Loading folders…</p>}
              {folders?.length === 0 && <p className="px-3 py-1 text-meta text-fg-muted">No folders synced yet.</p>}
              {folders?.map((folder) => {
                const Icon = WELL_KNOWN_ICON[folder.wellKnownType];
                const isSelected = selection?.kind === 'oauth' && selection.folderId === folder.id;
                return (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => onSelect({ kind: 'oauth', accountId: account.id, folderId: folder.id, displayName: folder.displayName })}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-left text-caption transition-colors ${
                      isSelected ? 'bg-accent-soft text-accent' : 'text-fg-secondary hover:bg-surface-2'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon size={13} className="shrink-0" aria-hidden />
                      <span className="truncate">{folder.displayName}</span>
                    </span>
                    {folder.unreadCount > 0 && <span className="shrink-0 text-meta font-medium">{folder.unreadCount}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
