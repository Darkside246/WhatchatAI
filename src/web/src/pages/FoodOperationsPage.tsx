import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Bike, BookOpen, Calculator, Camera, ChefHat, ChevronDown, ChevronLeft, ChevronUp, Check, ClipboardCheck, ClipboardList, Columns3, Eye, HandCoins, History, LayoutGrid, MessageSquare, Navigation, PackageCheck, Printer, Receipt, RotateCcw, Send, Settings2, Store, Undo2, UtensilsCrossed, X } from 'lucide-react';
import { api, ApiError, type FoodBoardOrderDto, type FoodOrderStage, type FoodSlaBand, type WorkspaceBusiness } from '../lib/api.js';
import { QcPhotoButton } from '../components/QcPhotoButton.js';
import { DeliveryControl } from '../components/DeliveryControl.js';
import { DriverRoster } from '../components/DriverRoster.js';
import { CustomerUpdates } from '../components/CustomerUpdates.js';
import { PaymentMethods } from '../components/PaymentMethods.js';
import { ChatListPane } from '../components/ChatListPane.js';
import { ChatThread } from '../components/ChatThread.js';
import { useVisiblePolling } from '../hooks/useVisiblePolling.js';
import {
  UNASSIGNED_STATION,
  lineIsForStation,
  stationOptions,
  ticketIsForStation,
  ticketsWithUnassignedWork,
  type StationSelection,
} from '../lib/stationView.js';
import { KitchenSettings } from '../components/KitchenSettings.js';
import { MenuEditor } from '../components/MenuEditor.js';
import { FoodPaymentPanel } from '../components/FoodPaymentPanel.js';
import { PrinterSettingsPanel } from '../components/PrinterSettingsPanel.js';
import { buildCustomerReceipt, buildKitchenTicket } from '../lib/foodTicket.js';
import { loadPrinterSettings, noteSuccessfulPrint } from '../lib/printerSettings.js';
import { PrinterError, sendToPrinter } from '../lib/printerTransport.js';
import { OrderHistory } from '../components/OrderHistory.js';
import { ServiceSummary } from '../components/ServiceSummary.js';
import { Register } from '../components/Register.js';

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
const SLA_BAND: Record<FoodSlaBand, string> = {
  ON_TIME: 'bg-kds-ontime',
  WARNING: 'bg-kds-warning',
  BREACHED: 'bg-kds-late',
};

/**
 * How the order was promised, said the way the person carrying it would say
 * it. Colour-separated because at a glance the question is never "what is
 * this order" but "where is it going" - a collection ticket and a delivery
 * ticket get handled by different people.
 */
const FULFILMENT_CHIP: Record<FoodBoardOrderDto['fulfilmentMethod'], { label: string; className: string }> = {
  DINE_IN: { label: 'For here', className: 'bg-violet-500 text-white' },
  PICKUP: { label: 'Collection', className: 'bg-cyan-500 text-white' },
  DELIVERY: { label: 'Delivery', className: 'bg-amber-500 text-white' },
};

type BoardView = 'wall' | 'stages';
const BOARD_VIEW_KEY = 'aura.food.boardView';
const BOARD_STATION_KEY = 'aura.food.boardStation';

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

