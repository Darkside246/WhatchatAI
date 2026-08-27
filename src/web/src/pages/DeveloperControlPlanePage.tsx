import { Activity, Bot, CreditCard, Database, Gauge, KeyRound, Radio, ShieldCheck, Users } from 'lucide-react';

const surfaces = [
  ['Clients', 'Client identities, product accounts and provisioning', Users, '/crm'],
  ['Product accounts', 'Property and Food account boundaries and entitlements', Database, '/property'],
  ['Trials', '48-hour trial lifecycle and expiry monitoring', Activity, '/billing'],
  ['WhatsApp connections', 'Connection health, pairing state and operational scope', Radio, '/settings'],
  ['AI agents', 'Specialist agents, runtime state and human escalation', Bot, '/agents'],
  ['AI providers', 'Provider configuration, model routing and fallbacks', Gauge, '/agents'],
  ['Billing', 'Payment status, subscriptions and provider verification', CreditCard, '/billing'],
  ['Security & audit', 'Permissions, audit trails and operational policy boundaries', ShieldCheck, '/settings'],
];

export function DeveloperControlPlanePage() {
  return <div className="min-h-0 flex-1 overflow-auto bg-surface-0 p-5 sm:p-8"><div className="mx-auto max-w-7xl space-y-6"><section className="rounded-2xl border border-border-subtle bg-surface-1 p-6 sm:p-8"><div className="flex items-start gap-4"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><KeyRound size={22} /></div><div><p className="text-meta font-semibold tracking-widest text-accent">DEVELOPER CONTROL PLANE</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">Platform administration</h1><p className="mt-3 max-w-3xl text-body leading-7 text-fg-secondary">This is the platform-level surface for the developer. Client dashboards remain product-specific and do not expose provider, routing or cross-client controls.</p></div></div></section><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{surfaces.map(([title, description, Icon, to]) => <a key={title} href={to} className="rounded-xl border border-border-subtle bg-surface-1 p-5 transition hover:border-accent/50 hover:bg-surface-2"><Icon size={21} className="text-accent" /><h2 className="mt-4 text-title font-semibold">{title}</h2><p className="mt-2 text-caption leading-6 text-fg-secondary">{description}</p><span className="mt-4 inline-block text-caption font-semibold text-accent">Open surface →</span></a>)}</section><section className="rounded-2xl border border-border-subtle bg-surface-1 p-6"><h2 className="text-title font-semibold">Platform boundary check</h2><div className="mt-4 grid gap-3 text-caption text-fg-secondary md:grid-cols-3"><div className="rounded-xl bg-surface-2 p-4"><strong className="block text-fg">Clients</strong><span className="mt-1 block">Only their selected product and account data.</span></div><div className="rounded-xl bg-surface-2 p-4"><strong className="block text-fg">Product accounts</strong><span className="mt-1 block">Separate tenant, billing, connection and audit boundaries.</span></div><div className="rounded-xl bg-surface-2 p-4"><strong className="block text-fg">Developer</strong><span className="mt-1 block">Cross-platform visibility and provisioning authority.</span></div></div></section></div></div>;
}
