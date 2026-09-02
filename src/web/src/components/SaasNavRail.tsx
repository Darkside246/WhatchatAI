import { NavLink, useLocation } from 'react-router-dom';
import {
  MessageCircle, BarChart3, Bot, Contact, Zap, Megaphone, Mail, CreditCard, Settings,
  Building2, CookingPot, Store, Truck, UsersRound, Receipt, ShoppingBag, Scissors,
  Car, Stethoscope, Scale, Hotel, HardHat, Package, KeyRound, History, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth.js';

export type ProductNav =
  | 'platform' | 'property' | 'food' | 'retail' | 'beauty'
  | 'auto' | 'health' | 'legal' | 'hospitality' | 'construction' | 'logistics';

type NavItem = { to: string; label: string; icon: LucideIcon };

const NAV_ITEMS: Record<ProductNav, NavItem[]> = {
  platform: [
    { to: '/chats',               label: 'Inbox',              icon: MessageCircle },
    { to: '/dashboard',           label: 'Dashboard',          icon: BarChart3 },
    { to: '/agents',              label: 'AI Agents',          icon: Bot },
    { to: '/crm',                 label: 'CRM & Leads',        icon: Contact },
    { to: '/property-operations', label: 'Property Ops',       icon: Building2 },
    { to: '/invoices',            label: 'Invoices',           icon: Receipt },
    { to: '/automations',         label: 'Automations',        icon: Zap },
    { to: '/marketing',           label: 'Marketing',          icon: Megaphone },
    { to: '/email',               label: 'Email',              icon: Mail },
    { to: '/billing',             label: 'Billing',            icon: CreditCard },
    { to: '/activity-log',        label: 'Activity Log',       icon: History },
    { to: '/settings',            label: 'Settings',           icon: Settings },
  ],
  property: [
    { to: '/property',            label: 'Overview',           icon: BarChart3 },
    { to: '/chats',               label: 'Conversations',      icon: MessageCircle },
    { to: '/property-operations', label: 'Maintenance',        icon: Building2 },
    { to: '/invoices',            label: 'Invoices',           icon: Receipt },
    { to: '/crm',                 label: 'Tenants',            icon: UsersRound },
    { to: '/agents',              label: 'Property Agent',     icon: Bot },
    { to: '/activity-log',        label: 'Activity Log',       icon: History },
    { to: '/settings',            label: 'Settings',           icon: Settings },
  ],
  food: [
    { to: '/food',                label: 'Overview',           icon: BarChart3 },
    { to: '/food/operations',     label: 'Orders & Kitchen',   icon: CookingPot },
    { to: '/chats',               label: 'Conversations',      icon: MessageCircle },
    { to: '/crm',                 label: 'Customers',          icon: UsersRound },
    { to: '/agents',              label: 'Food Agent',         icon: Bot },
    { to: '/settings',            label: 'Settings',           icon: Settings },
  ],
  retail: [
    { to: '/retail',              label: 'Overview',           icon: BarChart3 },
    { to: '/chats',               label: 'Conversations',      icon: MessageCircle },
    { to: '/retail/operations',   label: 'Orders & Stock',     icon: ShoppingBag },
    { to: '/invoices',            label: 'Invoices',           icon: Receipt },
    { to: '/crm',                 label: 'Customers',          icon: UsersRound },
    { to: '/marketing',           label: 'Marketing',          icon: Megaphone },
    { to: '/agents',              label: 'Sales Agent',        icon: Bot },
    { to: '/settings',            label: 'Settings',           icon: Settings },
  ],
  beauty: [
    { to: '/beauty',              label: 'Overview',           icon: BarChart3 },
    { to: '/chats',               label: 'Conversations',      icon: MessageCircle },
    { to: '/beauty/operations',   label: 'Bookings',           icon: Scissors },
    { to: '/invoices',            label: 'Invoices',           icon: Receipt },
    { to: '/crm',                 label: 'Clients',            icon: UsersRound },
    { to: '/marketing',           label: 'Marketing',          icon: Megaphone },
    { to: '/agents',              label: 'Booking Agent',      icon: Bot },
    { to: '/settings',            label: 'Settings',           icon: Settings },
  ],
  auto: [
    { to: '/auto',                label: 'Overview',           icon: BarChart3 },
    { to: '/chats',               label: 'Conversations',      icon: MessageCircle },
    { to: '/auto/operations',     label: 'Jobs & Vehicles',    icon: Car },
    { to: '/invoices',            label: 'Invoices',           icon: Receipt },
    { to: '/crm',                 label: 'Customers',          icon: UsersRound },
    { to: '/marketing',           label: 'Marketing',          icon: Megaphone },
    { to: '/agents',              label: 'Service Agent',      icon: Bot },
    { to: '/settings',            label: 'Settings',           icon: Settings },
  ],
  health: [
    { to: '/health',              label: 'Overview',           icon: BarChart3 },
    { to: '/chats',               label: 'Conversations',      icon: MessageCircle },
    { to: '/health/operations',   label: 'Appointments',       icon: Stethoscope },
    { to: '/invoices',            label: 'Invoices',           icon: Receipt },
    { to: '/crm',                 label: 'Patients',           icon: UsersRound },
    { to: '/marketing',           label: 'Communications',     icon: Megaphone },
    { to: '/agents',              label: 'Care Agent',         icon: Bot },
    { to: '/settings',            label: 'Settings',           icon: Settings },
  ],
  legal: [
    { to: '/legal',               label: 'Overview',           icon: BarChart3 },
    { to: '/chats',               label: 'Conversations',      icon: MessageCircle },
    { to: '/legal/operations',    label: 'Cases & Clients',    icon: Scale },
    { to: '/invoices',            label: 'Invoices',           icon: Receipt },
    { to: '/crm',                 label: 'Clients',            icon: UsersRound },
    { to: '/agents',              label: 'Legal Agent',        icon: Bot },
    { to: '/settings',            label: 'Settings',           icon: Settings },
  ],
  hospitality: [
    { to: '/hospitality',             label: 'Overview',       icon: BarChart3 },
    { to: '/chats',                   label: 'Conversations',  icon: MessageCircle },
    { to: '/hospitality/operations',  label: 'Bookings',       icon: Hotel },
    { to: '/invoices',                label: 'Invoices',       icon: Receipt },
    { to: '/crm',                     label: 'Guests',         icon: UsersRound },
    { to: '/marketing',               label: 'Marketing',      icon: Megaphone },
    { to: '/agents',                  label: 'Guest Agent',    icon: Bot },
    { to: '/settings',                label: 'Settings',       icon: Settings },
  ],
  construction: [
    { to: '/construction',            label: 'Overview',       icon: BarChart3 },
    { to: '/chats',                   label: 'Conversations',  icon: MessageCircle },
    { to: '/construction/operations', label: 'Projects',       icon: HardHat },
    { to: '/invoices',                label: 'Invoices',       icon: Receipt },
    { to: '/crm',                     label: 'Clients',        icon: UsersRound },
    { to: '/agents',                  label: 'Site Agent',     icon: Bot },
    { to: '/settings',                label: 'Settings',       icon: Settings },
  ],
  logistics: [
    { to: '/logistics',               label: 'Overview',       icon: BarChart3 },
    { to: '/chats',                   label: 'Conversations',  icon: MessageCircle },
    { to: '/logistics/operations',    label: 'Deliveries',     icon: Package },
    { to: '/crm',                     label: 'Customers',      icon: UsersRound },
    { to: '/marketing',               label: 'Notifications',  icon: Megaphone },
    { to: '/agents',                  label: 'Dispatch Agent', icon: Bot },
    { to: '/settings',                label: 'Settings',       icon: Settings },
  ],
};

/** Derive product from URL — used only for developer (platform-wide) navigation. */
function productFromPath(pathname: string): ProductNav {
  if (pathname.startsWith('/food'))         return 'food';
  if (pathname === '/property' || pathname.startsWith('/property/')) return 'property';
  if (pathname === '/retail' || pathname.startsWith('/retail/'))     return 'retail';
  if (pathname === '/beauty' || pathname.startsWith('/beauty/'))     return 'beauty';
  if (pathname === '/auto' || pathname.startsWith('/auto/'))         return 'auto';
  if (pathname === '/health' || pathname.startsWith('/health/'))     return 'health';
  if (pathname === '/legal' || pathname.startsWith('/legal/'))       return 'legal';
  if (pathname === '/hospitality' || pathname.startsWith('/hospitality/')) return 'hospitality';
  if (pathname === '/construction' || pathname.startsWith('/construction/')) return 'construction';
  if (pathname === '/logistics' || pathname.startsWith('/logistics/')) return 'logistics';
  return 'platform';
}

function NavRailItem({ item }: { item: NavItem }) {
  return (
    <NavLink
      key={`${item.label}-${item.to}`}
      to={item.to}
      className={({ isActive }) =>
        `flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
          isActive ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-2 hover:text-fg-secondary'
        }`
      }
      title={item.label}
    >
      <item.icon size={20} strokeWidth={1.75} aria-hidden />
    </NavLink>
  );
}

export function SaasNavRail() {
  const location = useLocation();
  const { business } = useAuth();

  let product: ProductNav;
  if (business?.isDeveloper) {
    // Developers see the full platform nav + can browse any vertical by URL.
    product = productFromPath(location.pathname);
  } else if (business?.productKey && business.productKey in NAV_ITEMS) {
    // Customers are locked to their purchased vertical.
    product = business.productKey as ProductNav;
  } else {
    product = 'platform';
  }

  const items = NAV_ITEMS[product];

  return (
    <nav className="hidden w-16 shrink-0 flex-col items-center gap-1 border-r border-border-subtle bg-surface-1 py-4 md:flex">
      <NavLink
        to="/"
        className="mb-4 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-accent-soft text-body font-bold text-accent"
        title={business?.name ?? 'AURA'}
      >
        {business?.logoDataUrl ? (
          <img src={business.logoDataUrl} alt="" className="h-full w-full object-contain" />
        ) : (
          'W'
        )}
      </NavLink>
      {items.map((item) => <NavRailItem key={`${item.label}-${item.to}`} item={item} />)}
      {business?.isDeveloper && (
        <NavLink
          to="/developer"
          className={({ isActive }) =>
            `mt-auto flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
              isActive ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-2 hover:text-fg-secondary'
            }`
          }
          title="Developer Panel"
        >
          <KeyRound size={20} strokeWidth={1.75} aria-hidden />
        </NavLink>
      )}
    </nav>
  );
}

export function SaasNavBottomBar() {
  const location = useLocation();
  const { business } = useAuth();

  let product: ProductNav;
  if (business?.isDeveloper) {
    product = productFromPath(location.pathname);
  } else if (business?.productKey && business.productKey in NAV_ITEMS) {
    product = business.productKey as ProductNav;
  } else {
    product = 'platform';
  }

  const items = NAV_ITEMS[product].slice(0, 5);

  return (
    <nav className="flex shrink-0 items-center justify-around border-t border-border-subtle bg-surface-1 py-2 md:hidden">
      {items.map((item) => (
        <NavLink
          key={`${item.label}-${item.to}`}
          to={item.to}
          className={({ isActive }) =>
            `flex h-10 w-10 items-center justify-center rounded-lg ${isActive ? 'bg-accent-soft text-accent' : 'text-fg-muted'}`
          }
          title={item.label}
        >
          <item.icon size={20} strokeWidth={1.75} aria-hidden />
        </NavLink>
      ))}
    </nav>
  );
}

export { NAV_ITEMS, productFromPath as currentProduct };
