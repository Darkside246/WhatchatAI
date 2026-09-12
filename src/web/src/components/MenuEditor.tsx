import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2, X } from 'lucide-react';
import {
  api,
  ApiError,
  type FoodMenuCategoryDto,
  type FoodMenuItemDto,
  type FoodModifierGroupDto,
} from '../lib/api.js';

/**
 * The menu.
 *
 * Shaped the way a POS menu builder is shaped, because that shape was not
 * arrived at arbitrarily: sections down the side, the dishes in the chosen
 * section in the middle, and option groups kept somewhere else entirely so
 * "extra cheese, +1.50" is typed once and attached to every burger rather
 * than retyped on each of them.
 *
 * Everything here writes immediately. There is no Save button on the page
 * because a half-entered menu is not a draft an owner wants to manage -
 * they want the thing they just typed to be on the menu. The one exception
 * is the item form, which saves on blur per field, so an accidental tab
 * out of a price box cannot blank a price (the API only writes fields it
 * is actually sent).
 */

/** Cents to a plain editable number: 1250 -> "12.50". */
function toAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** The reverse, tolerantly - an owner types "12", "12.5" and "$12.50" and means the same thing. */
function toCents(value: string): number | null {
  const cleaned = value.replace(/[^0-9.\-]/g, '').trim();
  if (!cleaned) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

/** Comma-separated in the box, an array on the wire. Empty entries dropped so a trailing comma is harmless. */
function toList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function MenuEditor() {
  const [categories, setCategories] = useState<FoodMenuCategoryDto[] | null>(null);
  const [items, setItems] = useState<FoodMenuItemDto[]>([]);
  const [groups, setGroups] = useState<FoodModifierGroupDto[]>([]);
  const [tab, setTab] = useState<'items' | 'groups'>('items');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [menu, categoryList, groupList] = await Promise.all([
        api.getFoodMenu(),
        api.listFoodMenuCategories(),
        api.listFoodModifierGroups(),
      ]);
      setItems(menu.items);
      setCategories(categoryList.categories);
      setGroups(groupList.groups);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the menu.');
      setCategories((current) => current ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Kept in step with what exists rather than held blindly: a section the
  // operator just deleted must not stay selected and show an empty middle
  // column with no way back.
  useEffect(() => {
    if (!categories) return;
    if (selectedCategoryId && categories.some((category) => category.id === selectedCategoryId)) return;
    setSelectedCategoryId(categories[0]?.id ?? null);
  }, [categories, selectedCategoryId]);

  /** Every write goes through here so one failure cannot leave the screen showing something that was never stored. */
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  const uncategorised = useMemo(() => items.filter((item) => item.categoryId === null), [items]);
  const visibleItems = useMemo(
    () => (selectedCategoryId === null ? uncategorised : items.filter((item) => item.categoryId === selectedCategoryId)),
    [items, selectedCategoryId, uncategorised],
  );

  if (categories === null) return <p className="p-4 text-caption text-fg-muted">Loading the menu…</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border-subtle px-4">
        <TabButton active={tab === 'items'} onClick={() => setTab('items')}>
          Menu{items.length > 0 && <span className="ml-1.5 text-fg-muted">{items.length}</span>}
        </TabButton>
        <TabButton active={tab === 'groups'} onClick={() => setTab('groups')}>
          Option groups{groups.length > 0 && <span className="ml-1.5 text-fg-muted">{groups.length}</span>}
        </TabButton>
      </div>

      {error && <p className="border-b border-error/30 bg-error/10 px-4 py-2 text-caption text-error">{error}</p>}

      {tab === 'items' ? (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <CategoryRail
            categories={categories}
            items={items}
            uncategorisedCount={uncategorised.length}
            selectedId={selectedCategoryId}
            busy={busy}
            onSelect={setSelectedCategoryId}
            onRun={run}
          />
          <ItemList
            items={visibleItems}
            categories={categories}
            groups={groups}
            categoryId={selectedCategoryId}
            openItemId={openItemId}
            busy={busy}
            onOpen={(id) => setOpenItemId((current) => (current === id ? null : id))}
            onRun={run}
          />
        </div>
      ) : (
        <ModifierGroups groups={groups} busy={busy} onRun={run} />
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`-mb-px border-b-2 px-3 py-2.5 text-caption font-medium ${
        active ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The sections, in the order they are read.
 *
 * Reordering is up/down buttons rather than drag: a menu is reordered once
 * and then rarely, usually on a tablet, and a drag target that small is
 * worse on a touchscreen than two buttons that always work.
 */
function CategoryRail({
  categories, items, uncategorisedCount, selectedId, busy, onSelect, onRun,
}: {
  categories: FoodMenuCategoryDto[];
  items: FoodMenuItemDto[];
  uncategorisedCount: number;
  selectedId: string | null;
  busy: boolean;
  onSelect: (id: string | null) => void;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [adding, setAdding] = useState('');

  function move(index: number, direction: -1 | 1) {
    const next = [...categories];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    void onRun(() => api.reorderFoodMenuCategories(next.map((category) => category.id)));
  }

  function remove(category: FoodMenuCategoryDto) {
    const count = items.filter((item) => item.categoryId === category.id).length;
    const warning = count > 0
      ? `\n\n${count} item${count === 1 ? '' : 's'} will stay on the menu without a section. Nothing is deleted.`
      : '';
    if (!window.confirm(`Remove the "${category.name}" section?${warning}`)) return;
    void onRun(() => api.deleteFoodMenuCategory(category.id));
  }

  return (
    <div className="shrink-0 border-b border-border-subtle p-3 md:w-56 md:border-b-0 md:border-r">
      <p className="px-1 pb-2 text-meta font-semibold uppercase tracking-wide text-fg-muted">Sections</p>

      <ul className="space-y-0.5">
        {categories.map((category, index) => (
          <li key={category.id} className="group flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSelect(category.id)}
              onDoubleClick={() => {
                const name = window.prompt('Rename this section', category.name);
                if (name?.trim() && name.trim() !== category.name) void onRun(() => api.renameFoodMenuCategory(category.id, name.trim()));
              }}
              title="Double-click to rename"
              className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-caption ${
                selectedId === category.id ? 'bg-surface-2 font-medium text-fg' : 'text-fg-secondary hover:bg-surface-2'
              }`}
            >
              {category.name}
              <span className="ml-1.5 text-fg-muted">{items.filter((item) => item.categoryId === category.id).length}</span>
            </button>
            <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <button type="button" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${category.name} up`} className="rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30">
                <ChevronUp size={13} aria-hidden />
              </button>
              <button type="button" disabled={busy || index === categories.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${category.name} down`} className="rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30">
                <ChevronDown size={13} aria-hidden />
              </button>
              <button type="button" disabled={busy} onClick={() => remove(category)} aria-label={`Remove ${category.name}`} className="rounded p-1 text-fg-muted hover:bg-error/10 hover:text-error disabled:opacity-30">
                <Trash2 size={13} aria-hidden />
              </button>
            </span>
          </li>
        ))}

        {/* Only shown when there is something in it. An empty "no section"
            row on a tidy menu is a permanent reminder of nothing. */}
        {uncategorisedCount > 0 && (
          <li>
            <button
              type="button"
              onClick={() => onSelect(null)}
              className={`w-full truncate rounded-md px-2 py-1.5 text-left text-caption italic ${
                selectedId === null ? 'bg-surface-2 font-medium text-fg' : 'text-fg-muted hover:bg-surface-2'
              }`}
            >
              No section <span className="ml-1.5">{uncategorisedCount}</span>
            </button>
          </li>
        )}
      </ul>

      <form
        className="mt-2 flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const name = adding.trim();
          if (!name) return;
          setAdding('');
          void onRun(() => api.createFoodMenuCategory(name));
        }}
      >
        <input
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
          placeholder="Add a section"
          aria-label="New section name"
          className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-1 px-2 py-1.5 text-caption text-fg placeholder:text-fg-muted"
        />
        <button type="submit" disabled={busy || !adding.trim()} aria-label="Add section" className="rounded-md border border-border-subtle p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40">
          <Plus size={13} aria-hidden />
        </button>
      </form>
    </div>
  );
}

