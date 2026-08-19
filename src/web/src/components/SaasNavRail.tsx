import { NavLink } from 'react-router-dom';
import {
  MessageCircle,
  BarChart3,
  Bot,
  Contact,
  Zap,
  Megaphone,
  CreditCard,
  Settings,
  type LucideIcon,
} from 'lucide-react';

const NAV_ITEMS: { to: string; label: string; icon: LucideIcon; implemented: boolean }[] = [
  { to: '/chats', label: 'Inbox', icon: MessageCircle, implemented: true },
  { to: '/dashboard', label: 'Dashboard', icon: BarChart3, implemented: true },
  { to: '/agents', label: 'AI Agents', icon: Bot, implemented: true },
  { to: '/crm', label: 'CRM & Leads', icon: Contact, implemented: true },
  { to: '/automations', label: 'Automations', icon: Zap, implemented: false },
  { to: '/marketing', label: 'Marketing', icon: Megaphone, implemented: false },
  { to: '/billing', label: 'Billing', icon: CreditCard, implemented: true },
  { to: '/settings', label: 'Settings', icon: Settings, implemented: true },
];

export function SaasNavRail() {
  return (
    <nav className="hidden w-16 shrink-0 flex-col items-center gap-1 border-r border-border-subtle bg-surface-1 py-4 md:flex">
      <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-sm font-bold text-accent">
        W
      </div>
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            `flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
              isActive ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-2 hover:text-fg-secondary'
            }`
          }
          title={item.implemented ? item.label : `${item.label} (coming soon)`}
        >
          <item.icon size={20} strokeWidth={1.75} aria-hidden />
        </NavLink>
      ))}
    </nav>
  );
}

export function SaasNavBottomBar() {
  return (
    <nav className="flex shrink-0 items-center justify-around border-t border-border-subtle bg-surface-1 py-2 md:hidden">
      {NAV_ITEMS.slice(0, 5).map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            `flex h-10 w-10 items-center justify-center rounded-lg ${
              isActive ? 'bg-accent-soft text-accent' : 'text-fg-muted'
            }`
          }
        >
          <item.icon size={20} strokeWidth={1.75} aria-hidden />
        </NavLink>
      ))}
    </nav>
  );
}

export { NAV_ITEMS };
