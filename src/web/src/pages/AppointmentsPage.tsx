import { useEffect, useState } from 'react';
import { CalendarClock, ExternalLink, Loader2, X, UserX } from 'lucide-react';
import { api, ApiError, type AppointmentDto } from '../lib/api.js';

/**
 * Section 56 (Appointment System): a real, dedicated view of every meeting
 * this business's AI has booked - Google Meet and Zoom alike. Before this
 * page, scheduled_meetings had zero UI anywhere (not even per-chat) despite
 * being a fully real, working booking system - a real customer-facing
 * commitment with no way for a human to see it. This is that surface.
 */

const STATUS_LABEL: Record<AppointmentDto['status'], string> = {
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  completed: 'Completed',
  no_show: 'No-show',
};

const STATUS_COLOR: Record<AppointmentDto['status'], string> = {
  confirmed: 'bg-accent-soft text-accent',
  cancelled: 'bg-surface-3 text-fg-muted',
  failed: 'bg-error/15 text-error',
  completed: 'bg-success/15 text-success',
  no_show: 'bg-warning/15 text-warning',
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function AppointmentsPage() {
  const [appointments, setAppointments] = useState<AppointmentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      const result = await api.listAppointments();
      setAppointments(result.appointments);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load appointments.');
    }
  }

  useEffect(() => { void load(); }, []);

  async function handleCancel(id: string) {
    if (!window.confirm('Cancel this appointment? This only updates your own record - it does not cancel the event on Google/Zoom.')) return;
    setBusyId(id);
    setError(null);
    try {
      await api.cancelAppointment(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel this appointment.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleNoShow(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.markAppointmentNoShow(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark this as a no-show.');
    } finally {
      setBusyId(null);
    }
  }

  const now = Date.now();
  const upcoming = (appointments ?? []).filter((a) => a.status === 'confirmed' && new Date(a.startAt).getTime() >= now);
  const past = (appointments ?? []).filter((a) => !(a.status === 'confirmed' && new Date(a.startAt).getTime() >= now));

  function AppointmentRow({ appointment }: { appointment: AppointmentDto }) {
    const busy = busyId === appointment.id;
    return (
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border-subtle bg-surface-1 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-fg">{appointment.title}</p>
            <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${STATUS_COLOR[appointment.status]}`}>{STATUS_LABEL[appointment.status]}</span>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-meta text-fg-muted capitalize">{appointment.provider.replace('_', ' ')}</span>
          </div>
          <p className="mt-1 text-caption text-fg-secondary">{formatDateTime(appointment.startAt)} · {appointment.timezone}</p>
          {appointment.attendeeEmail && <p className="mt-0.5 text-caption text-fg-muted">{appointment.attendeeName ?? appointment.attendeeEmail}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a href={appointment.meetUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-2">
            <ExternalLink size={12} aria-hidden /> Join link
          </a>
          {appointment.status === 'confirmed' && (
            <>
              <button type="button" disabled={busy} onClick={() => void handleNoShow(appointment.id)} title="Mark as no-show" className="flex items-center gap-1 rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-warning hover:bg-warning/10 disabled:opacity-50">
                {busy ? <Loader2 size={12} className="animate-spin" /> : <UserX size={12} aria-hidden />} No-show
              </button>
              <button type="button" disabled={busy} onClick={() => void handleCancel(appointment.id)} title="Cancel" className="flex items-center gap-1 rounded-lg border border-error/30 px-3 py-1.5 text-caption font-medium text-error hover:bg-error/10 disabled:opacity-50">
                {busy ? <Loader2 size={12} className="animate-spin" /> : <X size={12} aria-hidden />} Cancel
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-surface-0 p-5 sm:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <section className="flex items-start gap-4 rounded-2xl border border-border-subtle bg-surface-1 p-6 sm:p-8">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <CalendarClock size={22} />
          </div>
          <div>
            <p className="text-meta font-semibold tracking-widest text-accent">APPOINTMENTS</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Every real meeting your AI has booked</h1>
            <p className="mt-3 max-w-2xl text-body leading-7 text-fg-secondary">
              Google Meet and Zoom bookings, in one place - completed meetings are marked automatically once their time
              has passed; no-shows are only ever marked by you.
            </p>
          </div>
        </section>

        {error && <p className="rounded-xl border border-error/30 bg-error/5 p-4 text-caption text-error">{error}</p>}

        {appointments === null && !error && <p className="text-caption text-fg-muted">Loading…</p>}

        {appointments !== null && (
          <>
            <div>
              <h2 className="mb-2 text-title font-semibold text-fg">Upcoming ({upcoming.length})</h2>
              {upcoming.length === 0 ? (
                <p className="text-caption text-fg-muted">No upcoming appointments.</p>
              ) : (
                <div className="space-y-2">{upcoming.map((a) => <AppointmentRow key={a.id} appointment={a} />)}</div>
              )}
            </div>
            <div>
              <h2 className="mb-2 text-title font-semibold text-fg">Past</h2>
              {past.length === 0 ? (
                <p className="text-caption text-fg-muted">No past appointments yet.</p>
              ) : (
                <div className="space-y-2">{past.map((a) => <AppointmentRow key={a.id} appointment={a} />)}</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