function ItemList({
  items, categories, groups, categoryId, openItemId, busy, onOpen, onRun,
}: {
  items: FoodMenuItemDto[];
  categories: FoodMenuCategoryDto[];
  groups: FoodModifierGroupDto[];
  categoryId: string | null;
  openItemId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');

  function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    const cents = toCents(price);
    if (!trimmed || cents === null || cents < 0) return;
    setName('');
    setPrice('');
    void onRun(() => api.createFoodMenuItem({ name: trimmed, priceCents: cents, categoryId }));
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...items];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    void onRun(() => api.reorderFoodMenuItems(next.map((item) => item.id)));
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {/* First, not last. Adding a dish is what an owner opened this screen
          to do, and a form at the bottom of forty items is a form nobody
          finds twice. */}
      <form onSubmit={add} className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 p-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Add a dish"
          aria-label="New item name"
          className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-0 px-2.5 py-1.5 text-caption text-fg placeholder:text-fg-muted"
        />
        <input
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          aria-label="New item price"
          className="w-24 rounded-md border border-border-subtle bg-surface-0 px-2.5 py-1.5 text-caption text-fg placeholder:text-fg-muted"
        />
        <button
          type="submit"
          disabled={busy || !name.trim() || toCents(price) === null}
          className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-40"
        >
          <Plus size={13} aria-hidden />
          Add
        </button>
      </form>

      {items.length === 0 ? (
        <p className="px-1 py-6 text-center text-caption text-fg-muted">Nothing in this section yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item, index) => (
            <li key={item.id} className="rounded-lg border border-border-subtle bg-surface-1">
              <div className="flex items-center gap-2 px-2.5 py-2">
                <span className="flex shrink-0 flex-col">
                  <button type="button" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${item.name} up`} className="text-fg-muted hover:text-fg disabled:opacity-25">
                    <ChevronUp size={12} aria-hidden />
                  </button>
                  <button type="button" disabled={busy || index === items.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${item.name} down`} className="text-fg-muted hover:text-fg disabled:opacity-25">
                    <ChevronDown size={12} aria-hidden />
                  </button>
                </span>

                <button type="button" onClick={() => onOpen(item.id)} aria-expanded={openItemId === item.id} className="min-w-0 flex-1 text-left">
                  <span className={`block truncate text-caption font-medium ${item.available ? 'text-fg' : 'text-fg-muted line-through'}`}>
                    {item.name}
                  </span>
                  {item.modifierGroups.length > 0 && (
                    <span className="block truncate text-meta text-fg-muted">
                      {item.modifierGroups.map((group) => group.name).join(' · ')}
                    </span>
                  )}
                </button>

                <span className="shrink-0 text-caption tabular-nums text-fg-secondary">{money(item.priceCents, item.currency)}</span>

                {/* The "86" toggle, one tap, on the row itself - it is
                    pressed mid-service by somebody who has just run out of
                    something, not by somebody editing a menu. */}
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-meta text-fg-muted">
                  <input
                    type="checkbox"
                    checked={item.available}
                    disabled={busy}
                    onChange={(event) => void onRun(() => api.setFoodMenuAvailability(item.id, event.target.checked))}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  In stock
                </label>
              </div>

              {openItemId === item.id && (
                <ItemForm item={item} categories={categories} groups={groups} busy={busy} onRun={onRun} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One dish, in full.
 *
 * Each field saves when it loses focus and sends only itself, so two
 * people editing the same menu cannot overwrite each other's work with
 * stale copies of fields they never touched.
 */
function ItemForm({
  item, categories, groups, busy, onRun,
}: {
  item: FoodMenuItemDto;
  categories: FoodMenuCategoryDto[];
  groups: FoodModifierGroupDto[];
  busy: boolean;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState(toAmount(item.priceCents));
  const [description, setDescription] = useState(item.description ?? '');
  const [station, setStation] = useState(item.station ?? '');
  const [aliases, setAliases] = useState(item.aliases.join(', '));
  const [allergens, setAllergens] = useState(item.allergens.join(', '));

  const attached = new Set(item.modifierGroups.map((group) => group.id));

  return (
    <div className="space-y-3 border-t border-border-subtle px-2.5 py-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => { const value = name.trim(); if (value && value !== item.name) void onRun(() => api.updateFoodMenuItem(item.id, { name: value })); }}
            className={inputClass}
          />
        </Field>
        <Field label="Price">
          <input
            value={price}
            inputMode="decimal"
            onChange={(event) => setPrice(event.target.value)}
            onBlur={() => {
              const cents = toCents(price);
              // A price that will not parse is left alone and put back,
              // rather than written as zero. Giving food away because
              // somebody typed a letter is not an acceptable failure.
              if (cents === null || cents < 0) { setPrice(toAmount(item.priceCents)); return; }
              if (cents !== item.priceCents) void onRun(() => api.updateFoodMenuItem(item.id, { priceCents: cents }));
            }}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Description" hint="What the customer is told it is. The agent reads this out when asked.">
        <textarea
          value={description}
          rows={2}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => { const value = description.trim(); if (value !== (item.description ?? '')) void onRun(() => api.updateFoodMenuItem(item.id, { description: value || null })); }}
          className={inputClass}
        />
      </Field>

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Section">
          <select
            value={item.categoryId ?? ''}
            disabled={busy}
            onChange={(event) => { const value = event.target.value; if (value) void onRun(() => api.updateFoodMenuItem(item.id, { categoryId: value })); }}
            className={inputClass}
          >
            {item.categoryId === null && <option value="">No section</option>}
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </Field>
        <Field label="Station" hint="Grill, fryer, bar — printed on the ticket.">
          <input
            value={station}
            onChange={(event) => setStation(event.target.value)}
            onBlur={() => { const value = station.trim(); if (value !== (item.station ?? '')) void onRun(() => api.updateFoodMenuItem(item.id, { station: value || null })); }}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Also called" hint="What customers really type — “lg pep”, “the usual burger”. Separate with commas.">
        <input
          value={aliases}
          onChange={(event) => setAliases(event.target.value)}
          onBlur={() => { const value = toList(aliases); if (value.join('|') !== item.aliases.join('|')) void onRun(() => api.updateFoodMenuItem(item.id, { aliases: value })); }}
          className={inputClass}
        />
      </Field>

      <Field label="Allergens" hint="Shown to whoever is packing it. Separate with commas.">
        <input
          value={allergens}
          onChange={(event) => setAllergens(event.target.value)}
          onBlur={() => { const value = toList(allergens); if (value.join('|') !== item.allergens.join('|')) void onRun(() => api.updateFoodMenuItem(item.id, { allergens: value })); }}
          className={inputClass}
        />
      </Field>

      <div>
        <p className="text-meta font-medium text-fg">Option groups</p>
        <p className="mb-1.5 text-meta text-fg-muted">
          {groups.length === 0 ? 'Build one under Option groups, then attach it here.' : 'Tick the groups this dish offers.'}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {groups.map((group) => (
            <label key={group.id} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border-subtle px-2 py-1 text-meta text-fg-secondary">
              <input
                type="checkbox"
                checked={attached.has(group.id)}
                disabled={busy}
                onChange={(event) =>
                  void onRun(() =>
                    event.target.checked
                      ? api.attachFoodModifierGroup(item.id, group.id)
                      : api.detachFoodModifierGroup(item.id, group.id),
                  )
                }
                className="h-3.5 w-3.5 accent-accent"
              />
              {group.name}
            </label>
          ))}
        </div>
      </div>

      {/* Deleting is deliberately at the bottom and quiet. Orders already
          taken keep their own copy of every line, so removing a dish can
          never rewrite what somebody was charged last week. */}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (!window.confirm(`Remove "${item.name}" from the menu?\n\nOrders already taken keep their prices.`)) return;
          void onRun(() => api.deleteFoodMenuItem(item.id));
        }}
        className="flex items-center gap-1.5 text-meta text-fg-muted hover:text-error disabled:opacity-40"
      >
        <Trash2 size={12} aria-hidden />
        Remove from the menu
      </button>
    </div>
  );
}

const inputClass = 'w-full rounded-md border border-border-subtle bg-surface-0 px-2.5 py-1.5 text-caption text-fg placeholder:text-fg-muted';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-meta font-medium text-fg">{label}</span>
      {hint && <span className="mb-1 block text-meta text-fg-muted">{hint}</span>}
      {children}
    </label>
  );
}

