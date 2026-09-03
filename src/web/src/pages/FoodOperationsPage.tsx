import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock3, CookingPot, MapPin, PackageCheck, Phone, Plus, Search, Truck, Eye } from 'lucide-react';

type OrderStatus = 'New' | 'Preparing' | 'Ready' | 'Out for delivery';

const initialOrders = [
  { id: '#1048', customer: 'Alicia Green', items: '2 Chicken Roti, 1 Macaroni Pie', fulfilment: 'Pickup', status: 'New' as OrderStatus, total: '$30.00', time: '2 min ago' },
  { id: '#1047', customer: 'Jason Clarke', items: '1 Fish Cutter, 2 Banks', fulfilment: 'Delivery', status: 'Preparing' as OrderStatus, total: '$22.00', time: '7 min ago' },
  { id: '#1046', customer: 'Naomi King', items: '2 Beef Burgers, 1 Fries', fulfilment: 'Pickup', status: 'Ready' as OrderStatus, total: '$34.00', time: '12 min ago' },
  { id: '#1045', customer: 'David Lewis', items: '3 Chicken Rotis', fulfilment: 'Delivery', status: 'Out for delivery' as OrderStatus, total: '$36.00', time: '18 min ago' },
];

const menuItems = [
  { name: 'Chicken Roti', price: '$12.00', available: true },
  { name: 'Macaroni Pie', price: '$6.00', available: true },
  { name: 'Fish Cutter', price: '$10.00', available: true },
  { name: 'Fresh Juice', price: '$8.00', available: false },
];

const statusClass: Record<OrderStatus, string> = {
  New: 'bg-accent-soft text-accent',
  Preparing: 'bg-warning/15 text-warning',
  Ready: 'bg-success/15 text-success',
  'Out for delivery': 'bg-info/15 text-info',
};

