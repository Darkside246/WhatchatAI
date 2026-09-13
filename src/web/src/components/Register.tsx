import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calculator, ChevronLeft, Loader2, Search, Trash2, X } from 'lucide-react';
import {
  api,
  ApiError,
  type FoodMenuCategoryDto,
  type FoodMenuItemDto,
  type FoodOrderProposalDto,
  type FoodProposedLineDto,
  type FoodQuoteDto,
  type FoodSettingsDto,
} from '../lib/api.js';
import { basketLineKey } from '../lib/basket.js';
import { useAuth } from '../hooks/useAuth.js';
import { changeDue, keypadDigitsToCents, quickTenderOptions } from '../lib/tillMath.js';

/**
 * The counter till.
 *
 * Three columns, the way every register since the first one has been laid
 * out: what you can sell on the left and middle, what is being sold on the
 * right. Nothing here is novel and that is the point - somebody who has used
 * a till before should not have to be taught this one.
 *
 * THE RULE THIS SCREEN IS BUILT AROUND: the browser never works out a price.
 * The basket holds references and quantities; every figure on screen comes
 * back from /orders/quote, which prices against the live catalogue exactly
 * as it does for the AI taking an order over WhatsApp. A till that does its
 * own arithmetic will one day disagree with the kitchen ticket, and when it
 * does the customer will be right and the shop will have no idea why.
 *
 * The schema anticipated this screen from the beginning - food_orders.chat_id
 * is nullable "because an order can also be keyed in by hand at the counter"
 * - and until now there was no way to key one in.
 */

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

/** One basket line. Modifiers are part of its identity - "burger, no onions" is not the same line as "burger". */
interface BasketLine {
  key: string;
  /** Null on a hand-keyed amount, which has no menu item by definition. */
  item: FoodMenuItemDto | null;
  /** What the cashier called it. Only on a hand-keyed amount. */
  customName?: string;
  /** The amount typed on the keypad, in cents. Only on a hand-keyed amount. */
  customAmountCents?: number;
  quantity: number;
  /**
   * `quantity` is how many of that extra - "two extra sauces" is 2. It is
   * part of the line's identity for the same reason the modifier itself is:
   * one sauce and three sauces are different orders and different money.
   * Absent means one, so every basket built before this existed is
   * unchanged.
   */
  modifiers: { name: string; action: 'add' | 'remove' | 'on_side'; quantity?: number }[];
}



