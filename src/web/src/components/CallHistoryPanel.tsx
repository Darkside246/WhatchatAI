import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Video, Phone as PhoneIcon } from 'lucide-react';
import { api, type WorkspaceCallSummary } from '../lib/api.js';
import { useWhatsAppSync, type RealtimeEvent } from '../hooks/useWhatsAppSync.js';

const POLL_MS = 8000;

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '';
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${remaining.toString().padStart(2, '0')}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const STATUS_LABEL: Record<WorkspaceCallSummary['status'], string> = {
  offer: 'Ringing…',
  ringing: 'Ringing…',
  accepted: 'Answered',
  rejected: 'Declined',
  missed: 'Missed',
  timeout: 'Missed',
  ended: 'Ended',
  unknown: 'Unknown',
};

function CallDirectionIcon({ call }: { call: WorkspaceCallSummary }) {
  const missed = call.status === 'missed' || call.status === 'timeout' || call.status === 'rejected';
  const colorClass = missed ? 'text-red-400' : 'text-emerald-400';
  const Icon = call.direction === 'inbound' ? ArrowDownLeft : ArrowUpRight;
  return <Icon size={14} strokeWidth={2} className={colorClass} aria-hidden />;
}

interface Props {
  className?: string;
}

export function CallHistoryPanel({ className = '' }: Props) {
  const [calls, setCalls] = useState<WorkspaceCallSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const { calls: list } = await api.listCalls();
      setCalls(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load call history.');
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const { connected } = useWhatsAppSync((event: RealtimeEvent) => {
    if (event.type === 'call.updated') void load();
  });

  return (
    <div className={`h-full flex-col ${className}`}>
      <div className="shrink-0 border-b border-border-subtle p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold text-white">Calls</h1>
          <span
            title={connected ? 'Live updates connected' : 'Live updates unavailable - showing periodically refreshed data'}
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-gray-600'}`}
          />
        </div>
        <p className="mt-1 text-xs text-gray-500">Real voice and video call events synced from WhatsApp.</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && <p className="p-4 text-xs text-red-400">{error}</p>}
        {calls === null && !error && <p className="p-4 text-sm text-gray-500">Loading real call history…</p>}
        {calls?.length === 0 && (
          <p className="p-4 text-sm text-gray-500">No calls recorded yet. Real call events will appear here as they happen.</p>
        )}
        {calls?.map((call) => (
          <div
            key={call.id}
            className="flex items-center gap-3 border-b border-border-subtle/60 px-4 py-3 hover:bg-surface-1"
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-3 text-sm font-semibold text-gray-300">
              {call.displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{call.displayName}</p>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
                <CallDirectionIcon call={call} />
                {call.isVideo ? <Video size={13} strokeWidth={1.75} aria-hidden /> : <PhoneIcon size={13} strokeWidth={1.75} aria-hidden />}
                <span>{STATUS_LABEL[call.status]}</span>
                {call.durationSeconds !== null && <span>· {formatDuration(call.durationSeconds)}</span>}
              </div>
            </div>
            <span className="shrink-0 text-[11px] text-gray-500">{formatTime(call.startedAt ?? call.endedAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