export function FoodOperationsPage() {
  const [orders, setOrders] = useState<FoodBoardOrderDto[] | null>(null);
  /** The stations the menu defines. Empty for a kitchen that has not assigned any, which is how the picker knows to stay hidden. */
  const [stations, setStations] = useState<string[]>([]);
  /**
   * Which station this screen is for. Null is the whole board.
   *
   * Remembered alongside the layout, and for the same reason: the screen by
   * the fryer is the fryer's screen every service, and making somebody pick
   * it again each morning is how they stop using it.
   */
  const [station, setStation] = useState<StationSelection>(() => {
    try {
      const stored = localStorage.getItem(BOARD_STATION_KEY);
      return stored ? (stored as StationSelection) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    try {
      if (station === null) localStorage.removeItem(BOARD_STATION_KEY);
      else localStorage.setItem(BOARD_STATION_KEY, station);
    } catch {
      // The view still works, it just will not be remembered.
    }
  }, [station]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * Which order's money is open, by id rather than by the order object.
   *
   * The board reloads under the panel on every poll, and holding the object
   * would leave the panel showing a snapshot from before the payment it
   * just recorded.
   */
  const [paymentOrderId, setPaymentOrderId] = useState<string | null>(null);
  const [printerOpen, setPrinterOpen] = useState(false);
  /** For the receipt's header. Fetched once - a business does not rename itself during service. */
  const [business, setBusiness] = useState<WorkspaceBusiness | null>(null);
  /**
   * Orders this device has already printed a kitchen ticket for.
   *
   * Auto-print watches the board, and the board is polled - so without
   * this, every poll would reprint every ticket still in the kitchen and
   * the roll would be gone within the hour. A ref rather than state: it
   * must not cause a render, and it must be read inside the effect without
   * becoming a dependency of it.
   */
  const printedOrderIds = useRef<Set<string>>(new Set());
  /**
   * Seconds since the last poll, added to each server-computed age so the
   * timers tick smoothly between refreshes. The BAND still comes from the
   * server - two tablets disagreeing about whether a ticket is late is
   * worse than neither showing a timer at all.
   */
  const [drift, setDrift] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * Which way the board is laid out.
   *
   * The wall is every live ticket in one flowing grid, which is what a
   * kitchen screen normally looks like and what fits a tablet. The stage
   * board is five columns, and its value is real but only on a wide screen:
   * the whole reason this board exists on one page is so the person on the
   * fryer can see the pass backing up, and a column is how you see that.
   *
   * Remembered per browser, because a given screen in a given kitchen is
   * mounted where it is mounted - the person at the pass should not have to
   * pick their view again every service.
   */
  const [view, setView] = useState<BoardView>(() => {
    try {
      const stored = localStorage.getItem(BOARD_VIEW_KEY);
      return stored === 'stages' || stored === 'wall' ? stored : 'wall';
    } catch {
      // Private windows and blocked site data throw on access rather than
      // returning null. A board that will not render because a preference
      // would not read is a board that fails for no reason.
      return 'wall';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(BOARD_VIEW_KEY, view);
    } catch {
      // Same reasoning: the view still works, it just will not be remembered.
    }
  }, [view]);
  /**
   * The menu, over the board rather than on another page.
   *
   * A dish runs out, or is priced wrong, while service is running - and
   * the person who notices is looking at the board. Making them navigate
   * away from the tickets to fix it is how a menu stays wrong all evening.
   */
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * The archive, over the board for the same reason the menu is: the person
   * who needs to look something up is standing at this screen, and sending
   * them to another page loses the tickets they were watching.
   */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Closing time. Over the board like the menu and the archive - the person asking is standing at this screen. */
  const [summaryOpen, setSummaryOpen] = useState(false);
  /** The counter till. Over the board like the rest - the person keying an order in is standing at this screen. */
  const [registerOpen, setRegisterOpen] = useState(false);
  /** Their own name over their own board. Falls back to 'Kitchen' rather than showing a blank while it loads. */
  const [businessName, setBusinessName] = useState<string | null>(null);

  /**
   * The conversation open beside the board.
   *
   * Held in the URL rather than in state so a ticket's Chat button, a
   * refresh and the browser's back button all agree about what is open -
   * and so ChatThread, which reads the route, needs no change to work
   * here.
   */
  const { chatId } = useParams<{ chatId: string }>();
  const navigate = useNavigate();
  const [chatsOpen, setChatsOpen] = useState(false);
  // Opening a ticket's conversation opens the pane; it does not have to be
  // opened first.
  const paneOpen = chatsOpen || Boolean(chatId);

  const load = useCallback(async () => {
    try {
      const result = await api.getFoodBoard();
      setOrders(result.orders);
      setStations(result.stations);
      setDrift(0);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the board.');
      setOrders((current) => current ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    api
      .getBusiness()
      .then(({ business }) => setBusinessName(business.name))
      // Their name is decoration on this screen. A board that will not
      // load because a name would not is a board that fails for no reason.
      .catch(() => {});
  }, []);
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

  /**
   * Putting a ticket on paper.
   *
   * Built here and sent straight from this device - nothing about a ticket
   * goes to the server to be printed, because the printer is in the room
   * and the server is not.
   */
  const printTicket = useCallback(
    async (order: FoodBoardOrderDto, kind: 'kitchen' | 'receipt') => {
      const settings = loadPrinterSettings();
      if (!settings.enabled) {
        setError('No printer is set up on this device yet — open Printer to set one up.');
        return;
      }
      const ticket =
        kind === 'kitchen'
          ? buildKitchenTicket(order, { paper: settings.paper, station: settings.station ?? station })
          : buildCustomerReceipt(
              order,
              {
                name: business?.name ?? 'Receipt',
                address: business?.address ?? null,
                phone: business?.phone ?? null,
                taxRegistrationNumber: business?.taxRegistrationNumber ?? null,
                taxRegistrationLabel: business?.taxRegistrationLabel ?? null,
              },
              { paper: settings.paper },
            );
      await sendToPrinter(settings.transport, ticket.bytes, ticket.text, settings.paper);
      // So the setup panel can say when this device last actually printed,
      // rather than only that a printer was once chosen.
      noteSuccessfulPrint();
    },
    [business, station],
  );

  async function print(order: FoodBoardOrderDto, kind: 'kitchen' | 'receipt') {
    setBusyId(order.id);
    setError(null);
    try {
      await printTicket(order, kind);
    } catch (err) {
      setError(err instanceof PrinterError || err instanceof Error ? err.message : 'That did not print.');
    } finally {
      setBusyId(null);
    }
  }

  /** Asking the customer for the money. The amount comes off the order, never retyped. */
  /**
   * Sends the customer their bill on the conversation the order came from.
   *
   * The browser composes nothing: the server builds the message off the
   * STORED order - the prices it was taken at, frozen - and sends it. A
   * bill assembled here could quote a figure the order does not have, which
   * is the one thing a bill must never do.
   */
  async function sendBill(order: FoodBoardOrderDto) {
    setBusyId(order.id);
    setError(null);
    try {
      await api.sendFoodBill(order.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the bill.');
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Cancelling an order.
   *
   * Confirmed first, and confirmed with the order named rather than a bare
   * "are you sure": CANCELLED is a terminal stage with nowhere to go from
   * it, so a mis-tap on a busy board is not recoverable by pressing
   * something else. The reason is asked for and kept, because the one
   * question anybody asks about a cancelled order a week later is why.
   */
  async function cancelOrder(order: FoodBoardOrderDto) {
    const label = order.customerName?.trim() || `Order #${order.orderNumber}`;
    const reason = window.prompt(`Cancel ${label}?\n\nThis cannot be undone. Why is it being cancelled?`);
    // Cancel on the prompt returns null. An empty string is somebody
    // pressing OK with nothing typed, which is a deliberate "no reason".
    if (reason === null) return;

    setBusyId(order.id);
    setError(null);
    try {
      await api.moveFoodOrder(order.id, 'CANCELLED', reason.trim() || undefined);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel that order.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function askForPayment(order: FoodBoardOrderDto) {
    setBusyId(order.id);
    setError(null);
    try {
      const outcome = await api.sendFoodPaymentRequest(order.id);
      // A 200 with sent:false is a reason, not a failure - usually "no
      // method is switched on yet", which is a sentence the operator can
      // act on rather than an error page.
      //
      // A limit warning is shown even when the ask DID go out: a wallet at
      // its daily cap stops receiving mid-service, and finding that out
      // from a customer is finding it out too late.
      if (!outcome.sent) setError(outcome.reason ?? 'Nothing was sent.');
      else if (outcome.limitWarning) setError(outcome.limitWarning);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not ask for payment.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Somebody saw the money arrive.
   *
   * On BiMPay this is the whole confirmation: it lands in the owner's own
   * app in real time and nothing tells us about it, so a person saying so
   * is the only truthful signal there is. It opens the kitchen gate.
   */
  async function confirmPayment(order: FoodBoardOrderDto) {
    if (!order.paymentRequest) return;
    const reference = window.prompt(
      `Confirm payment for #${order.orderNumber}?\n\nA reference helps you reconcile later — leave it empty if you do not have one.`,
      '',
    );
    // Cancel returns null; an empty string is a deliberate "no reference".
    if (reference === null) return;

    setBusyId(order.id);
    setError(null);
    try {
      await api.confirmFoodPaymentRequest(order.paymentRequest.id, reference.trim() || undefined);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that payment.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  /**
   * The tickets this screen is responsible for.
   *
   * Narrowed to the chosen station, never emptied by it: a ticket with any
   * work for this station is shown whole, so a cook can see it also needs
   * fries even though making them is not their job. Everything below counts
   * and lays out from this rather than from the raw board, so the station's
   * own totals - including how many are late - are about its own work.
   */
  const stationOrders = useMemo(
    () => (orders ?? []).filter((order) => ticketIsForStation(order, station)),
    [orders, station],
  );

  const byStage = useMemo(() => {
    const grouped = new Map<FoodOrderStage, FoodBoardOrderDto[]>();
    for (const column of COLUMNS) grouped.set(column.stage, []);
    for (const order of stationOrders) grouped.get(order.stage)?.push(order);
    return grouped;
  }, [stationOrders]);

  /**
   * Oldest first, always.
   *
   * With no columns to carry the stage, the only ordering that helps is the
   * one that answers "what is going cold" - so the ticket nearest to being
   * late is the one nearest the top, wherever it is in the process.
   */
  const wallOrders = useMemo(
    () => [...stationOrders].sort((left, right) => right.elapsedSeconds - left.elapsedSeconds),
    [stationOrders],
  );

  useEffect(() => {
    api
      .getBusiness()
      .then((result) => setBusiness(result.business))
      .catch(() => undefined);
  }, []);

  /**
   * Print a kitchen ticket once, when an order first reaches the kitchen.
   *
   * Only from a device that asked for it, and only once per order: the
   * board is polled, so anything keyed on "is in the kitchen now" rather
   * than "has this device printed it" would reprint the same ticket every
   * few seconds until the roll ran out.
   *
   * A failure is silent. The board is a screen somebody is working from,
   * and an error banner they did not ask for - because a printer they are
   * not standing next to is out of paper - is an interruption in the middle
   * of service. The manual print button says what went wrong, because there
   * somebody is waiting for the paper.
   */
  useEffect(() => {
    if (!orders) return;
    const settings = loadPrinterSettings();
    if (!settings.enabled || !settings.autoPrintKitchen) return;

    for (const order of orders) {
      if (order.stage !== 'IN_KITCHEN' || printedOrderIds.current.has(order.id)) continue;
      // Marked before the await, not after: two polls can overlap, and the
      // second must not start a duplicate while the first is still sending.
      printedOrderIds.current.add(order.id);
      void printTicket(order, 'kitchen').catch(() => {
        // Let it be retried on the next poll rather than silently never
        // printing - a ticket that failed because the printer was asleep
        // usually succeeds moments later.
        printedOrderIds.current.delete(order.id);
      });
    }
  }, [orders, printTicket]);

  /**
   * Resolved from the live board every render, so the panel follows the
   * order rather than a copy of it. It closes on its own if the order
   * leaves the board while it is open - there is nothing left to record
   * against a ticket that is no longer there.
   */
  const paymentOrder = useMemo(
    () => (paymentOrderId ? ((orders ?? []).find((candidate) => candidate.id === paymentOrderId) ?? null) : null),
    [orders, paymentOrderId],
  );

  /** Offered only when the menu actually defines stations - a picker with one entry is a control that teaches nothing. */
  const availableStations = useMemo(() => stationOptions(stations, orders ?? []), [stations, orders]);
  /**
   * Work nobody has routed anywhere.
   *
   * Said out loud rather than left to be discovered: an item with no station
   * is invisible to every station view by name, and the way that failure
   * surfaces otherwise is a customer asking where their food is.
   */
  const unroutedTickets = useMemo(() => ticketsWithUnassignedWork(orders ?? []), [orders]);

  /**
   * Clearing a photo finding.
   *
   * No confirmation: this says "a person looked", which is exactly the
   * thing that should be one tap, and it destroys nothing - the check and
   * its findings stay in the record with who cleared them.
   */
  async function acknowledgeQc(order: FoodBoardOrderDto) {
    if (!order.qcCheckId) return;
    setBusyId(order.id);
    try {
      await api.acknowledgeFoodQcCheck(order.qcCheckId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not clear that check.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const late = stationOrders.filter((order) => order.slaBand === 'BREACHED').length;

  /**
   * One ticket, wired once.
   *
   * Both layouts render the same card with the same eleven props, and a
   * second copy of that wiring is how one view quietly ends up offering an
   * action the other does not.
   */
  const ticket = (order: FoodBoardOrderDto) => (
    <OrderCard
      key={order.id}
      order={order}
      station={station}
      drift={drift}
      busy={busyId === order.id}
      onBump={() => order.nextStage && void move(order, order.nextStage)}
      onSendBack={() => void move(order, 'IN_KITCHEN', 'sent back from the pass')}
      onRelease={() => void release(order)}
      onSendOutWithoutPhoto={() => void sendOutWithoutPhoto(order)}
      onPhotoTaken={() => void load()}
      onAskForPayment={() => void askForPayment(order)}
      onConfirmPayment={() => void confirmPayment(order)}
      onTakePayment={() => setPaymentOrderId(order.id)}
      onPrint={(kind) => void print(order, kind)}
      onSendBill={() => void sendBill(order)}
      onCancel={() => void cancelOrder(order)}
      onAcknowledgeQc={() => void acknowledgeQc(order)}
    />
  );

  return (
    // min-w-0 here for the same reason it is on the board below: this page
    // is itself a flex child, and without it the page refuses to shrink
    // below its widest row and overflows the window rather than letting the
    // board scroll inside it.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
      <header className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-display font-semibold text-fg">{businessName?.trim() || 'Kitchen'}</h1>
          <p className="text-caption text-fg-muted">
            {orders === null
              ? 'Loading…'
              : `${stationOrders.length} order${stationOrders.length === 1 ? '' : 's'}${station === null ? ' on the board' : ' here'}`}
            {late > 0 && <span className="ml-2 font-semibold text-error">{late} late</span>}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Two real layouts rather than a setting buried somewhere: which
              one is right depends on the screen this is running on, and the
              person standing at that screen is the one who knows. */}
          {/* Only for a kitchen that has actually assigned stations in the
              menu. Offering the control to one that has not would be a
              filter whose every option is the same board. */}
          {stations.length > 0 && (
            <label className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1.5 text-caption font-medium text-fg">
              <UtensilsCrossed size={14} className="text-fg-muted" aria-hidden />
              <span className="sr-only">Station</span>
              <select
                value={station ?? ''}
                onChange={(event) => setStation(event.target.value === '' ? null : event.target.value)}
                className="bg-transparent text-caption font-medium text-fg focus:outline-none"
              >
                {availableStations.map((option) => (
                  <option key={option ?? 'all'} value={option ?? ''}>
                    {option === null ? 'All stations' : option === UNASSIGNED_STATION ? 'No station set' : option}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="flex items-center rounded-lg border border-border-subtle p-0.5" role="group" aria-label="Board layout">
            <button
              type="button"
              onClick={() => setView('wall')}
              aria-pressed={view === 'wall'}
              title="Every ticket on one wall, oldest first"
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-caption font-medium ${
                view === 'wall' ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:text-fg'
              }`}
            >
              <LayoutGrid size={14} aria-hidden />
              Wall
            </button>
            <button
              type="button"
              onClick={() => setView('stages')}
              aria-pressed={view === 'stages'}
              title="A column per stage, so you can see the pass backing up"
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-caption font-medium ${
                view === 'stages' ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:text-fg'
              }`}
            >
              <Columns3 size={14} aria-hidden />
              Stages
            </button>
          </div>

          {/* Opens beside the board rather than navigating away: the
              orders stay the main thing, which is the whole point of
              putting a conversation next to them. */}
          <button
            type="button"
            onClick={() => {
              if (paneOpen) {
                setChatsOpen(false);
                if (chatId) navigate('/food/operations');
                return;
              }
              setChatsOpen(true);
            }}
            aria-pressed={paneOpen}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-caption font-medium ${
              paneOpen ? 'border-accent/60 bg-accent-soft text-accent' : 'border-border-subtle text-fg hover:bg-surface-2'
            }`}
          >
            <MessageSquare size={14} aria-hidden />
            Chats
          </button>
          <button type="button" onClick={() => void load()} className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2">
            <RotateCcw size={14} aria-hidden />
            Refresh
          </button>
          {/* First of the three, because taking an order is the thing done
              most often at a counter - the menu and the archive are things
              you go and look at.

              Called "Register", not "New order". It was the latter, and the
              person who commissioned this screen could not find the till on
              it - which is the only evidence a label ever needs. "New order"
              names the OUTCOME; somebody looking for a till looks for a
              till, the same word Square and every counter before it uses. */}
          <button
            type="button"
            onClick={() => setRegisterOpen(true)}
            title="Take an order at the counter"
            className="flex items-center gap-1.5 rounded-lg border border-accent/60 bg-accent-soft px-3 py-2 text-caption font-semibold text-accent"
          >
            <Calculator size={14} aria-hidden />
            Register
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
            onClick={() => setHistoryOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2"
          >
            <History size={14} aria-hidden />
            History
          </button>
          <button
            type="button"
            onClick={() => setSummaryOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2"
          >
            <ClipboardList size={14} aria-hidden />
            Today
          </button>
          <button
            type="button"
            onClick={() => setPrinterOpen(true)}
            title="Set up this device's ticket printer"
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2"
          >
            <Printer size={14} aria-hidden />
            Printer
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

      {/* Only where stations are in use: without them every item is
          unrouted and saying so would be noise on every board in the
          product. */}
      {stations.length > 0 && unroutedTickets > 0 && (
        <p className="flex flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-caption text-warning">
          <AlertTriangle size={14} className="shrink-0" aria-hidden />
          {unroutedTickets} order{unroutedTickets === 1 ? ' has an item' : 's have items'} with no station set — they only
          appear under “No station set”.
          <button type="button" onClick={() => setMenuOpen(true)} className="font-semibold underline underline-offset-2">
            Set them in the menu
          </button>
        </p>
      )}

      {/* Over the board, not instead of it: the tickets are still behind
          this, and closing it puts the operator back exactly where they
          were rather than at the top of a board they had scrolled. */}
      {registerOpen && (
        <div className="fixed inset-0 z-40 flex flex-col bg-surface-0">
          <header className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-body font-semibold text-fg">Register</h2>
              <p className="text-meta text-fg-muted">
                Keyed in at the counter. It lands on the board exactly like one taken over WhatsApp.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { setRegisterOpen(false); void load(); }}
              className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2"
            >
              <X size={14} aria-hidden />
              Back to the board
            </button>
          </header>
          {/* Refreshes the board as each order is taken, so the ticket the
              cashier just created is behind them when they close this. */}
          <Register onOrderTaken={() => void load()} />
        </div>
      )}

      {summaryOpen && (
        <div data-print-sheet className="fixed inset-0 z-40 flex flex-col bg-surface-0">
          <header className="flex items-center gap-3 border-b border-border-subtle px-4 py-3 print:hidden">
            <div className="min-w-0">
              <h2 className="text-body font-semibold text-fg">Today</h2>
              <p className="text-meta text-fg-muted">
                What happened this service, on your own day and your own clock — and what is still owed.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSummaryOpen(false)}
              className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2"
            >
              <X size={14} aria-hidden />
              Back to the board
            </button>
          </header>
          <ServiceSummary />
        </div>
      )}

      {printerOpen && <PrinterSettingsPanel onClose={() => setPrinterOpen(false)} />}

      {paymentOrder && (
        <FoodPaymentPanel order={paymentOrder} onClose={() => setPaymentOrderId(null)} onChanged={load} />
      )}

      {historyOpen && (
        <div data-print-sheet className="fixed inset-0 z-40 flex flex-col bg-surface-0">
          <header className="flex items-center gap-3 border-b border-border-subtle px-4 py-3 print:hidden">
            <div className="min-w-0">
              <h2 className="text-body font-semibold text-fg">Past orders</h2>
              <p className="text-meta text-fg-muted">
                Everything finished with, newest first. Search by number, customer, phone, or something that was in it.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setHistoryOpen(false)}
              className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2"
            >
              <X size={14} aria-hidden />
              Back to the board
            </button>
          </header>
          <OrderHistory />
        </div>
      )}

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
              <p className="text-meta text-fg-muted">Who takes the orders, and how they behave. Your agent's name and tone live on the Agents page.</p>
            </div>
            <button type="button" onClick={() => setSettingsOpen(false)} aria-label="Close setup" className="rounded-md p-1 text-fg-muted hover:bg-surface-2 hover:text-fg">
              <X size={16} aria-hidden />
            </button>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="max-w-xl space-y-6">
              <KitchenSettings />
              <PaymentMethods />
            </div>
            <div className="max-w-xl space-y-6">
              <DriverRoster />
              <CustomerUpdates />
            </div>
          </div>
        </section>
      )}

      {/* Orders and the conversation, side by side.
          The board keeps the space it had and the chat takes what is left,
          because the orders are the main thing and a chat pane that
          squeezes the columns would invert that. On a narrow screen the
          two cannot share a row, so an open conversation takes the screen
          and closing it returns to the board. */}
      <div className="flex min-h-0 flex-1">
      {/* min-w-0 is load-bearing.
          A flex item defaults to min-width:auto, which means it refuses to
          shrink below its own content - and the stage board's five columns
          are 85rem of content. Without this the board pushed the chat pane
          clean off the right edge of the screen instead of scrolling
          itself, which is exactly what its own overflow-x-auto is for. */}
      <div className={`min-h-0 min-w-0 flex-1 ${view === 'wall' ? 'overflow-y-auto' : 'overflow-x-auto'} ${paneOpen ? 'hidden lg:block' : ''}`}>
        {/* Instead of the board, never alongside it: rendering both put
            "Nothing on the board" above five empty columns, which reads as
            two screens stacked on top of each other. */}
        {orders !== null && orders.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center text-fg-muted">
            <ChefHat size={32} strokeWidth={1.25} className="mb-3 opacity-40" aria-hidden />
            <p className="text-body font-medium text-fg">Nothing on the board</p>
            <p className="mt-1 max-w-sm text-caption">
              Orders appear here the moment one is taken — from a WhatsApp conversation or keyed in at the counter.
            </p>
            {/* An empty board is exactly where somebody is asking "so how do
                I start one?", and the answer was a button in a row of nine
                along the top. Put it where the question is asked. */}
            <button
              type="button"
              onClick={() => setRegisterOpen(true)}
              className="mt-4 flex items-center gap-1.5 rounded-lg border border-accent/60 bg-accent-soft px-4 py-2.5 text-caption font-semibold text-accent"
            >
              <Calculator size={14} aria-hidden />
              Open the register
            </button>
          </div>
        ) : view === 'wall' ? (
          /**
           * Every live ticket on one wall, oldest first.
           *
           * auto-fill with a minimum rather than a fixed column count, so the
           * board genuinely fits whatever it is opened on: one ticket wide on
           * a phone, two on a tablet held upright, six on the screen over the
           * pass. The stage board below can only ever be five fixed columns
           * wide - about 1500px - which is why it used to run off the side of
           * anything smaller and cut tickets in half.
           */
          <div className="grid gap-3 p-3 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">
            {wallOrders.map(ticket)}
          </div>
        ) : (
        <div className="flex h-full gap-3 p-3">
          {COLUMNS.map((column) => {
            const columnOrders = byStage.get(column.stage) ?? [];
            const Icon = column.icon;
            return (
              <section key={column.stage} className="flex w-[17rem] shrink-0 grow basis-[17rem] flex-col rounded-xl border border-border-subtle bg-surface-1">
                <div className="border-b border-border-subtle px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-caption font-semibold text-fg">
                    <Icon size={14} aria-hidden />
                    {column.label}
                    <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-meta text-fg-muted">{columnOrders.length}</span>
                  </p>
                  <p className="mt-0.5 text-meta text-fg-muted">{column.hint}</p>
                </div>

                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                  {columnOrders.map(ticket)}
                </div>
              </section>
            );
          })}
        </div>
        )}
      </div>

      {paneOpen && (
        <aside className="flex min-h-0 w-full shrink-0 flex-col border-l border-border-subtle lg:w-[26rem] xl:w-[30rem]">
          {chatId ? (
            <>
              <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
                <button
                  type="button"
                  onClick={() => navigate('/food/operations')}
                  className="flex items-center gap-1 text-meta font-medium text-fg-muted hover:text-fg"
                >
                  <ChevronLeft size={12} aria-hidden />
                  All chats
                </button>
                <button
                  type="button"
                  onClick={() => { setChatsOpen(false); navigate('/food/operations'); }}
                  aria-label="Close the chat pane"
                  className="ml-auto rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg"
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
              <div className="flex min-h-0 flex-1">
                {/* Reads the conversation from the route, exactly as it
                    does on the Chats page - so it behaves identically
                    here without a line of its own changing. */}
                <ChatThread />
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
                <p className="text-caption font-semibold text-fg">Chats</p>
                <button
                  type="button"
                  onClick={() => setChatsOpen(false)}
                  aria-label="Close the chat pane"
                  className="ml-auto rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg"
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
              <ChatListPane className="flex min-h-0 flex-1" />
            </>
          )}
        </aside>
      )}
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
  order, station, drift, busy, onBump, onSendBack, onRelease, onSendOutWithoutPhoto, onPhotoTaken, onAskForPayment, onConfirmPayment, onTakePayment, onPrint, onSendBill, onCancel, onAcknowledgeQc,
}: {
  order: FoodBoardOrderDto;
  /** Which station this screen is for, so a line can say whether it is this cook's job. Null on the whole board, where every line is. */
  station: StationSelection;
  drift: number;
  busy: boolean;
  onBump: () => void;
  onSendBack: () => void;
  onRelease: () => void;
  onSendOutWithoutPhoto: () => void;
  onPhotoTaken: () => void;
  onAskForPayment: () => void;
  onConfirmPayment: () => void;
  onTakePayment: () => void;
  onPrint: (kind: 'kitchen' | 'receipt') => void;
  /** Sends the customer their itemised bill on the conversation the order came from. */
  onSendBill: () => void;
  /** Cancels the order. Terminal - hence the confirmation at the call site. */
  onCancel: () => void;
  /** Somebody looked at what the photo flagged and is saying so. */
  onAcknowledgeQc: () => void;
}) {
  /**
   * What the ticket is called.
   *
   * A dine-in order is the table - that is how it is called out and how it
   * is carried. Everything else is the person, because a collection ticket
   * is handed to somebody by name. The order number is the fallback and
   * never a guess at either: an order taken without a name really has no
   * name, and inventing one on a kitchen screen would be a lie somebody
   * shouts across a room.
   */
  const title =
    (order.fulfilmentMethod === 'DINE_IN' ? order.tableLabel?.trim() : null) ||
    order.customerName?.trim() ||
    `Order #${order.orderNumber}`;
  /** Who it is for, when the band is showing their table instead of their name. */
  const subtitle = order.customerName?.trim() && order.customerName.trim() !== title ? order.customerName.trim() : null;
  const placedTime = new Date(order.placedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  /**
   * Folded down to its band and its buttons.
   *
   * Per ticket and per screen, deliberately not stored: a cook folding the
   * ticket they are working on is saying something about this minute, not
   * setting a preference, and a board that remembered it would hide a new
   * ticket's contents from the next person to walk up to the pass.
   */
  const [collapsed, setCollapsed] = useState(false);

  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-1">
      {/* The band carries the two things somebody reads from across the
          room - who it is for, and how long it has been - and nothing else.
          Its colour is the SLA, which is why it is the whole width rather
          than a tint on a border. */}
      <div
        className={`px-2.5 py-1.5 text-kds-band-fg ${
          /* A ticket waiting on the customer's money gets its own colour and
             its own words. It is not ON_TIME - its clock has not started -
             and it is certainly not late. Showing green would say the
             kitchen is fine when the kitchen has not been given the job;
             showing red would blame it for somebody else's delay. */
          order.waitingForPayment ? 'bg-kds-waiting' : SLA_BAND[order.slaBand]
        }`}
      >
        <div className="flex items-baseline gap-2">
          <span className="truncate text-body font-bold">{title}</span>
          <span className="ml-auto shrink-0 font-mono text-body font-bold tabular-nums">
            {order.waitingForPayment ? 'WAITING' : clock(order.elapsedSeconds + drift)}
          </span>
        </div>
        <div className="flex items-baseline gap-2 text-meta font-medium opacity-70">
          <span>#{order.orderNumber}</span>
          <span>{placedTime}</span>
          {/* The stage, on the ticket, because the wall has no columns to
              say it - and on the stage board it costs one line to stay
              right rather than two components to keep in step. */}
          <span className="ml-auto truncate">
            {order.waitingForPayment ? 'Waiting on payment' : STAGE_LABEL[order.stage]}
          </span>
          {/* Folds the ticket down to its band and its buttons.
              A board in the middle of service has more tickets than screen,
              and the ones already being cooked do not need their contents
              read again - what still matters about them is who, how long,
              and whether anything on them can hurt somebody. All three stay
              visible folded, and so does every action, so nothing has to be
              unfolded to be dealt with. */}
          <button
            type="button"
            onClick={() => setCollapsed((current) => !current)}
            title={collapsed ? 'Show the whole ticket' : 'Fold this ticket down'}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Show order ${order.orderNumber} in full` : `Fold order ${order.orderNumber} down`}
            className="-my-1 shrink-0 rounded p-1 opacity-70 hover:opacity-100"
          >
            {collapsed ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle px-2.5 py-1.5">
        <span className={`rounded px-2 py-0.5 text-meta font-bold uppercase tracking-wide ${FULFILMENT_CHIP[order.fulfilmentMethod].className}`}>
          {order.fulfilmentMethod === 'DINE_IN' && order.tableLabel && order.tableLabel !== title
            ? order.tableLabel
            : FULFILMENT_CHIP[order.fulfilmentMethod].label}
        </span>
        {/* Whose order it is, when the band is showing the table instead. */}
        {subtitle && <span className="truncate text-meta font-medium text-fg-secondary">{subtitle}</span>}
        {/* Folded, the one thing lost is the food itself - so the count of
            it stays, which is enough to tell a two-item ticket from a
            fifteen-item one without opening it. */}
        {collapsed && (
          <span className="ml-auto shrink-0 text-meta font-medium text-fg-muted">
            {order.items.length} {order.items.length === 1 ? 'item' : 'items'}
          </span>
        )}
      </div>

      <div className="p-2.5">

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

      {/* Asking for the money, and confirming it came.
          Only while the order is genuinely unpaid - a paid ticket showing
          a "chase the money" button is a button somebody will eventually
          press by mistake. */}
      {(order.paymentState === 'UNPAID' || order.paymentState === 'AWAITING_VERIFICATION') && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {order.paymentRequest && !order.paymentRequest.confirmedAt ? (
            <>
              <span className="text-meta text-fg-muted">
                Asked {new Date(order.paymentRequest.requestedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={onConfirmPayment}
                className="flex items-center gap-1 rounded-md bg-success/90 px-2 py-1 text-meta font-semibold text-white hover:bg-success disabled:opacity-50"
              >
                <HandCoins size={11} aria-hidden />
                Payment received
              </button>
              {/* A second ask is a chase, which is a normal thing to do
                  once and an annoying thing to do four times - so it is
                  quiet rather than prominent. */}
              <button
                type="button"
                disabled={busy}
                onClick={onAskForPayment}
                className="text-meta text-fg-muted hover:text-fg disabled:opacity-50"
              >
                Ask again
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              /* Asking needs somebody to ask. A counter order has no chat by
                 definition, so the only honest button on it is the one that
                 records the cash actually handed over. */
              onClick={order.chatId ? onAskForPayment : onTakePayment}
              className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-meta font-medium text-fg hover:bg-surface-2 disabled:opacity-50"
            >
              {order.chatId ? <Send size={11} aria-hidden /> : <HandCoins size={11} aria-hidden />}
              {order.chatId ? 'Ask for payment' : 'Take payment'}
            </button>
          )}
          {/* The till, for money that arrived some other way than the one
              that was asked for - cash at the door on an order that was
              sent a transfer request, a card tapped at the counter. */}
          {order.chatId && (
            <button
              type="button"
              disabled={busy}
              onClick={onTakePayment}
              className="text-meta text-fg-muted hover:text-fg disabled:opacity-50"
            >
              Take payment
            </button>
          )}
        </div>
      )}

      {/* Paper, on demand.
          Two documents because they are two different things: the kitchen's
          copy has the food and no prices, the customer's has the money and
          the business's details. A receipt is offered only once there is
          something to receipt - printing one for an order nobody has paid
          for hands somebody a document saying they did. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onPrint('kitchen')}
          className="flex items-center gap-1 text-meta text-fg-muted hover:text-fg disabled:opacity-50"
        >
          <Printer size={11} aria-hidden />
          Ticket
        </button>
        {(order.paymentState === 'PAID' || order.paymentState === 'NOT_REQUIRED' || order.paymentState === 'WAIVED') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onPrint('receipt')}
            className="flex items-center gap-1 text-meta text-fg-muted hover:text-fg disabled:opacity-50"
          >
            <Receipt size={11} aria-hidden />
            Receipt
          </button>
        )}

        {/* The same bill, sent rather than printed.
            Somebody who ordered over chat has no counter to stand at and no
            paper to be handed - the conversation is their till roll. Only
            offered where there IS a conversation: a counter sale has none,
            and a button that cannot work is worse than no button. */}
        {order.chatId && (
          <button
            type="button"
            disabled={busy}
            onClick={onSendBill}
            title="Send this customer their bill on WhatsApp"
            className="flex items-center gap-1 text-meta text-fg-muted hover:text-fg disabled:opacity-50"
          >
            <Send size={11} aria-hidden />
            Send bill
          </button>
        )}

        {/* Cancelling. Last, quiet, and on the right, because it is the one
            action here that cannot be undone - CANCELLED is a terminal
            stage with nowhere to go from it (see orderLifecycle). Hidden
            once an order is closed, since there is nothing left to cancel. */}
        {order.stage !== 'COMPLETED' && order.stage !== 'CANCELLED' && (
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            title="Cancel this order"
            className="ml-auto flex items-center gap-1 text-meta text-fg-muted hover:text-error disabled:opacity-50"
          >
            <X size={11} aria-hidden />
            Cancel
          </button>
        )}
      </div>

      {/* Settled money is still something somebody may have to correct - a
          refund given at the door, a payment recorded against the wrong
          ticket. Quiet, because on a paid order it is the exception. */}
      {(order.paymentState === 'PAID' || order.paymentState === 'REFUNDED') && (
        <button
          type="button"
          disabled={busy}
          onClick={onTakePayment}
          className="mt-1 text-meta text-fg-muted hover:text-fg disabled:opacity-50"
        >
          Payment details
        </button>
      )}

      {/* The allergen banner is full width and loud on purpose - it is the
          one thing on this card that can hurt somebody. */}
      {order.allergenNotes && (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-error/20 px-2 py-1 text-caption font-semibold text-error">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
          {order.allergenNotes}
        </p>
      )}

      {/* The food itself is the bulk of a ticket and the only thing folding
          hides. The allergen banner above stays whatever happens - it is
          the one thing on this card that can hurt somebody, and a warning
          that can be folded away is a warning nobody can rely on. */}
      {!collapsed && (
      <ul className="space-y-1.5">
        {order.items.map((item, index) => {
          // Someone else's job on a ticket this station is also on. Dimmed
          // rather than removed: a cook should be able to see the whole
          // order they are contributing to, and a hidden line is a line
          // somebody assumes is already handled.
          const mine = lineIsForStation(item, station);
          return (
          <li key={`${item.name}-${index}`} className={`flex gap-2 ${mine ? '' : 'opacity-45'}`}>
            {/* The count in a solid block rather than "2×" inline: on a
                ticket read at speed the number of things to make is the
                one figure that must not be skimmed past. */}
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-meta font-bold tabular-nums ${
                mine ? 'bg-fg text-surface-1' : 'border border-border-subtle text-fg-muted'
              }`}
            >
              {item.quantity}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-caption font-semibold leading-tight text-fg">
                {item.name}
                {item.variant && <span className="font-normal text-fg-secondary"> · {item.variant}</span>}
                {/* Whose job it is, said only where that is a live question -
                    never on the whole board, where it would be on every line. */}
                {!mine && item.station && (
                  <span className="ml-1 font-normal text-meta text-fg-muted">({item.station})</span>
                )}
              </p>
              {/* Modifiers indented under their item, one per line, the way
                  a kitchen screen has always shown them - a wrapped row of
                  pills reads as a group and loses which item it belongs to.
                  A removal stays red: "no peanuts" sharing a colour with
                  "extra cheese" is the one confusion here that can hurt
                  somebody. */}
              {item.modifiers.map((modifier, modifierIndex) => (
                <p
                  key={`${modifier.name}-${modifierIndex}`}
                  className={`text-caption leading-tight ${
                    modifier.action === 'remove' ? 'font-semibold text-error' : 'text-info'
                  }`}
                >
                  {modifier.action === 'remove' ? 'no ' : modifier.action === 'on_side' ? 'side: ' : ''}
                  {modifier.name}
                </p>
              ))}
              {item.notes && <p className="text-meta italic leading-tight text-fg-muted">{item.notes}</p>}
            </div>
          </li>
          );
        })}
      </ul>
      )}

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
          {/* Somebody saying they looked.
              Without this the warning stayed on the ticket forever - the
              board could raise a finding and had no way to be told it had
              been dealt with, so a flag people could not clear became a
              flag people stopped reading. Only offered while it is still
              outstanding; a cleared check needs no button. */}
          {!order.qcAcknowledgedAt && order.qcCheckId && (
            <button
              type="button"
              disabled={busy}
              onClick={onAcknowledgeQc}
              className="mt-1.5 flex items-center gap-1 rounded-md border border-warning/60 px-2 py-1 text-meta font-semibold text-warning hover:bg-warning/10 disabled:opacity-50"
            >
              <Check size={11} aria-hidden />
              I checked it
            </button>
          )}
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

        {/* Opens beside the board, not instead of it. A ticket and the
            conversation it came from belong next to each other, and
            navigating away to read one loses the other. */}
        {order.chatId && (
          <Link
            to={`/food/operations/chat/${order.chatId}`}
            className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-meta font-medium text-fg hover:bg-surface-2"
            title="Open the conversation this order came from, beside the board"
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
      </div>
    </article>
  );
}