export function Register({ onOrderTaken }: { onOrderTaken?: () => void }) {
  /**
   * Whether this person may give money away.
   *
   * Mirrors food.approve in domain/auth/permissions.ts, the same way
   * SettingsRoute mirrors settings.manage: the browser cannot import that
   * table, and the server enforces it regardless - a discount from a role
   * without it is refused with a message saying to ask a manager. This only
   * decides whether the button is offered, so being wrong here costs a
   * confusing 403 rather than an unauthorised discount.
   *
   * AGENT - a cook or a cashier - deliberately does NOT hold it.
   */
  const auth = useAuth();
  const canDiscount = auth.role !== 'AGENT' && auth.role !== 'VIEWER' && auth.role !== 'MARKETING';
  const [menu, setMenu] = useState<FoodMenuItemDto[] | null>(null);
  const [categories, setCategories] = useState<FoodMenuCategoryDto[]>([]);
  const [settings, setSettings] = useState<FoodSettingsDto | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [fulfilment, setFulfilment] = useState<FoodOrderProposalDto['fulfilmentMethod']>('PICKUP');
  const [customerName, setCustomerName] = useState('');
  const [tableLabel, setTableLabel] = useState('');

  const [quote, setQuote] = useState<FoodQuoteDto | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [charging, setCharging] = useState(false);
  const [taken, setTaken] = useState<{ orderNumber: number } | null>(null);
  /** Chosen per basket, so a double-tapped Charge is one ticket and one plate of food. */
  const idempotencyKey = useRef(crypto.randomUUID());
  const quoteRequest = useRef(0);

  /** Which item's modifiers are being chosen, before it can land in the basket. */
  const [choosingFor, setChoosingFor] = useState<FoodMenuItemDto | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [menuResult, categoryResult, settingsResult] = await Promise.all([
          api.getFoodMenu(),
          api.listFoodMenuCategories(),
          api.getFoodSettings(),
        ]);
        setMenu(menuResult.items);
        setCategories(categoryResult.categories);
        setSettings(settingsResult.settings);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load the menu.');
        setMenu([]);
      }
    })();
  }, []);

  /**
   * Money off this sale, as it was TYPED.
   *
   * Held as the shape somebody entered rather than as a resolved amount,
   * so a discount applied before another item is added still means what
   * they said: "ten per cent off" stays ten per cent when the basket grows.
   * The server turns it into the amount it stores - see
   * ProposedLine.discountPercent for why the amount is the truth once the
   * order exists.
   */
  const [discount, setDiscount] = useState<{ kind: 'amount' | 'percent'; value: number; reason: string } | null>(null);

  const proposal = useMemo<FoodOrderProposalDto>(() => {
    const lines: FoodProposedLineDto[] = basket.map((line) => ({
      // By name, because that is what the server's resolver matches on and
      // what ends up written on the ticket the kitchen reads.
      reference: line.item?.name ?? line.customName ?? 'Custom amount',
      quantity: line.quantity,
      ...(line.modifiers.length > 0 ? { modifiers: line.modifiers } : {}),
      // The one price this screen ever sends, and only for a line that has
      // no menu item to be priced from. See ProposedLine.customAmountCents.
      ...(line.customAmountCents !== undefined ? { customAmountCents: line.customAmountCents } : {}),
    }));
    return {
      fulfilmentMethod: fulfilment,
      lines,
      ...(customerName.trim() ? { customerName: customerName.trim() } : {}),
      ...(fulfilment === 'DINE_IN' && tableLabel.trim() ? { tableLabel: tableLabel.trim() } : {}),
      /* A percentage goes as a percentage. The SERVER converts it against
         the subtotal it works out - this screen never multiplies a price,
         and that promise is the whole reason the field exists. */
      ...(discount?.kind === 'percent' ? { discountPercent: discount.value } : {}),
      ...(discount?.kind === 'amount' ? { discountCents: discount.value } : {}),
      ...(discount?.reason ? { discountReason: discount.reason } : {}),
    };
  }, [basket, fulfilment, customerName, tableLabel, discount]);

  /**
   * Re-priced on every change, debounced.
   *
   * Only the newest request may write: tapping an item four times quickly
   * puts four quotes in flight, and the slowest landing last would leave the
   * total for three items on screen above a basket of four.
   */
  useEffect(() => {
    if (basket.length === 0) {
      setQuote(null);
      return;
    }
    const id = quoteRequest.current + 1;
    quoteRequest.current = id;
    setQuoting(true);

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.quoteFoodOrder(proposal);
          if (quoteRequest.current !== id) return;
          setQuote(result.quote);
          setError(null);
        } catch (err) {
          if (quoteRequest.current !== id) return;
          setQuote(null);
          setError(err instanceof ApiError ? err.message : 'Could not price this order.');
        } finally {
          if (quoteRequest.current === id) setQuoting(false);
        }
      })();
    }, 150);

    return () => clearTimeout(timer);
  }, [proposal, basket.length]);

  /**
   * The keypad, in place of the item grid.
   *
   * A mode rather than a dialog, because it is the other half of the same
   * screen: somebody switches to it, rings a bag, and switches back. A
   * dialog floating over a grid they cannot use is just a grid they cannot
   * use.
   */
  const [padOpen, setPadOpen] = useState(false);


  /**
   * Rings something the menu does not sell.
   *
   * Held as its own kind of basket line - no menu item, the amount typed -
   * so nothing downstream mistakes it for a dish. The server rings it the
   * same way, with menuItemId null, which is what a hand-keyed line already
   * is on the board.
   */
  const addCustomAmount = useCallback((name: string, amountCents: number) => {
    setTaken(null);
    setBasket((current) => [
      ...current,
      {
        // Its own identity every time, deliberately: two bags rung
        // separately at different prices are two lines, and a cashier who
        // rings a second one is not correcting the first.
        key: `custom:${Date.now()}:${name}:${amountCents}`,
        item: null,
        customName: name,
        customAmountCents: amountCents,
        quantity: 1,
        modifiers: [],
      },
    ]);
  }, []);

  const addToBasket = useCallback((item: FoodMenuItemDto, modifiers: BasketLine['modifiers'] = []) => {
    setTaken(null);
    const key = basketLineKey(item.id, modifiers);
    setBasket((current) => {
      const existing = current.find((line) => line.key === key);
      if (existing) return current.map((line) => (line.key === key ? { ...line, quantity: line.quantity + 1 } : line));
      return [...current, { key, item, quantity: 1, modifiers }];
    });
  }, []);

  function changeQuantity(key: string, delta: number) {
    setBasket((current) =>
      current
        .map((line) => (line.key === key ? { ...line, quantity: line.quantity + delta } : line))
        .filter((line) => line.quantity > 0),
    );
  }

  function clearBasket() {
    setBasket([]);
    setQuote(null);
    setCustomerName('');
    setTableLabel('');
    // A discount belongs to the sale it was given on. Carrying it into the
    // next customer is the kind of mistake nobody finds until the drawer is
    // counted, and it would be silent every single time.
    setDiscount(null);
    setError(null);
    idempotencyKey.current = crypto.randomUUID();
  }

  async function charge() {
    if (basket.length === 0 || charging) return;
    setCharging(true);
    setError(null);
    try {
      const result = await api.confirmFoodOrder({ ...proposal, idempotencyKey: idempotencyKey.current });
      setTaken({ orderNumber: result.order.orderNumber });
      clearBasket();
      onOrderTaken?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not take that order.');
    } finally {
      setCharging(false);
    }
  }

  const visible = useMemo(() => {
    const wanted = search.trim().toLowerCase();
    return (menu ?? []).filter((item) => {
      if (categoryId && item.categoryId !== categoryId) return false;
      if (!wanted) return true;
      return (
        item.name.toLowerCase().includes(wanted) ||
        item.aliases.some((alias) => alias.toLowerCase().includes(wanted))
      );
    });
  }, [menu, categoryId, search]);

  const currency = quote?.currency ?? menu?.[0]?.currency ?? 'USD';

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      {/* ── Categories ── */}
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border-subtle bg-surface-2 p-2 lg:w-44 lg:flex-col lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <button
          type="button"
          onClick={() => setCategoryId(null)}
          className={`shrink-0 rounded-lg px-3 py-2.5 text-left text-caption font-medium ${
            categoryId === null ? 'bg-accent text-white' : 'text-fg hover:bg-surface-3'
          }`}
        >
          All items
        </button>
        {categories.map((category) => (
          <button
            key={category.id}
            type="button"
            onClick={() => setCategoryId(category.id)}
            className={`shrink-0 rounded-lg px-3 py-2.5 text-left text-caption font-medium ${
              categoryId === category.id ? 'bg-accent text-white' : 'text-fg hover:bg-surface-3'
            }`}
          >
            {category.name}
          </button>
        ))}
      </nav>

      {/* ── Items ── */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle p-2">
          <div className="relative min-w-0 flex-1">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted" aria-hidden />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search the menu…"
              aria-label="Search the menu"
              className="w-full rounded-lg border border-border-subtle bg-surface-2 py-2 pl-8 pr-3 text-caption text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
            />
          </div>
          {/* The way in to the keypad, beside the search, because both are
              "I cannot find it by tapping" and that is the moment somebody
              reaches for either. */}
          <button
            type="button"
            onClick={() => setPadOpen((open) => !open)}
            aria-pressed={padOpen}
            title="Ring a price for something not on the menu"
            className={`flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-caption font-semibold ${
              padOpen ? 'border-accent bg-accent-soft text-accent' : 'border-border-subtle text-fg hover:bg-surface-2'
            }`}
          >
            <Calculator size={14} aria-hidden />
            Keypad
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {padOpen ? (
            <AmountPad
              currency={currency}
              onAdd={addCustomAmount}
              // Straight back to the tiles. Ringing a bag is a detour, not
              // a destination.
              onBack={() => setPadOpen(false)}
            />
          ) : (
            <>
          {menu === null && <p className="p-4 text-caption text-fg-muted">Loading the menu…</p>}
          {menu !== null && menu.length === 0 && (
            <p className="p-4 text-caption text-fg-muted">
              No menu yet. Add items under Menu and they appear here straight away.
            </p>
          )}
          {menu !== null && menu.length > 0 && visible.length === 0 && (
            <p className="p-4 text-caption text-fg-muted">Nothing matches.</p>
          )}

          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr))]">
            {visible.map((item) => (
              <button
                key={item.id}
                type="button"
                // Sold out is shown, not hidden: a cashier who cannot see an
                // item cannot tell a customer it has run out, and would sound
                // as though the shop had never heard of it.
                disabled={!item.available}
                onClick={() => (item.modifierGroups.length > 0 ? setChoosingFor(item) : addToBasket(item))}
                className={`flex min-h-[5.5rem] flex-col justify-between rounded-xl border p-2.5 text-left transition ${
                  item.available
                    ? 'border-border-subtle bg-surface-1 hover:border-accent hover:bg-accent-soft'
                    : 'cursor-not-allowed border-border-subtle bg-surface-2 opacity-50'
                }`}
              >
                <span className="text-caption font-semibold leading-tight text-fg">{item.name}</span>
                <span className="mt-1 text-caption tabular-nums text-fg-secondary">
                  {item.available ? money(item.priceCents, item.currency) : 'Sold out'}
                </span>
              </button>
            ))}
          </div>
            </>
          )}
        </div>
      </div>

      {/* ── Current sale ── */}
      <aside className="flex shrink-0 flex-col border-t border-border-subtle bg-surface-1 lg:w-80 lg:border-l lg:border-t-0 xl:w-96">
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
          <p className="text-caption font-semibold text-fg">Current sale</p>
          {basket.length > 0 && (
            <button
              type="button"
              onClick={clearBasket}
              className="ml-auto flex items-center gap-1 text-meta text-fg-muted hover:text-error"
            >
              <Trash2 size={12} aria-hidden />
              Clear
            </button>
          )}
        </div>

        {taken && (
          <p className="border-b border-success/30 bg-success/10 px-3 py-2 text-caption font-medium text-success">
            Order #{taken.orderNumber} is on the board.
          </p>
        )}
        {error && <p className="border-b border-error/30 bg-error/10 px-3 py-2 text-caption text-error">{error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {basket.length === 0 && <p className="p-4 text-caption text-fg-muted">Tap an item to start.</p>}

          <ul>
            {basket.map((line) => {
              // A hand-keyed amount has no menu item, so its name is the one
              // the cashier typed.
              const label = line.item?.name ?? line.customName ?? 'Custom amount';
              return (
              <li key={line.key} className="flex items-start gap-2 border-b border-border-subtle px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-caption font-medium text-fg">{label}</p>
                  {/* Said on the line, because a hand-keyed price is the one
                      figure on this screen a person chose rather than the
                      catalogue - and the one somebody will want to check. */}
                  {line.customAmountCents !== undefined && (
                    <p className="text-meta text-fg-muted">Typed in · {money(line.customAmountCents, currency)}</p>
                  )}
                  {line.modifiers.map((modifier) => (
                    <p
                      key={modifier.name}
                      className={`text-meta leading-tight ${modifier.action === 'remove' ? 'font-semibold text-error' : 'text-info'}`}
                    >
                      {modifier.action === 'remove' ? 'no ' : modifier.action === 'on_side' ? 'side: ' : ''}
                      {modifier.name}
                    </p>
                  ))}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => changeQuantity(line.key, -1)}
                    aria-label={`One fewer ${label}`}
                    className="h-7 w-7 rounded border border-border-subtle text-fg-muted hover:text-fg"
                  >
                    −
                  </button>
                  <span className="w-6 text-center text-caption font-semibold tabular-nums text-fg">{line.quantity}</span>
                  <button
                    type="button"
                    onClick={() => changeQuantity(line.key, 1)}
                    aria-label={`One more ${label}`}
                    className="h-7 w-7 rounded border border-border-subtle text-fg-muted hover:text-fg"
                  >
                    +
                  </button>
                </div>
              </li>
              );
            })}
          </ul>
        </div>

        {basket.length > 0 && (
          <div className="shrink-0 space-y-2 border-t border-border-subtle p-3">
            <div className="flex gap-1">
              {(['PICKUP', 'DINE_IN', 'DELIVERY'] as const)
                // Table service is a setting a business turns on. Offering a
                // table on a counter that has none is a field somebody fills
                // in wrongly.
                .filter((method) => method !== 'DINE_IN' || settings?.tableServiceEnabled)
                .map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setFulfilment(method)}
                    className={`flex-1 rounded-lg px-2 py-1.5 text-meta font-semibold ${
                      fulfilment === method ? 'bg-accent text-white' : 'bg-surface-2 text-fg-secondary hover:text-fg'
                    }`}
                  >
                    {method === 'PICKUP' ? 'Collection' : method === 'DINE_IN' ? 'For here' : 'Delivery'}
                  </button>
                ))}
            </div>

            <input
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              placeholder="Name (so it can be called out)"
              aria-label="Customer name"
              className="w-full rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-caption text-fg placeholder:text-fg-muted"
            />
            {fulfilment === 'DINE_IN' && (
              <input
                value={tableLabel}
                onChange={(event) => setTableLabel(event.target.value)}
                placeholder="Table"
                aria-label="Table"
                className="w-full rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-caption text-fg placeholder:text-fg-muted"
              />
            )}

            {/* Every figure here came back from the server. Nothing on this
                screen multiplies a price. */}
            <div className="space-y-0.5 text-caption">
              <div className="flex justify-between text-fg-secondary">
                <span>Subtotal</span>
                <span className="tabular-nums">{quote ? money(quote.subtotalCents, currency) : '—'}</span>
              </div>
              {/* Each of these appears only when it is real. A "Discount
                  0.00" row invites the question "why is there a discount",
                  and a tax row on a business that charges none is a claim
                  about their registration that is not ours to make. */}
              {quote && quote.discountCents > 0 && (
                <div className="flex justify-between text-fg-secondary">
                  <span>Discount</span>
                  <span className="tabular-nums">-{money(quote.discountCents, currency)}</span>
                </div>
              )}
              {quote && quote.deliveryFeeCents > 0 && (
                <div className="flex justify-between text-fg-secondary">
                  <span>Delivery</span>
                  <span className="tabular-nums">{money(quote.deliveryFeeCents, currency)}</span>
                </div>
              )}
              {quote && quote.taxCents > 0 && (
                <div className="flex justify-between text-fg-muted">
                  <span>Tax</span>
                  <span className="tabular-nums">{money(quote.taxCents, currency)}</span>
                </div>
              )}
            </div>

            {/* Counting change.
                Offered only once there is something to count against - a
                cash panel over an unknown total is a till doing arithmetic
                on a number it does not have. */}
            <DiscountPad
              currency={currency}
              discount={discount}
              canDiscount={canDiscount}
              onApply={setDiscount}
              onClear={() => setDiscount(null)}
            />

            {quote && quote.totalCents > 0 && <CashPanel totalCents={quote.totalCents} currency={currency} />}

            <button
              type="button"
              // Never offered over a stale or missing price. A till that can
              // be charged while it does not know the total is a till that
              // will take the wrong money.
              disabled={!quote || quoting || charging}
              onClick={() => void charge()}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent text-body font-semibold text-white disabled:opacity-50"
            >
              {charging || quoting ? (
                <>
                  <Loader2 size={16} className="animate-spin" aria-hidden />
                  {charging ? 'Taking the order…' : 'Pricing…'}
                </>
              ) : (
                <>Take order {quote ? money(quote.totalCents, currency) : ''}</>
              )}
            </button>
          </div>
        )}
      </aside>

      {choosingFor && (
        <ModifierPicker
          item={choosingFor}
          onCancel={() => setChoosingFor(null)}
          onDone={(modifiers) => {
            addToBasket(choosingFor, modifiers);
            setChoosingFor(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Choosing what goes on it, before it reaches the basket.
 *
 * Only shown for an item that genuinely has options - an unnecessary dialog
 * between a cashier and a queue is how a till stops being used.
 */
/**
 * The number pad every till has.
 *
 * Two jobs, and they share a keypad because a cashier's hands already know
 * where the digits are:
 *
 *   Ringing something the menu does not sell - a carrier bag, an extra
 *   cup, a deposit on a tray. Without it the only way to charge for a bag
 *   was to put a bag on the menu.
 *
 *   Counting change.
 *
 * Digits build from the RIGHT, the way a till has worked since the
 * mechanical ones: 1, 5, 0 is one fifty, not a hundred and fifty. Somebody
 * who has used a till will type it that way whatever this app would prefer.
 */
/**
 * Taking money off a sale.
 *
 * Either shape, because both are how people say it: "five dollars off" and
 * "ten per cent off" are the same intention typed two ways, and a till that
 * only takes one makes somebody do arithmetic in front of a queue.
 *
 * A percentage is sent AS a percentage. The server converts it against the
 * subtotal it works out, so this screen keeps its one promise - it never
 * multiplies a price - and so a discount applied before another item is
 * added still means what was said when the basket grows.
 *
 * The reason is asked for and not optional-feeling, because a discount is
 * money leaving the business and the books have to be able to answer "who
 * gave that away, and why" a week later.
 */
function DiscountPad({
  currency,
  discount,
  canDiscount,
  onApply,
  onClear,
}: {
  currency: string;
  discount: { kind: 'amount' | 'percent'; value: number; reason: string } | null;
  /** food.approve. A cashier can ring a sale; giving one away is a different decision. */
  canDiscount: boolean;
  onApply: (next: { kind: 'amount' | 'percent'; value: number; reason: string }) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'amount' | 'percent'>('amount');
  const [digits, setDigits] = useState('');
  const [reason, setReason] = useState('');

  // Percent is typed whole - "10" is ten per cent, not a tenth of one.
  const value = kind === 'amount' ? keypadDigitsToCents(digits) : Math.min(100, Number(digits.slice(0, 3) || 0));

  /* Shown rather than hidden, and disabled with the reason on it.
     Hiding it entirely would mean a cashier never learns the shop can
     discount at all, and asks by shouting across the counter. */
  if (!canDiscount) {
    return (
      <p className="rounded-lg border border-border-subtle px-2.5 py-2 text-center text-meta text-fg-muted">
        Taking money off needs a manager.
      </p>
    );
  }

  if (discount && !open) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-accent/50 bg-accent-soft px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-caption font-medium text-accent">
          {discount.kind === 'percent' ? `${discount.value}% off` : `${money(discount.value, currency)} off`}
          {discount.reason ? ` · ${discount.reason}` : ''}
        </span>
        <button
          type="button"
          onClick={onClear}
          aria-label="Remove the discount"
          className="shrink-0 rounded p-0.5 text-accent hover:opacity-70"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-border-subtle py-2 text-caption font-medium text-fg hover:bg-surface-2"
      >
        Discount
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border-subtle bg-surface-2 p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-caption font-semibold text-fg">Discount</span>
        <button
          type="button"
          onClick={() => { setOpen(false); setDigits(''); setReason(''); }}
          aria-label="Close discount"
          className="ml-auto rounded p-0.5 text-fg-muted hover:text-fg"
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      <div className="flex gap-1">
        {(['amount', 'percent'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => { setKind(option); setDigits(''); }}
            className={`min-h-9 flex-1 rounded-lg border text-caption font-semibold ${
              kind === option ? 'border-accent bg-accent-soft text-accent' : 'border-border-subtle text-fg'
            }`}
          >
            {option === 'amount' ? currency : '%'}
          </button>
        ))}
      </div>

      <output className="block rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-right text-body font-bold tabular-nums text-fg">
        {kind === 'amount' ? money(value, currency) : `${value}%`}
      </output>

      <Keypad digits={digits} onDigits={setDigits} />

      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why? (staff meal, sorry about the wait…)"
        aria-label="Why this discount is being given"
        className="w-full rounded-lg border border-border-subtle bg-surface-1 px-2.5 py-2 text-caption text-fg placeholder:text-fg-muted"
      />

      <button
        type="button"
        disabled={value <= 0}
        onClick={() => {
          onApply({ kind, value, reason: reason.trim() });
          setOpen(false);
          setDigits('');
          setReason('');
        }}
        className="min-h-10 w-full rounded-lg bg-accent text-caption font-semibold text-white disabled:opacity-50"
      >
        Take it off
      </button>
    </div>
  );
}

function Keypad({ digits, onDigits, disabled }: { digits: string; onDigits: (next: string) => void; disabled?: boolean }) {
  const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'];

  function press(key: string) {
    if (key === '⌫') return onDigits(digits.slice(0, -1));
    // Capped so a stuck key cannot build a number nobody could have meant.
    if (digits.length >= 9) return;
    onDigits(`${digits}${key}`);
  }

  return (
    <div className="grid grid-cols-3 gap-1.5">
      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          disabled={disabled}
          onClick={() => press(key)}
          aria-label={key === '⌫' ? 'Delete the last digit' : key}
          className="min-h-12 rounded-lg border border-border-subtle bg-surface-1 text-body font-semibold text-fg hover:bg-surface-2 active:bg-surface-3 disabled:opacity-50"
        >
          {key}
        </button>
      ))}
    </div>
  );
}

/**
 * Ringing a price for something that is not on the menu.
 *
 * Replaces the item tiles rather than opening over them, because it IS the
 * other half of the same screen - somebody switches to it, uses it, and
 * switches back, and a dialog floating over a grid they cannot use is just
 * a grid they cannot use.
 *
 * The browser still works out no prices. What it sends is an amount a
 * person typed and a name they gave it; the server rings it as a line with
 * no menu item, which is what a hand-keyed line already is on the board.
 */
function AmountPad({
  currency,
  onAdd,
  onBack,
}: {
  currency: string;
  onAdd: (name: string, amountCents: number) => void;
  onBack: () => void;
}) {
  const [digits, setDigits] = useState('');
  const [name, setName] = useState('');
  const amount = keypadDigitsToCents(digits);

  function add() {
    if (amount <= 0) return;
    // An unnamed amount is still a real sale. Naming it something honest
    // beats refusing it at a counter with a queue.
    onAdd(name.trim() || 'Custom amount', amount);
    setDigits('');
    setName('');
  }

  return (
    <div className="mx-auto flex w-full max-w-xs flex-col gap-2 p-3">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 self-start text-caption font-medium text-accent hover:underline"
      >
        <ChevronLeft size={14} aria-hidden />
        Back to the menu
      </button>

      <output className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-3 text-right text-body-lg font-bold tabular-nums text-fg">
        {money(amount, currency)}
      </output>

      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="What is it? (carrier bag, extra cup…)"
        aria-label="What this amount is for"
        className="w-full rounded-lg border border-border-subtle bg-surface-1 px-2.5 py-2 text-caption text-fg placeholder:text-fg-muted"
      />

      <Keypad digits={digits} onDigits={setDigits} />

      <button
        type="button"
        disabled={amount <= 0}
        onClick={add}
        className="min-h-12 w-full rounded-lg bg-accent text-body font-semibold text-white disabled:opacity-50"
      >
        Add {amount > 0 ? money(amount, currency) : ''} to sale
      </button>
    </div>
  );
}

/**
 * What they gave you, and what to hand back.
 *
 * The arithmetic is in tillMath.ts and tested there; this is the panel. The
 * quick buttons are derived from THIS bill rather than a fixed row of
 * denominations - on a $92 sale a fixed 5/20/50/100 row has three buttons
 * that cannot settle it and is missing the one that can.
 *
 * Nothing here is sent anywhere. Change is a thing a cashier works out at
 * the counter, and recording it would mean claiming a payment arrived -
 * which is what the payment screen is for, and where it belongs.
 */
function CashPanel({ totalCents, currency }: { totalCents: number; currency: string }) {
  const [open, setOpen] = useState(false);
  const [digits, setDigits] = useState('');

  const tendered = keypadDigitsToCents(digits);
  const due = changeDue(totalCents, tendered);
  const quick = quickTenderOptions(totalCents);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border-subtle py-2 text-caption font-medium text-fg hover:bg-surface-2"
      >
        <Calculator size={14} aria-hidden />
        Cash &amp; change
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border-subtle bg-surface-2 p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-caption font-semibold text-fg">Cash</span>
        <button
          type="button"
          onClick={() => { setOpen(false); setDigits(''); }}
          aria-label="Close cash and change"
          className="ml-auto rounded p-0.5 text-fg-muted hover:text-fg"
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {quick.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setDigits(String(option))}
            className="min-h-10 rounded-lg border border-border-subtle bg-surface-1 text-caption font-semibold tabular-nums text-fg hover:bg-surface-3"
          >
            {money(option, currency)}
          </button>
        ))}
      </div>

      <output className="block rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-right text-body font-bold tabular-nums text-fg">
        {money(tendered, currency)}
      </output>

      <Keypad digits={digits} onDigits={setDigits} />

      {/* Shown only once somebody has actually put money on the counter.
          "Change $0.00" before anything is tendered is a number that will
          be read as an answer. */}
      {tendered > 0 && (
        <p
          className={`rounded-lg px-2.5 py-2 text-center text-body font-bold tabular-nums ${
            due.settled ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
          }`}
        >
          {due.settled ? `Change ${money(due.changeCents, currency)}` : `Still owing ${money(due.shortfallCents, currency)}`}
        </p>
      )}
    </div>
  );
}

