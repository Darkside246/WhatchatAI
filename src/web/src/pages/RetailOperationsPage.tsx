import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CheckCircle2, ChevronRight, Filter, Loader2, Package, Plus,
  RefreshCw, Search, ShoppingBag, ThumbsUp, X,
} from 'lucide-react';
import { ApprovalsPanel, platformApi, type ActionRequestRec } from '../components/ApprovalsPanel.js';

// ── Types ────────────────────────────────────────────────────────────────────

type ProductRec = {
  id: string; name: string; sku: string | null; category: string; status: string;
  priceCents: number; currency: string; stockQuantity: number | null; description: string | null;
  createdAt: string;
};
type OrderItemRec = { productId: string; name: string; quantity: number; unitPriceCents: number };
type OrderRec = {
  id: string; customerContactId: string | null; sourceChannel: string; status: string; items: OrderItemRec[];
  totalCents: number; currency: string; fulfillmentMethod: string; deliveryAddress: string | null; notes: string | null;
  aiSummary: string | null; confidence: number | null; createdAt: string; updatedAt: string; fulfilledAt: string | null;
};
type Tab = 'overview' | 'products' | 'orders' | 'approvals';
type StatusFilter = 'ALL' | 'PENDING_APPROVAL' | 'APPROVED' | 'FULFILLED' | 'CANCELLED';

