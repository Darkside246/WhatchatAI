import type { SyncStatusResponse, WhatsAppConnectionSnapshot } from '../lib/api.js';

interface Props {
  connection: WhatsAppConnectionSnapshot | null;
  sync: SyncStatusResponse | null;
  onContinueAnyway: () => void;
}

export function SyncingPage({ connection, sync, onContinueAnyway }: Props) {
  const progress = sync?.syncProgress ?? null;
  const job = sync?.latestJob ?? null;

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 bg-surface-0 px-6 py-16 text-center">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-lg font-bold text-emerald-400">
          W
        </div>
        <span className="text-lg font-semibold tracking-tight text-white">WhatchatAI</span>
      </div>

      <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-surface-2 p-8">
        <h2 className="text-xl font-semibold text-white">Synchronizing your business data…</h2>
        <p className="mt-2 text-sm text-gray-400">
          Connected as {connection?.pushName ?? connection?.phoneNumber ?? connection?.jid ?? 'your account'}.
          Pulling real chats, contacts, groups, and message history from WhatsApp.
        </p>

        <div className="mt-6 h-2 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-500"
            style={{ width: progress !== null ? `${Math.min(100, Math.max(0, progress))}%` : '8%' }}
          />
        </div>
        <p className="mt-2 text-xs text-gray-500">
          {progress !== null ? `${Math.round(progress)}% reported by WhatsApp` : 'Waiting for the first data batch…'}
        </p>

        {job && (
          <dl className="mt-6 grid grid-cols-3 gap-3 text-left text-xs text-gray-400">
            <div className="rounded-lg bg-surface-3 p-3">
              <dt className="text-gray-500">Chats</dt>
              <dd className="mt-1 text-base font-semibold text-white">{job.chatsProcessed}</dd>
            </div>
            <div className="rounded-lg bg-surface-3 p-3">
              <dt className="text-gray-500">Contacts</dt>
              <dd className="mt-1 text-base font-semibold text-white">{job.contactsProcessed}</dd>
            </div>
            <div className="rounded-lg bg-surface-3 p-3">
              <dt className="text-gray-500">Messages</dt>
              <dd className="mt-1 text-base font-semibold text-white">{job.messagesProcessed}</dd>
            </div>
          </dl>
        )}

        {sync?.syncStatus === 'failed' && (
          <div className="mt-6 rounded-lg bg-red-500/10 p-3 text-left text-xs text-red-400">
            <p>Sync reported an error: {sync.lastSyncError ?? 'unknown error'}.</p>
            <button
              type="button"
              onClick={onContinueAnyway}
              className="mt-3 rounded-md bg-red-500/20 px-3 py-1.5 font-medium text-red-300 hover:bg-red-500/30"
            >
              Continue anyway - some data may be incomplete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