/**
 * The groups, kept away from the items on purpose.
 *
 * This is the whole reason the menu was reshaped: "Add-ons" is one thing
 * that exists once, attached to every burger. Editing its price here
 * changes it everywhere, which is what an owner expects and what a
 * per-item blob of modifiers could never do.
 */
function ModifierGroups({
  groups, busy, onRun,
}: {
  groups: FoodModifierGroupDto[];
  busy: boolean;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [minSelect, setMinSelect] = useState('0');
  const [maxSelect, setMaxSelect] = useState('');

  function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const min = Number(minSelect) || 0;
    const max = maxSelect.trim() ? Number(maxSelect) : null;
    if (max !== null && (!Number.isFinite(max) || max < min)) return;
    setName('');
    setMinSelect('0');
    setMaxSelect('');
    void onRun(() => api.createFoodModifierGroup({ name: trimmed, minSelect: min, maxSelect: max }));
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <form onSubmit={add} className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-border-subtle bg-surface-1 p-2">
        <label className="min-w-0 flex-1">
          <span className="block text-meta font-medium text-fg">Group</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Add-ons, Choose a sauce…"
            className={inputClass}
          />
        </label>
        <label className="w-20">
          <span className="block text-meta font-medium text-fg">Least</span>
          <input value={minSelect} inputMode="numeric" onChange={(event) => setMinSelect(event.target.value)} className={inputClass} />
        </label>
        <label className="w-20">
          <span className="block text-meta font-medium text-fg">Most</span>
          <input value={maxSelect} inputMode="numeric" placeholder="any" onChange={(event) => setMaxSelect(event.target.value)} className={inputClass} />
        </label>
        <button type="submit" disabled={busy || !name.trim()} className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-caption font-medium text-white hover:bg-accent-dim disabled:opacity-40">
          <Plus size={13} aria-hidden />
          Add
        </button>
      </form>

      <p className="mb-3 px-1 text-meta text-fg-muted">
        “Least” and “most” are how many choices this group allows — one sauce, any number of add-ons. Leave “most” empty for no limit.
      </p>

      {groups.length === 0 ? (
        <p className="px-1 py-6 text-center text-caption text-fg-muted">No option groups yet.</p>
      ) : (
        <ul className="space-y-2">
          {groups.map((group) => <GroupCard key={group.id} group={group} busy={busy} onRun={onRun} />)}
        </ul>
      )}
    </div>
  );
}

