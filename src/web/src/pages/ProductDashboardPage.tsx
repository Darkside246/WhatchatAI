import { Link } from 'react-router-dom';

type Product = 'property' | 'food' | 'retail' | 'beauty' | 'auto' | 'health';

const copy: Record<Product, { name: string; description: string; sections: Array<[string, string, string]> }> = {
  property: {
    name: 'WhatsChat Property',
    description: 'Property operations powered by the conversations already happening on WhatsApp.',
    sections: [
      ['Conversations', 'Review tenant and team conversations in one operational inbox.', '/chats'],
      ['Maintenance', 'Triage issues, safety signals and maintenance requests.', '/property-operations'],
      ['Work Orders', 'Track assigned and pending operational work.', '/property-operations'],
      ['Properties', 'Manage property-level operational context.', '/property-operations'],
      ['Vendors', 'Coordinate contractors and vendors around work.', '/property-operations'],
      ['Invoices', 'Create and manage tenant invoices.', '/invoices'],
      ['Reports', 'Review operational performance and activity.', '/dashboard'],
      ['Settings', 'Manage product and connection settings.', '/settings'],
    ],
  },
  food: {
    name: 'WhatsChat Food',
    description: 'A focused food ordering and operations workspace built around WhatsApp.',
    sections: [
      ['Conversations', 'Handle customer messages without leaving the operations workspace.', '/chats'],
      ['Orders', 'Review incoming, active and completed food orders.', '/food/operations'],
      ['Menu', 'Manage menu items, availability and prices.', '/food/operations'],
      ['Kitchen', 'Coordinate preparation and operational status.', '/food/operations'],
      ['Pickup & Delivery', 'Track fulfilment, pickup and delivery details.', '/food/operations'],
      ['Customers', 'Review customer context and repeat orders.', '/crm'],
      ['Reports', 'Monitor demand and operational performance.', '/dashboard'],
      ['Settings', 'Manage product and connection settings.', '/settings'],
    ],
  },
  retail: {
    name: 'WhatsChat Retail',
    description: 'Run your shop, boutique or store from WhatsApp — orders, stock, and customer conversations in one place.',
    sections: [
      ['Conversations', 'Handle enquiries and orders as WhatsApp messages.', '/chats'],
      ['Orders & Stock', 'Track incoming orders and inventory levels.', '/retail/operations'],
      ['Product Catalogue', 'Manage your items, prices and availability.', '/retail/operations'],
      ['Invoices', 'Generate and send invoices directly to customers.', '/invoices'],
      ['Customers', 'View purchase history and customer profiles.', '/crm'],
      ['Marketing', 'Broadcast promotions and campaigns via WhatsApp.', '/marketing'],
      ['AI Sales Agent', 'Let AI handle product queries and order capture 24/7.', '/agents'],
      ['Settings', 'Manage product and connection settings.', '/settings'],
    ],
  },
  beauty: {
    name: 'WhatsChat Beauty',
    description: 'Bookings, client management and reminders for salons, spas, and beauty studios — all from WhatsApp.',
    sections: [
      ['Conversations', 'Chat with clients and handle booking requests.', '/chats'],
      ['Bookings', 'View and manage your appointment calendar.', '/beauty/operations'],
      ['Services & Pricing', 'Set up your service menu and pricing.', '/beauty/operations'],
      ['Invoices', 'Send receipts and invoices after appointments.', '/invoices'],
      ['Clients', 'Track client preferences, history and notes.', '/crm'],
      ['Marketing', 'Send promotions, reminders and follow-ups.', '/marketing'],
      ['AI Booking Agent', 'Let AI book and confirm appointments automatically.', '/agents'],
      ['Settings', 'Manage product and connection settings.', '/settings'],
    ],
  },
  auto: {
    name: 'WhatsChat Auto',
    description: 'Job management, invoicing and customer communication for auto dealers, garages, and rental operators.',
    sections: [
      ['Conversations', 'Handle service requests and customer messages.', '/chats'],
      ['Jobs & Vehicles', 'Track service jobs, vehicle status and technicians.', '/auto/operations'],
      ['Estimates & Quotes', 'Create and send quotes via WhatsApp.', '/auto/operations'],
      ['Invoices', 'Invoice customers after repairs or sales.', '/invoices'],
      ['Customers', 'View vehicle history and customer records.', '/crm'],
      ['Marketing', 'Run service reminders and promotions.', '/marketing'],
      ['AI Service Agent', 'Capture bookings and answer queries 24/7.', '/agents'],
      ['Settings', 'Manage product and connection settings.', '/settings'],
    ],
  },
  health: {
    name: 'WhatsChat Health',
    description: 'Appointment scheduling, patient communication and reminders for clinics, pharmacies, and care providers.',
    sections: [
      ['Conversations', 'Communicate with patients securely over WhatsApp.', '/chats'],
      ['Appointments', 'Schedule and confirm patient visits.', '/health/operations'],
      ['Patient Records', 'Maintain basic visit notes and contact details.', '/health/operations'],
      ['Invoices', 'Generate consultation or service invoices.', '/invoices'],
      ['Patients', 'View patient history and contact information.', '/crm'],
      ['Communications', 'Send health tips, reminders and follow-ups.', '/marketing'],
      ['AI Care Agent', 'Answer FAQs and handle appointment requests.', '/agents'],
      ['Settings', 'Manage product and connection settings.', '/settings'],
    ],
  },
};

export function ProductDashboardPage({ product }: { product: Product }) {
  const config = copy[product];
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-surface-0 p-5 sm:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="rounded-2xl border border-border-subtle bg-surface-1 p-6 sm:p-8">
          <p className="text-meta font-semibold tracking-widest text-accent">PRODUCT WORKSPACE</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">{config.name}</h1>
          <p className="mt-3 max-w-2xl text-body leading-7 text-fg-secondary">{config.description}</p>
          <div className="mt-6 flex flex-wrap gap-3 text-caption">
            <span className="rounded-full bg-success/15 px-3 py-1.5 text-success">WhatsApp connection managed separately</span>
            <span className="rounded-full bg-surface-2 px-3 py-1.5 text-fg-secondary">Focused product navigation</span>
          </div>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {config.sections.map(([title, description, to]) => (
            <Link key={title} to={to} className="rounded-xl border border-border-subtle bg-surface-1 p-5 transition hover:border-accent/50 hover:bg-surface-2">
              <h2 className="text-title font-semibold">{title}</h2>
              <p className="mt-2 text-caption leading-6 text-fg-secondary">{description}</p>
              <span className="mt-4 inline-block text-caption font-semibold text-accent">Open {title} →</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
