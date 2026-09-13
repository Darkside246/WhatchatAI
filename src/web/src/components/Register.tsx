import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Search, Trash2, X } from 'lucide-react';
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
  item: FoodMenuItemDto;
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

  const proposal = useMemo<FoodOrderProposalDto>(() => {
    const lines: FoodProposedLineDto[] = basket.map((line) => ({
      // By name, because that is what the server's resolver matches on and
      // what ends up written on the ticket the kitchen reads.
      reference: line.item.name,
      quantity: line.quantity,
      ...(line.modifiers.length > 0 ? { modifiers: line.modifiers } : {}),
    }));
    return {
      fulfilmentMethod: fulfilment,
      lines,
      ...(customerName.trim() ? { customerName: customerName.trim() } : {}),
      ...(fulfilment === 'DINE_IN' && tableLabel.trim() ? { tableLabel: tableLabel.trim() } : {}),
    };
  }, [basket, fulfilment, customerName, tableLabel]);

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
        <div className="relative shrink-0 border-b border-border-subtle p-2">
          <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-fg-muted" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search the menu…"
            aria-label="Search the menu"
            className="w-full rounded-lg border border-border-subtle bg-surface-2 py-2 pl-8 pr-3 text-caption text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
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
            {basket.map((line) => (
              <li key={line.key} className="flex items-start gap-2 border-b border-border-subtle px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-caption font-medium text-fg">{line.item.name}</p>
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
                    aria-label={`One fewer ${line.item.name}`}
                    className="h-7 w-7 rounded border border-border-subtle text-fg-muted hover:text-fg"
                  >
                    −
                  </button>
                  <span className="w-6 text-center text-caption font-semibold tabular-nums text-fg">{line.quantity}</span>
                  <button
                    type="button"
                    onClick={() => changeQuantity(line.key, 1)}
                    aria-label={`One more ${line.item.name}`}
                    className="h-7 w-7 rounded border border-border-subtle text-fg-muted hover:text-fg"
                  >
                    +
                  </button>
                </div>
              </li>
            ))}
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
              {quote && quote.deliveryFeeCents > 0 && (
                <div className="flex justify-between text-fg-secondary">
                  <span>Delivery</span>
                  <span className="tabular-nums">{money(quote.deliveryFeeCents, currency)}</span>
                </div>
              )}
            </div>

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
