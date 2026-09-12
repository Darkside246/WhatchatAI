import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bike, BookOpen, Camera, ChefHat, ClipboardCheck, Eye, MessageSquare, Navigation, PackageCheck, RotateCcw, Settings2, Store, Undo2, X } from 'lucide-react';
import { api, ApiError, type FoodBoardOrderDto, type FoodOrderStage, type FoodSlaBand } from '../lib/api.js';
import { QcPhotoButton } from '../components/QcPhotoButton.js';
import { DeliveryControl } from '../components/DeliveryControl.js';
import { DriverRoster } from '../components/DriverRoster.js';
import { CustomerUpdates } from '../components/CustomerUpdates.js';
import { useVisiblePolling } from '../hooks/useVisiblePolling.js';
import { KitchenSettings } from '../components/KitchenSettings.js';
import { MenuEditor } from '../components/MenuEditor.js';

/**
 * The kitchen board.
 *
 * One screen per station would be the obvious design and is the wrong one
 * for a small kitchen: the whole point is that the person on the fryer can
 * see the pass backing up. So every stage is a column on one board, and a
 * ticket moves right as it is worked.
 *
 * This replaces a mock built on hardcoded customers and invented totals.
 * Everything here is a real order.
 */

const COLUMNS: { stage: FoodOrderStage; label: string; hint: string; icon: typeof ChefHat }[] = [
  { stage: 'NEW', label: 'New', hint: 'Taken, not yet accepted', icon: ClipboardCheck },
  { stage: 'IN_KITCHEN', label: 'Kitchen', hint: 'On the line', icon: ChefHat },
  { stage: 'QUALITY_CHECK', label: 'Quality check', hint: 'Checked before it leaves the pass', icon: PackageCheck },
  { stage: 'READY_FOR_PICKUP', label: 'Waiting on collection', hint: 'On the counter', icon: Store },
  { stage: 'OUT_FOR_DELIVERY', label: 'Out for delivery', hint: 'With a driver', icon: Bike },
];

const STAGE_LABEL: Record<FoodOrderStage, string> = {
  NEW: 'New', IN_KITCHEN: 'Kitchen', QUALITY_CHECK: 'Quality check',
  READY_FOR_PICKUP: 'Waiting on collection', OUT_FOR_DELIVERY: 'Out for delivery',
  COMPLETED: 'Done', CANCELLED: 'Cancelled',
};

/**
 * The bands a kitchen screen has always used. Deliberately loud at the top
 * end - a ticket past fifteen minutes is meant to be impossible to miss
 * from across a room.
 */
const SLA_STYLE: Record<FoodSlaBand, string> = {
  ON_TIME: 'border-success/40 bg-success/5',
  WARNING: 'border-warning/60 bg-warning/10',
  BREACHED: 'border-error/70 bg-error/15',
};
const SLA_TIMER: Record<FoodSlaBand, string> = {
  ON_TIME: 'text-success',
  WARNING: 'text-warning',
  BREACHED: 'text-error font-bold',
};

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