function ModifierPicker({
  item,
  onCancel,
  onDone,
}: {
  item: FoodMenuItemDto;
  onCancel: () => void;
  onDone: (modifiers: { name: string; action: 'add' | 'remove' | 'on_side'; quantity?: number }[]) => void;
}) {
  /**
   * Name to how many, rather than a set of names.
   *
   * A set could only say yes or no, which was fine while every extra cost
   * the same whether you had one or three. Now that an option can come with
   * the dish and be charged past that, "how many" is the question the till
   * has to be able to answer - and a cashier who cannot ring the third pot
   * of sauce will either give it away or argue with the customer.
   *
   * The money is NOT worked out here. The server prices the basket against
   * the live catalogue and its own free allowance (see orderIntake.ts), and
   * the quote comes back; a till that did its own arithmetic would be a
   * second opinion about somebody's bill.
   */
  const [chosen, setChosen] = useState<Map<string, number>>(new Map());

  function toggle(name: string) {
    setChosen((current) => {
      const next = new Map(current);
      if (next.has(name)) next.delete(name);
      else next.set(name, 1);
      return next;
    });
  }

  function step(name: string, delta: number) {
    setChosen((current) => {
      const next = new Map(current);
      const wanted = (next.get(name) ?? 0) + delta;
      // Stepping the last one off is the same as unticking it, which is
      // what a cashier expects from a minus button reaching zero.
      if (wanted <= 0) next.delete(name);
      else next.set(name, Math.min(wanted, 99));
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-t-2xl bg-surface-1 sm:rounded-2xl">
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          <p className="min-w-0 flex-1 truncate text-body font-semibold text-fg">{item.name}</p>
          <button type="button" onClick={onCancel} aria-label="Cancel" className="rounded p-1 text-fg-muted hover:text-fg">
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {item.modifierGroups.map((group) => (
            <div key={group.id} className="mb-4">
              <p className="text-caption font-semibold text-fg">{group.name}</p>
              {group.maxSelect !== null && group.maxSelect > 1 && (
                <p className="text-meta text-fg-muted">Choose up to {group.maxSelect}</p>
              )}
              <div className="mt-1.5 space-y-1">
                {group.options
                  .filter((option) => option.available)
                  .map((option) => (
                    <div
                      key={option.id}
                      className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-caption ${
                        chosen.has(option.name)
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-border-subtle text-fg'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggle(option.name)}
                        className="min-w-0 flex-1 truncate text-left"
                      >
                        {option.name}
                      </button>

                      {/* What comes with the dish, said plainly. Without it
                          a cashier has no way to know why the second one
                          cost and the first did not. */}
                      {option.freeQuantity > 0 && (
                        <span className="shrink-0 text-meta text-fg-muted">
                          {option.freeQuantity} free
                        </span>
                      )}

                      {option.priceDeltaCents !== 0 && (
                        <span className="shrink-0 tabular-nums text-fg-muted">
                          {option.priceDeltaCents > 0 ? '+' : ''}
                          {money(option.priceDeltaCents, item.currency)}
                        </span>
                      )}

                      {/* Only once it has been chosen: a stepper beside
                          every option on the board is noise at a counter. */}
                      {chosen.has(option.name) && (
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => step(option.name, -1)}
                            aria-label={`One fewer ${option.name}`}
                            className="min-h-8 min-w-8 rounded border border-border-subtle text-body leading-none text-fg"
                          >
                            −
                          </button>
                          <span className="w-5 text-center tabular-nums">{chosen.get(option.name)}</span>
                          <button
                            type="button"
                            onClick={() => step(option.name, 1)}
                            aria-label={`One more ${option.name}`}
                            className="min-h-8 min-w-8 rounded border border-border-subtle text-body leading-none text-fg"
                          >
                            +
                          </button>
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-border-subtle p-3">
          <button
            type="button"
            onClick={() =>
              onDone([...chosen].map(([name, quantity]) => ({ name, action: 'add' as const, quantity })))
            }
            className="min-h-12 w-full rounded-lg bg-accent text-body font-semibold text-white"
          >
            Add to sale
          </button>
        </div>
      </div>
    </div>
  );
}