// ── API helper ────────────────────────────────────────────────────────────────

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/retail-operations${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as { message?: string; error?: string }).message ?? (payload as { error?: string }).error ?? `Request failed (${response.status})`);
  return payload as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function fmtDate(v: string) { const d = new Date(v); return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function fmtCents(c: number) { return `$${(c / 100).toFixed(2)}`; }

// ── Shared micro-components ───────────────────────────────────────────────────

function StatusBadge({ label }: { label: string }) {
  const cls = ['FULFILLED'].includes(label) ? 'bg-success/10 text-success' : label === 'CANCELLED' ? 'bg-error/10 text-error' : label === 'PENDING_APPROVAL' || label === 'PENDING_POLICY' ? 'bg-warning/10 text-warning' : 'bg-surface-2 text-fg-muted';
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-meta font-medium ${cls}`}>{label.replace(/_/g, ' ')}</span>;
}

function Metric({ icon: Icon, label, value }: { icon: typeof ShoppingBag; label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface-1 p-4">
      <div className="flex items-center gap-2 text-meta text-fg-muted"><Icon size={14} />{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-fg">{value}</div>
    </div>
  );
}

function EmptyState({ icon: Icon, text }: { icon: typeof ShoppingBag; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-fg-muted"><Icon size={22} /></div>
      <p className="text-caption text-fg-muted">{text}</p>
    </div>
  );
}

function FieldInput({ label, value, onChange, required, placeholder, maxLength, type }: { label: string; value: string; onChange: (v: string) => void; required?: boolean; placeholder?: string; maxLength?: number; type?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-meta font-medium text-fg-secondary">{label}{required && <span className="ml-0.5 text-error">*</span>}</span>
      <input type={type ?? 'text'} value={value} onChange={(e) => onChange(e.target.value)} required={required} placeholder={placeholder} maxLength={maxLength}
        className="field w-full border border-border-subtle bg-surface-0 text-fg" />
    </label>
  );
}

function FieldSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="block">
      <span className="mb-1 block text-meta font-medium text-fg-secondary">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="field w-full border border-border-subtle bg-surface-0 text-fg">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function FieldTextarea({ label, value, onChange, placeholder, rows }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <label className="block">
      <span className="mb-1 block text-meta font-medium text-fg-secondary">{label}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows ?? 3}
        className="field w-full resize-y border border-border-subtle bg-surface-0 text-fg" />
    </label>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────────

function OverviewTab({ products, orders, onGoTo }: { products: ProductRec[]; orders: OrderRec[]; onGoTo: (tab: Tab) => void }) {
  const pendingCount = orders.filter((o) => o.status === 'PENDING_APPROVAL' || o.status === 'PENDING_POLICY').length;
  const fulfilledCount = orders.filter((o) => o.status === 'FULFILLED').length;
  const recent = [...orders].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric icon={Package} label="Products" value={products.length} />
        <Metric icon={ShoppingBag} label="Pending orders" value={pendingCount} />
        <Metric icon={CheckCircle2} label="Fulfilled" value={fulfilledCount} />
      </div>

      <section className="rounded-xl border border-border-subtle bg-surface-1">
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <h2 className="text-body font-medium text-fg">Recent orders</h2>
          <button type="button" onClick={() => onGoTo('orders')} className="text-caption text-accent hover:underline">View all</button>
        </div>
        {recent.length === 0
          ? <EmptyState icon={CheckCircle2} text="No orders yet." />
          : (
            <div className="divide-y divide-border-subtle">
              {recent.map((o) => (
                <div key={o.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-caption font-medium text-fg">{o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ') || 'Order'}</p>
                    <p className="text-meta text-fg-muted">{fmtCents(o.totalCents)} · {fmtDate(o.createdAt)}</p>
                  </div>
                  <StatusBadge label={o.status} />
                </div>
              ))}
            </div>
          )
        }
      </section>

      <section className="rounded-xl border border-border-subtle bg-surface-1">
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <h2 className="text-body font-medium text-fg">Products</h2>
          <button type="button" onClick={() => onGoTo('products')} className="text-caption text-accent hover:underline">Manage</button>
        </div>
        {products.length === 0
          ? <EmptyState icon={Package} text="No products yet. Add one in the Products tab." />
          : (
            <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {products.map((p) => (
                <div key={p.id} className="rounded-lg border border-border-subtle bg-surface-0 p-3">
                  <p className="text-caption font-medium text-fg">{p.name}</p>
                  <p className="text-meta text-fg-muted">{p.category} · {fmtCents(p.priceCents)}</p>
                </div>
              ))}
            </div>
          )
        }
      </section>
    </div>
  );
}

// ── Products tab ──────────────────────────────────────────────────────────────

function ProductsTab({ products, onProductsChange }: { products: ProductRec[]; onProductsChange: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [category, setCategory] = useState('GENERAL');
  const [priceInput, setPriceInput] = useState('');
  const [stockInput, setStockInput] = useState('');
  const [description, setDescription] = useState('');

  async function handleAdd(e: FormEvent) {
    e.preventDefault(); setSaving(true); setError(null);
    try {
      const priceCents = priceInput.trim() ? Math.round(Number(priceInput) * 100) : 0;
      if (priceInput.trim() && !Number.isFinite(priceCents)) throw new Error('Enter a valid price.');
      const body: Record<string, unknown> = { name: name.trim(), category: category.trim() || 'GENERAL', priceCents };
      if (sku.trim()) body.sku = sku.trim();
      if (stockInput.trim()) {
        const stockQuantity = Math.round(Number(stockInput));
        if (!Number.isFinite(stockQuantity) || stockQuantity < 0) throw new Error('Enter a valid stock quantity.');
        body.stockQuantity = stockQuantity;
      }
      if (description.trim()) body.description = description.trim();
      await post('/products', body);
      setName(''); setSku(''); setCategory('GENERAL'); setPriceInput(''); setStockInput(''); setDescription('');
      setShowAdd(false);
      onProductsChange();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to create product'); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-title font-semibold text-fg">Products</h2>
          <p className="mt-0.5 text-caption text-fg-muted">Your catalog. Customers ordering over WhatsApp are matched against these.</p>
        </div>
        <button type="button" onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-caption font-medium text-fg hover:bg-surface-2">
          {showAdd ? <X size={14} /> : <Plus size={14} />}
          {showAdd ? 'Cancel' : 'Add product'}
        </button>
      </div>

      {error && <p className="mb-4 text-caption text-error">{error}</p>}

      {showAdd && (
        <div className="mb-5 rounded-xl border border-border-subtle bg-surface-1 p-5">
          <p className="mb-3 text-body font-medium text-fg">Add product</p>
          <form onSubmit={(e) => void handleAdd(e)} className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <FieldInput label="Name" value={name} onChange={setName} required placeholder="Blue cotton T-shirt" />
            </div>
            <FieldInput label="SKU" value={sku} onChange={setSku} placeholder="TSHIRT-BLU-M" />
            <FieldInput label="Category" value={category} onChange={setCategory} placeholder="APPAREL" />
            <FieldInput label="Price" type="number" value={priceInput} onChange={setPriceInput} placeholder="19.99" />
            <FieldInput label="Stock quantity (blank = not tracked)" type="number" value={stockInput} onChange={setStockInput} placeholder="50" />
            <div className="sm:col-span-2">
              <FieldTextarea label="Description" value={description} onChange={setDescription} placeholder="Optional product description" rows={2} />
            </div>
            <div className="sm:col-span-2">
              <button type="submit" disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-caption font-medium text-white disabled:opacity-50">
                {saving ? <Loader2 size={13} className="animate-spin" /> : null} Add product
              </button>
            </div>
          </form>
        </div>
      )}

      {products.length === 0 && <EmptyState icon={Package} text="No products yet. Add your first one above." />}

      {products.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {products.map((p) => (
            <div key={p.id} className="rounded-xl border border-border-subtle bg-surface-1 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-caption font-semibold text-fg">{p.name}</p>
                  <p className="mt-0.5 text-meta text-fg-muted">{p.category}{p.sku ? ` · ${p.sku}` : ''}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-meta font-medium ${p.status === 'ACTIVE' ? 'bg-success/10 text-success' : 'bg-surface-2 text-fg-muted'}`}>{p.status}</span>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-caption font-medium text-fg">{fmtCents(p.priceCents)}</span>
                <span className="text-meta text-fg-muted">{p.stockQuantity === null ? 'Not tracked' : `${p.stockQuantity} in stock`}</span>
              </div>
              {p.description && <p className="mt-2 text-meta text-fg-muted">{p.description}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Orders tab ────────────────────────────────────────────────────────────────

function OrdersTab({ orders, onOrdersChange }: { orders: OrderRec[]; onOrdersChange: () => void }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const pendingCount = orders.filter((o) => o.status === 'PENDING_APPROVAL' || o.status === 'PENDING_POLICY').length;
  const approvedCount = orders.filter((o) => o.status === 'APPROVED').length;
  const fulfilledCount = orders.filter((o) => o.status === 'FULFILLED').length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders
      .filter((o) => statusFilter === 'ALL' || o.status === statusFilter)
      .filter((o) => !q || [o.items.map((i) => i.name).join(' '), o.status, o.notes ?? ''].join(' ').toLowerCase().includes(q))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [orders, query, statusFilter]);

  const selected = useMemo(() => orders.find((o) => o.id === selectedId) ?? filtered[0] ?? null, [orders, selectedId, filtered]);

  useEffect(() => {
    if (selectedId && !filtered.some((o) => o.id === selectedId)) setSelectedId(null);
  }, [filtered, selectedId]);

  async function handleStatus(orderId: string, status: 'APPROVED' | 'FULFILLED' | 'CANCELLED') {
    setActionBusyId(orderId); setActionError(null);
    try {
      await patch(`/orders/${orderId}`, { status });
      onOrdersChange();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to update order'); }
    finally { setActionBusyId(null); }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[220px_minmax(0,1fr)_340px]">
      {/* ── Filter sidebar ── */}
      <aside className="rounded-xl border border-border-subtle bg-surface-1">
        <div className="border-b border-border-subtle px-4 py-3">
          <p className="text-meta font-medium uppercase tracking-wide text-fg-muted">Orders</p>
        </div>
        <div className="space-y-0.5 p-2">
          {([
            { id: 'ALL', label: 'All', count: orders.length },
            { id: 'PENDING_APPROVAL', label: 'Pending approval', count: pendingCount },
            { id: 'APPROVED', label: 'Approved', count: approvedCount },
            { id: 'FULFILLED', label: 'Fulfilled', count: fulfilledCount },
          ] as { id: StatusFilter; label: string; count: number }[]).map(({ id, label, count }) => (
            <button key={id} type="button" onClick={() => setStatusFilter(id)}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition ${statusFilter === id ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2'}`}>
              <span className="text-caption font-medium">{label}</span>
              <span className="text-meta text-fg-muted">{count}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* ── Centre: order list ── */}
      <section className="min-w-0 rounded-xl border border-border-subtle bg-surface-1">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
          <div>
            <h2 className="text-body font-medium text-fg">Orders</h2>
            <p className="mt-0.5 text-meta text-fg-muted">Pending orders need approval before fulfillment.</p>
          </div>
          <span className="rounded-full bg-surface-2 px-2 py-1 text-meta text-fg-muted">{filtered.length}</span>
        </div>
        <div className="flex flex-wrap gap-2 border-b border-border-subtle px-4 py-3">
          <label className="flex min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-border-subtle bg-surface-0 px-3 py-2 text-fg-muted focus-within:border-accent">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search orders"
              className="min-w-0 flex-1 bg-transparent text-caption text-fg outline-none placeholder:text-fg-muted" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear"><X size={13} /></button>}
          </label>
          <button type="button" onClick={() => { setQuery(''); setStatusFilter('ALL'); }}
            className="inline-flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-caption text-fg-muted hover:bg-surface-2">
            <Filter size={13} /> Clear
          </button>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">
            {filtered.length === 0 && <EmptyState icon={CheckCircle2} text="No orders match this view." />}
            {filtered.map((o) => (
              <button key={o.id} type="button" onClick={() => setSelectedId(o.id)}
                className={`grid w-full grid-cols-[1fr_90px_36px] items-center gap-3 border-b border-border-subtle px-4 py-3 text-left transition hover:bg-surface-2/70 ${selected?.id === o.id ? 'bg-accent-soft/50' : ''}`}>
                <span className="min-w-0">
                  <span className="block truncate text-caption font-medium text-fg">{o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ') || 'Order'}</span>
                  <span className="mt-0.5 block text-meta text-fg-muted">{fmtCents(o.totalCents)} · {fmtDate(o.createdAt)}</span>
                </span>
                <StatusBadge label={o.status} />
                <ChevronRight size={15} className="justify-self-end text-fg-muted" />
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Right: order detail ── */}
      <aside className="rounded-xl border border-border-subtle bg-surface-1">
        <div className="border-b border-border-subtle px-4 py-3">
          <p className="text-meta font-medium uppercase tracking-wide text-fg-muted">Order detail</p>
        </div>
        {!selected
          ? <EmptyState icon={ShoppingBag} text="Select an order to review details." />
          : (
            <div className="space-y-4 overflow-y-auto p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusBadge label={selected.status} />
                {!['FULFILLED', 'CANCELLED'].includes(selected.status) && (
                  <div className="flex flex-wrap gap-2">
                    {selected.status !== 'APPROVED' && (
                      <button type="button" disabled={actionBusyId === selected.id} onClick={() => void handleStatus(selected.id, 'APPROVED')}
                        className="rounded-lg border border-success/30 px-3 py-1.5 text-caption font-medium text-success hover:bg-success/10 disabled:opacity-50">
                        Approve
                      </button>
                    )}
                    <button type="button" disabled={actionBusyId === selected.id} onClick={() => void handleStatus(selected.id, 'FULFILLED')}
                      className="rounded-lg border border-success/30 px-3 py-1.5 text-caption font-medium text-success hover:bg-success/10 disabled:opacity-50">
                      Mark fulfilled
                    </button>
                    <button type="button" disabled={actionBusyId === selected.id} onClick={() => void handleStatus(selected.id, 'CANCELLED')}
                      className="rounded-lg border border-border-subtle px-3 py-1.5 text-caption font-medium text-fg-secondary hover:bg-surface-2 disabled:opacity-50">
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              {actionError && <p className="text-caption text-error">{actionError}</p>}

              <div>
                <p className="mb-2 text-meta font-medium uppercase tracking-wide text-fg-muted">Items</p>
                <div className="space-y-1.5">
                  {selected.items.map((item, idx) => (
                    <div key={`${item.productId}-${idx}`} className="flex items-center justify-between text-caption text-fg">
                      <span>{item.quantity}× {item.name}</span>
                      <span className="text-fg-muted">{fmtCents(item.unitPriceCents * item.quantity)}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-border-subtle pt-2 text-caption font-medium text-fg">
                  <span>Total</span><span>{fmtCents(selected.totalCents)}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-caption">
                <div><p className="text-meta text-fg-muted">Channel</p><p className="mt-0.5 text-fg">{selected.sourceChannel}</p></div>
                <div><p className="text-meta text-fg-muted">Fulfillment</p><p className="mt-0.5 text-fg">{selected.fulfillmentMethod}</p></div>
                <div><p className="text-meta text-fg-muted">Placed</p><p className="mt-0.5 text-fg">{fmtDate(selected.createdAt)}</p></div>
                {selected.fulfilledAt && <div><p className="text-meta text-fg-muted">Fulfilled</p><p className="mt-0.5 text-fg">{fmtDate(selected.fulfilledAt)}</p></div>}
              </div>

              {selected.aiSummary && (
                <div>
                  <p className="text-meta font-medium uppercase tracking-wide text-fg-muted">AI summary</p>
                  <p className="mt-2 rounded-lg bg-surface-2 p-3 text-caption leading-6 text-fg-secondary">{selected.aiSummary}</p>
                </div>
              )}
              {selected.notes && (
                <div>
                  <p className="text-meta font-medium uppercase tracking-wide text-fg-muted">Notes</p>
                  <p className="mt-2 text-caption leading-6 text-fg-secondary">{selected.notes}</p>
                </div>
              )}
            </div>
          )
        }
      </aside>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; icon: typeof ShoppingBag }[] = [
  { id: 'overview',  label: 'Overview',  icon: ShoppingBag },
  { id: 'products',  label: 'Products',  icon: Package     },
  { id: 'orders',    label: 'Orders',    icon: ShoppingBag },
  { id: 'approvals', label: 'Approvals', icon: ThumbsUp    },
];

export function RetailOperationsPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [products, setProducts] = useState<ProductRec[]>([]);
  const [orders, setOrders] = useState<OrderRec[]>([]);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [pd, od, approvalData] = await Promise.all([
        api<{ products: ProductRec[] }>('/products'),
        api<{ orders: OrderRec[] }>('/orders'),
        platformApi<{ approvals: ActionRequestRec[] }>('/approvals/pending').catch(() => ({ approvals: [] })),
      ]);
      setProducts(pd.products);
      setOrders(od.orders);
      setPendingApprovalCount(approvalData.approvals.length);
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load retail operations'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const pendingOrderCount = orders.filter((o) => o.status === 'PENDING_APPROVAL' || o.status === 'PENDING_POLICY').length;

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-auto bg-surface-0">
      {/* Header */}
      <div className="border-b border-border-subtle bg-surface-1 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-meta uppercase tracking-widest text-fg-muted">Operations command centre</p>
            <h1 className="mt-1 text-2xl font-semibold text-fg">Retail Operations</h1>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-0 px-3 py-2 text-caption text-fg hover:bg-surface-2 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        {/* Tab nav */}
        <nav className="mt-4 flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            const badge = (id === 'orders' && pendingOrderCount > 0) ? pendingOrderCount : (id === 'approvals' && pendingApprovalCount > 0) ? pendingApprovalCount : null;
            return (
              <button key={id} type="button" onClick={() => setTab(id)}
                className={`relative inline-flex items-center gap-2 rounded-lg px-3 py-2 text-caption font-medium transition ${active ? 'bg-accent/10 text-accent' : 'text-fg-secondary hover:bg-surface-2 hover:text-fg'}`}>
                <Icon size={14} />
                {label}
                {badge != null && (
                  <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-error text-[10px] font-bold text-white">{badge > 9 ? '9+' : badge}</span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5">
        {error && (
          <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-error/30 bg-error/5 p-4 text-caption text-error">
            <span>{error}</span>
            <button type="button" onClick={() => void load()} className="rounded-lg border border-error/30 px-3 py-1.5 text-meta hover:bg-error/10">Try again</button>
          </div>
        )}
        {loading && !products.length && !orders.length && (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-fg-muted" />
          </div>
        )}

        {(!loading || products.length > 0 || orders.length > 0) && (
          <>
            {tab === 'overview' && <OverviewTab products={products} orders={orders} onGoTo={setTab} />}
            {tab === 'products' && <ProductsTab products={products} onProductsChange={() => void load()} />}
            {tab === 'orders' && <OrdersTab orders={orders} onOrdersChange={() => void load()} />}
            {tab === 'approvals' && <ApprovalsPanel />}
          </>
        )}
      </div>
    </main>
  );
}