export function FoodOperationsPage() {
  const [orders, setOrders] = useState<FoodBoardOrderDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * Seconds since the last poll, added to each server-computed age so the
   * timers tick smoothly between refreshes. The BAND still comes from the
   * server - two tablets disagreeing about whether a ticket is late is
   * worse than neither showing a timer at all.
   */
  const [drift, setDrift] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * The menu, over the board rather than on another page.
   *
   * A dish runs out, or is priced wrong, while service is running - and
   * the person who notices is looking at the board. Making them navigate
   * away from the tickets to fix it is how a menu stays wrong all evening.
   */
  const [menuOpen, setMenuOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.getFoodBoard();
      setOrders(result.orders);
      setDrift(0);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the board.');
      setOrders((current) => current ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Pauses while nobody is looking at the tab, like every other poll in the app.
  useVisiblePolling(load, 5000);

  useEffect(() => {
    const timer = setInterval(() => setDrift((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  async function move(order: FoodBoardOrderDto, stage: FoodOrderStage, note?: string) {
    setBusyId(order.id);
    try {
      await api.moveFoodOrder(order.id, stage, note);
      await load();
    } catch (err) {
      // A 409 means somebody at another station bumped it first, which
      // during a rush is normal rather than exceptional - so reload and
      // show where the ticket actually is instead of an alarming error.
      setError(err instanceof ApiError ? err.message : 'Could not move that ticket.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Cooking an unpaid order on purpose. A reason is required because an
   * unattributable exemption is indistinguishable from a mistake - and
   * this one gives away food.
   */
  async function release(order: FoodBoardOrderDto) {
    const reason = window.prompt(`Release #${order.orderNumber} to the kitchen without payment?\n\nSay why — it is recorded against the order.`);
    if (!reason?.trim()) return;

    setBusyId(order.id);
    try {
      await api.releaseFoodOrderUnpaid(order.id, reason.trim());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not release that order.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Sending an order out without the photo this business asked for - a
   * broken camera, a queue out of the door. A reason is required because
   * an escape hatch nobody has to account for stops being an escape hatch
   * and becomes the normal route.
   */
  async function sendOutWithoutPhoto(order: FoodBoardOrderDto) {
    if (!order.nextStage) return;
    const reason = window.prompt(`Send #${order.orderNumber} out without a photo?\n\nSay why — it is recorded against the order.`);
    if (!reason?.trim()) return;

    setBusyId(order.id);
    try {
      await api.sendOutWithoutQcPhoto(order.id, order.nextStage, reason.trim());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send that order out.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const byStage = useMemo(() => {
    const grouped = new Map<FoodOrderStage, FoodBoardOrderDto[]>();
    for (const column of COLUMNS) grouped.set(column.stage, []);
    for (const order of orders ?? []) grouped.get(order.stage)?.push(order);
    return grouped;
  }, [orders]);

  const late = (orders ?? []).filter((order) => order.slaBand === 'BREACHED').length;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface-0">
      <header className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-display font-semibold text-fg">Kitchen</h1>
          <p className="text-caption text-fg-muted">
            {orders === null ? 'Loading…' : `${orders.length} order${orders.length === 1 ? '' : 's'} on the board`}
            {late > 0 && <span className="ml-2 font-semibold text-error">{late} late</span>}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link to="/chats" className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2">
            <MessageSquare size={14} aria-hidden />
            Chats
          </Link>
          <button type="button" onClick={() => void load()} className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2">
            <RotateCcw size={14} aria-hidden />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2"
          >
            <BookOpen size={14} aria-hidden />
            Menu
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-expanded={settingsOpen}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2"
          >
            <Settings2 size={14} aria-hidden />
            Setup
          </button>
        </div>
      </header>

      {error && <p className="border-b border-error/30 bg-error/10 px-4 py-2 text-caption text-error">{error}</p>}

      {/* Over the board, not instead of it: the tickets are still behind
          this, and closing it puts the operator back exactly where they
          were rather than at the top of a board they had scrolled. */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 flex flex-col bg-surface-0">
          <header className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-body font-semibold text-fg">Menu</h2>
              <p className="text-meta text-fg-muted">
                What you sell, what it costs, and what can be added to it. Your agent takes orders from exactly this.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { setMenuOpen(false); void load(); }}
              className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2"
            >
              <X size={14} aria-hidden />
              Back to the board
            </button>
          </header>
          <MenuEditor />
        </div>
      )}

      {/* On the board rather than buried in Settings, because these are the
          decisions an owner changes while looking at their own service -
          turning the payment gate off during a quiet afternoon, widening
          the ticket times after a bad Friday. */}
      {settingsOpen && (
        <section className="border-b border-border-subtle bg-surface-1 px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-body font-semibold text-fg">Kitchen setup</h2>
              <p className="text-meta text-fg-muted">How orders behave. Your agent's wording lives on the Agents page.</p>
            </div>
            <button type="button" onClick={() => setSettingsOpen(false)} aria-label="Close setup" className="rounded-md p-1 text-fg-muted hover:bg-surface-2 hover:text-fg">
              <X size={16} aria-hidden />
            </button>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="max-w-xl">
              <KitchenSettings />
            </div>
            <div className="max-w-xl space-y-6">
              <DriverRoster />
              <CustomerUpdates />
            </div>
          </div>
        </section>
      )}

      {orders !== null && orders.length === 0 && !error && (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center text-fg-muted">
          <ChefHat size={32} strokeWidth={1.25} className="mb-3 opacity-40" aria-hidden />
          <p className="text-body font-medium text-fg">Nothing on the board</p>
          <p className="mt-1 max-w-sm text-caption">
            Orders appear here the moment one is taken — from a WhatsApp conversation or keyed in at the counter.
          </p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="flex h-full min-w-max gap-3 p-3">
          {COLUMNS.map((column) => {
            const columnOrders = byStage.get(column.stage) ?? [];
            const Icon = column.icon;
            return (
              <section key={column.stage} className="flex w-[19rem] shrink-0 flex-col rounded-xl border border-border-subtle bg-surface-1">
                <div className="border-b border-border-subtle px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-caption font-semibold text-fg">
                    <Icon size={14} aria-hidden />
                    {column.label}
                    <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-meta text-fg-muted">{columnOrders.length}</span>
                  </p>
                  <p className="mt-0.5 text-meta text-fg-muted">{column.hint}</p>
                </div>

                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                  {columnOrders.map((order) => (
                    <OrderCard
                      key={order.id}
                      order={order}
                      drift={drift}
                      busy={busyId === order.id}
                      onBump={() => order.nextStage && void move(order, order.nextStage)}
                      onSendBack={() => void move(order, 'IN_KITCHEN', 'sent back from the pass')}
                      onRelease={() => void release(order)}
                      onSendOutWithoutPhoto={() => void sendOutWithoutPhoto(order)}
                      onPhotoTaken={() => void load()}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const PAYMENT_BADGE: Record<FoodBoardOrderDto['paymentState'], { label: string; className: string } | null> = {
  // Nothing shown for a business that does not gate on payment, and
  // nothing for a paid order - a badge on every ticket is a badge nobody
  // reads. Only the states somebody has to act on appear.
  NOT_REQUIRED: null,
  PAID: null,
  UNPAID: { label: 'Unpaid', className: 'bg-error/20 text-error' },
  AWAITING_VERIFICATION: { label: 'Payment unverified', className: 'bg-warning/20 text-warning' },
  WAIVED: { label: 'Paying later', className: 'bg-accent-soft text-accent' },
  REFUNDED: { label: 'Refunded', className: 'bg-error/20 text-error' },
  FAILED: { label: 'Payment failed', className: 'bg-error/20 text-error' },
};

function OrderCard({
  order, drift, busy, onBump, onSendBack, onRelease, onSendOutWithoutPhoto, onPhotoTaken,
}: {
  order: FoodBoardOrderDto;
  drift: number;
  busy: boolean;
  onBump: () => void;
  onSendBack: () => void;
  onRelease: () => void;
  onSendOutWithoutPhoto: () => void;
  onPhotoTaken: () => void;
}) {
  return (
    <article className={`rounded-lg border-2 p-2.5 ${SLA_STYLE[order.slaBand]}`}>
      <div className="flex items-baseline gap-2">
        <span className="text-body font-bold text-fg">#{order.orderNumber}</span>
        <span className={`font-mono text-body tabular-nums ${SLA_TIMER[order.slaBand]}`}>{clock(order.elapsedSeconds + drift)}</span>
        <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-meta font-medium text-fg-secondary">
          {order.fulfilmentMethod === 'DELIVERY' ? 'Delivery' : order.fulfilmentMethod === 'DINE_IN' ? (order.tableLabel ?? 'Table') : 'Collection'}
        </span>
      </div>

      {/* The money, stated on the ticket. An unpaid order on a line is the
          one mistake this board exists to prevent, so it is never a detail
          somebody has to open the order to find. */}
      {PAYMENT_BADGE[order.paymentState] && (
        <p className={`mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-meta font-semibold ${PAYMENT_BADGE[order.paymentState]!.className}`}>
          {PAYMENT_BADGE[order.paymentState]!.label}
          {order.paymentState === 'WAIVED' && order.paymentWaiverReason && (
            <span className="font-normal opacity-80">· {order.paymentWaiverReason}</span>
          )}
        </p>
      )}

      {order.customerName && <p className="mt-1 truncate text-caption font-medium text-fg">{order.customerName}</p>}

      {/* The allergen banner is full width and loud on purpose - it is the
          one thing on this card that can hurt somebody. */}
      {order.allergenNotes && (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-error/20 px-2 py-1 text-caption font-semibold text-error">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
          {order.allergenNotes}
        </p>
      )}

      <ul className="mt-2 space-y-1">
        {order.items.map((item, index) => (
          <li key={`${item.name}-${index}`} className="text-caption text-fg">
            <span className="font-semibold">{item.quantity}×</span> {item.name}
            {item.variant && <span className="text-fg-secondary"> · {item.variant}</span>}
            {item.modifiers.length > 0 && (
              <span className="mt-0.5 flex flex-wrap gap-1">
                {item.modifiers.map((modifier, modifierIndex) => (
                  <span
                    key={`${modifier.name}-${modifierIndex}`}
                    className={`rounded px-1.5 py-0.5 text-meta font-medium ${
                      modifier.action === 'remove' ? 'bg-error/15 text-error' : 'bg-accent-soft text-accent'
                    }`}
                  >
                    {modifier.action === 'remove' ? 'no ' : modifier.action === 'on_side' ? 'side: ' : '+ '}
                    {modifier.name}
                  </span>
                ))}
              </span>
            )}
            {item.notes && <span className="block text-meta italic text-fg-muted">{item.notes}</span>}
          </li>
        ))}
      </ul>

      {order.kitchenNotes && <p className="mt-1.5 text-meta italic text-fg-secondary">{order.kitchenNotes}</p>}

      {/* What the photo found. Only ever things that were SEEN - the photo
          can never establish that something is missing, so nothing here
          ever claims it does. A person decides; this only makes them
          look. */}
      {order.qcFindings.length > 0 && (
        <div className={`mt-1.5 rounded-md px-2 py-1.5 ${order.qcAcknowledgedAt ? 'bg-surface-2' : 'bg-warning/15'}`}>
          <p className={`flex items-center gap-1.5 text-meta font-semibold ${order.qcAcknowledgedAt ? 'text-fg-muted' : 'text-warning'}`}>
            <Eye size={12} aria-hidden />
            {order.qcAcknowledgedAt ? 'Checked and cleared' : 'Worth a second look'}
          </p>
          <ul className={`mt-0.5 space-y-0.5 text-meta ${order.qcAcknowledgedAt ? 'text-fg-muted' : 'text-warning'}`}>
            {order.qcFindings.map((finding, index) => (
              <li key={`${finding.line}-${index}`}>{finding.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Only where somebody is actually driving. A collection ticket does
          not need a driver picker, and a board full of controls nobody
          presses is a board people stop reading. */}
      {order.fulfilmentMethod === 'DELIVERY' && (order.stage === 'QUALITY_CHECK' || order.stage === 'OUT_FOR_DELIVERY') && (
        <DeliveryControl order={order} busy={busy} onChanged={onPhotoTaken} />
      )}

      <div className="mt-2 flex items-center gap-2 border-t border-border-subtle pt-2">
        <span className="text-caption font-medium text-fg-secondary">{money(order.totalCents, order.currency)}</span>

        {/* The pin the customer dropped, not a typed address - it cannot be
            misspelled or missing a postcode. */}
        {order.navigationUrl && (
          <a
            href={order.navigationUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-meta font-medium text-fg hover:bg-surface-2"
          >
            <Navigation size={12} aria-hidden />
            Route
          </a>
        )}

        {order.chatId && (
          <Link
            to={`/chats/${order.chatId}`}
            className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-meta font-medium text-fg hover:bg-surface-2"
            title="Open the conversation this order came from"
          >
            <MessageSquare size={12} aria-hidden />
            Chat
          </Link>
        )}

        {order.stage === 'QUALITY_CHECK' && (
          <button
            type="button"
            disabled={busy}
            onClick={onSendBack}
            title="Send back to the line"
            className="rounded-md border border-border-subtle px-2 py-1 text-meta font-medium text-fg-muted hover:text-fg disabled:opacity-50"
          >
            <Undo2 size={12} aria-hidden />
          </button>
        )}

        {/* Offered at the pass whether or not a photo is required - a
            kitchen that wants the picture on one awkward order should not
            have to turn a setting on to take it. */}
        {order.stage === 'QUALITY_CHECK' && <QcPhotoButton orderId={order.id} taken={order.qcCheckedAt !== null} onDone={onPhotoTaken} />}

        {order.nextStage && !order.blockedReason && !order.qcPhotoOutstanding && (
          <button
            type="button"
            disabled={busy}
            onClick={onBump}
            className="ml-auto rounded-md bg-accent px-2.5 py-1 text-meta font-semibold text-white transition hover:bg-accent-dim disabled:opacity-50"
          >
            {busy ? '…' : STAGE_LABEL[order.nextStage]}
          </button>
        )}

        {/* The same reasoning as the payment gate: never offer a bump that
            will be refused. The only action actually available is going
            out without the photo, on somebody's say-so. */}
        {order.qcPhotoOutstanding && !order.blockedReason && (
          <button
            type="button"
            disabled={busy}
            onClick={onSendOutWithoutPhoto}
            title="This order needs a photo before it leaves the pass"
            className="ml-auto rounded-md border border-warning/60 bg-warning/15 px-2.5 py-1 text-meta font-semibold text-warning disabled:opacity-50"
          >
            {busy ? '…' : 'Send out anyway'}
          </button>
        )}

        {/* A bump that silently does nothing is the worst behaviour on a
            screen somebody is working at speed, so a blocked ticket says
            so plainly and offers the only action that is actually
            available: releasing it on somebody's authority. */}
        {order.blockedReason && (
          <button
            type="button"
            disabled={busy}
            onClick={onRelease}
            title={order.blockedReason}
            className="ml-auto rounded-md border border-warning/60 bg-warning/15 px-2.5 py-1 text-meta font-semibold text-warning disabled:opacity-50"
          >
            {busy ? '…' : 'Release unpaid'}
          </button>
        )}
      </div>

      {order.blockedReason && <p className="mt-1.5 text-meta text-warning">{order.blockedReason}</p>}
      {order.qcPhotoOutstanding && !order.blockedReason && (
        <p className="mt-1.5 text-meta text-warning">Needs a photo before it leaves the pass.</p>
      )}
    </article>
  );
}