function GroupCard({
  group, busy, onRun,
}: {
  group: FoodModifierGroupDto;
  busy: boolean;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [optionName, setOptionName] = useState('');
  const [delta, setDelta] = useState('');

  function addOption(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = optionName.trim();
    if (!trimmed) return;
    // An empty box means free, which is the common case - "no onions"
    // costs nothing, and neither does picking a sauce.
    const priceDeltaCents = delta.trim() ? toCents(delta) : 0;
    if (priceDeltaCents === null) return;
    setOptionName('');
    setDelta('');
    void onRun(() => api.addFoodModifierOption(group.id, { name: trimmed, priceDeltaCents }));
  }

  return (
    <li className="rounded-lg border border-border-subtle bg-surface-1 p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <GripVertical size={13} className="shrink-0 text-fg-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-caption font-medium text-fg">{group.name}</span>
        <span className="shrink-0 text-meta text-fg-muted">
          {group.minSelect === 0 && group.maxSelect === null
            ? 'any number'
            : `${group.minSelect}–${group.maxSelect ?? 'any'}`}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Delete the "${group.name}" group?\n\nIt is removed from every dish that offers it.`)) return;
            void onRun(() => api.deleteFoodModifierGroup(group.id));
          }}
          aria-label={`Delete ${group.name}`}
          className="shrink-0 rounded p-1 text-fg-muted hover:bg-error/10 hover:text-error disabled:opacity-40"
        >
          <X size={13} aria-hidden />
        </button>
      </div>

      {group.options.length > 0 && (
        <ul className="mb-2 space-y-1">
          {group.options.map((option) => (
            <li key={option.id} className="flex items-center gap-2 text-caption">
              <span className={`min-w-0 flex-1 truncate ${option.available ? 'text-fg-secondary' : 'text-fg-muted line-through'}`}>
                {option.name}
              </span>
              <span className="shrink-0 tabular-nums text-fg-muted">
                {option.priceDeltaCents === 0 ? 'free' : `${option.priceDeltaCents > 0 ? '+' : '−'}${toAmount(Math.abs(option.priceDeltaCents))}`}
              </span>
              <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-meta text-fg-muted">
                <input
                  type="checkbox"
                  checked={option.available}
                  disabled={busy}
                  onChange={(event) => void onRun(() => api.setFoodModifierOptionAvailability(option.id, event.target.checked))}
                  className="h-3.5 w-3.5 accent-accent"
                />
                In stock
              </label>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={addOption} className="flex flex-wrap items-center gap-1.5">
        <input
          value={optionName}
          onChange={(event) => setOptionName(event.target.value)}
          placeholder="Add a choice"
          aria-label={`New choice in ${group.name}`}
          className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-0 px-2 py-1 text-meta text-fg placeholder:text-fg-muted"
        />
        <input
          value={delta}
          inputMode="decimal"
          onChange={(event) => setDelta(event.target.value)}
          placeholder="free"
          aria-label={`Extra cost in ${group.name}`}
          className="w-20 rounded-md border border-border-subtle bg-surface-0 px-2 py-1 text-meta text-fg placeholder:text-fg-muted"
        />
        <button type="submit" disabled={busy || !optionName.trim()} aria-label={`Add to ${group.name}`} className="rounded-md border border-border-subtle p-1 text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40">
          <Plus size={13} aria-hidden />
        </button>
      </form>
    </li>
  );
}