export function FoodOperationsPage() {
  const [orders, setOrders] = useState(initialOrders);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<OrderStatus | 'All'>('All');

  const visibleOrders = useMemo(() => orders.filter((order) => {
    const matchesFilter = filter === 'All' || order.status === filter;
    const haystack = `${order.id} ${order.customer} ${order.items}`.toLowerCase();
    return matchesFilter && haystack.includes(query.toLowerCase());
  }), [filter, orders, query]);

  function advanceOrder(id: string) {
    setOrders((current) => current.map((order) => {
      if (order.id !== id) return order;
      const next: Record<OrderStatus, OrderStatus> = { New: 'Preparing', Preparing: 'Ready', Ready: 'Out for delivery', 'Out for delivery': 'Out for delivery' };
      return { ...order, status: next[order.status] };
    }));
  }

  const counts = Object.fromEntries((['New', 'Preparing', 'Ready', 'Out for delivery'] as OrderStatus[]).map((status) => [status, orders.filter((order) => order.status === status).length]));

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-surface-0 p-5 sm:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        {/*
          Real gap, not yet a real feature: this whole page is local React
          state (initialOrders/menuItems above) with no api.* call anywhere
          - "Advance" mutates the mock order in memory, nothing is
          persisted, and no real WhatsApp order ever reaches it. Shown as a
          convincing, fully-styled UI without this banner, it reads as a
          working feature to anyone previewing the food vertical (a real
          risk flagged directly: showing this in a live demo would be
          actively misleading). Every other unbuilt vertical already says
          so honestly via PlaceholderPage's "Not built yet" badge; Food
          just never got the same treatment because it looks real instead
          of blank.
        */}
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-caption text-fg-secondary">
          <Eye size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
          <p><span className="font-semibold text-fg">Preview only.</span> Orders and menu items below are sample data for illustration - this page isn't yet connected to real WhatsApp orders. Not built yet, same as the other in-progress verticals.</p>
        </div>

        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div><p className="text-meta font-semibold tracking-widest text-accent">FOOD OPERATIONS</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">Run the day from WhatsApp</h1><p className="mt-2 text-body text-fg-secondary">Orders, kitchen progress, menu availability and fulfilment in one workspace.</p></div>
          <div className="flex flex-wrap gap-2"><Link to="/chats" className="rounded-lg border border-border-subtle px-4 py-2 text-body font-medium hover:bg-surface-2">Open conversations</Link><button type="button" onClick={() => setFilter('New')} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-body font-semibold text-white hover:bg-accent-dim"><Plus size={17} /> New order</button></div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {([['New', Clock3], ['Preparing', CookingPot], ['Ready', PackageCheck], ['Out for delivery', Truck]] as const).map(([status, Icon]) => <button key={status} type="button" onClick={() => setFilter(status)} className="rounded-xl border border-border-subtle bg-surface-1 p-5 text-left hover:bg-surface-2"><div className="flex items-center justify-between"><span className="text-caption text-fg-muted">{status}</span><Icon size={19} className="text-accent" /></div><strong className="mt-3 block text-3xl">{counts[status]}</strong><span className="mt-2 block text-meta text-fg-muted">Active order{counts[status] === 1 ? '' : 's'}</span></button>)}
        </section>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.85fr)]">
          <div className="rounded-2xl border border-border-subtle bg-surface-1">
            <div className="flex flex-col gap-3 border-b border-border-subtle p-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-title font-semibold">Live orders</h2><p className="mt-1 text-caption text-fg-muted">Advance the operation without losing the customer context.</p></div><div className="relative"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search orders" className="w-full rounded-lg border border-border-subtle bg-surface-2 py-2 pl-9 pr-3 text-caption outline-none focus:border-accent sm:w-56" /></div></div>
            <div className="divide-y divide-border-subtle">{visibleOrders.map((order) => <article key={order.id} className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center"><div className="min-w-0 flex-1"><div className="flex items-center gap-3"><strong>{order.id}</strong><span className={`rounded-full px-2.5 py-1 text-meta font-medium ${statusClass[order.status]}`}>{order.status}</span></div><p className="mt-2 text-body font-medium">{order.customer}</p><p className="mt-1 text-caption text-fg-secondary">{order.items}</p><div className="mt-3 flex flex-wrap gap-3 text-meta text-fg-muted"><span>{order.fulfilment === 'Delivery' ? <Truck size={13} className="mr-1 inline" /> : <MapPin size={13} className="mr-1 inline" />}{order.fulfilment}</span><span>{order.time}</span><span className="font-semibold text-fg">{order.total}</span></div></div><div className="flex shrink-0 gap-2">{order.status !== 'Out for delivery' && <button type="button" onClick={() => advanceOrder(order.id)} className="rounded-lg bg-accent px-3 py-2 text-caption font-semibold text-white hover:bg-accent-dim">Advance</button>}<Link to="/chats" className="rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium hover:bg-surface-2">Chat</Link></div></article>)}{visibleOrders.length === 0 && <div className="p-10 text-center text-body text-fg-muted">No orders match this view.</div>}</div>
          </div>

          <aside className="space-y-6">
            <div className="rounded-2xl border border-border-subtle bg-surface-1 p-5"><div className="flex items-center justify-between"><div><h2 className="text-title font-semibold">Menu availability</h2><p className="mt-1 text-caption text-fg-muted">What the Food Agent should offer now.</p></div><button type="button" className="rounded-lg border border-border-subtle px-3 py-2 text-caption font-medium hover:bg-surface-2">Manage menu</button></div><div className="mt-5 space-y-3">{menuItems.map((item) => <div key={item.name} className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-3"><div><p className="text-caption font-medium">{item.name}</p><p className="text-meta text-fg-muted">{item.price}</p></div><span className={`rounded-full px-2.5 py-1 text-meta ${item.available ? 'bg-success/15 text-success' : 'bg-surface-3 text-fg-muted'}`}>{item.available ? 'Available' : 'Paused'}</span></div>)}</div></div>
            <div className="rounded-2xl border border-border-subtle bg-surface-1 p-5"><h2 className="text-title font-semibold">Customer handoff</h2><p className="mt-2 text-caption leading-6 text-fg-secondary">Your AI agent stays behind the conversation. Your team only sees the order, customer context and next action.</p><div className="mt-4 grid gap-2 text-caption"><button type="button" className="flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-left hover:bg-surface-2"><Phone size={15} className="text-accent" /> Review customer contact</button><button type="button" className="flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-left hover:bg-surface-2"><CheckCircle2 size={15} className="text-success" /> Escalate to human</button></div></div>
          </aside>
        </section>
      </div>
    </div>
  );
}
