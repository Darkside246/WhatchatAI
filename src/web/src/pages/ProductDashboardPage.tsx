import { Link } from 'react-router-dom';

type Product = 'property' | 'food' | 'retail' | 'beauty' | 'auto' | 'health' | 'legal' | 'hospitality' | 'construction' | 'logistics';

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
  legal: {
    name: 'WhatsChat Legal',
    description: 'Client intake, case enquiries and document requests for law practices — all via WhatsApp.',
    sections: [
      ['Conversations', 'Handle client enquiries and intake via WhatsApp.', '/chats'],
      ['Cases & Clients', 'Manage active cases and client contact records.', '/legal/operations'],
      ['Document Requests', 'Track document submissions and outstanding items.', '/legal/operations'],
      ['Consultations', 'Schedule and log consultation sessions.', '/legal/operations'],
      ['Invoices', 'Issue legal service invoices and receipts.', '/invoices'],
      ['Clients', 'View full client history and communication records.', '/crm'],
      ['AI Legal Agent', 'Answer intake questions and direct enquiries.', '/agents'],
      ['Settings', 'Manage product and connection settings.', '/settings'],
    ],
  },
  hospitality: {
    name: 'WhatsChat Hospitality',
    description: 'Room bookings, guest services and housekeeping coordination for hotels and short-stay properties.',
    sections: [
      ['Conversations', 'Respond to guest messages and booking requests.', '/chats'],
      ['Bookings & Rooms', 'Manage room availability, check-ins and check-outs.', '/hospitality/operations'],
      ['Housekeeping', 'Coordinate cleaning schedules and room status.', '/hospitality/operations'],
      ['Guest Services', 'Handle special requests and concierge tasks.', '/hospitality/operations'],
      ['Invoices', 'Generate guest folios and stay invoices.', '/invoices'],
      ['Guests', 'View guest profiles, preferences and history.', '/crm'],
      ['AI Guest Agent', 'Answer FAQs and capture booking requests.', '/agents'],
      ['Settings', 'Manage product and connection settings.', '/settings'],
    ],
  },
  construction: {
    name: 'WhatsChat Construction',
    description: 'Project tracking, subcontractor coordination and client communication for construction and trade businesses.',
    sections: [
      ['Conversations', 'Communicate with clients and contractors over WhatsApp.', '/chats'],
      ['Projects', 'Track active projects, milestones and progress.', '/construction/operations'],
      ['Subcontractors', 'Coordinate trades, schedules and site assignments.', '/construction/operations'],
      ['Materials', 'Track material orders, deliveries and on-site stock.', '/construction/operations'],
      ['Invoices', 'Create and send progress and completion invoices.', '/invoices'],
      ['Clients', 'Manage client contact records and job history.', '/crm'],
      ['AI Site Agent', 'Handle enquiries and status updates automatically.', '/agents'],
      ['Settings', 'Manage product and connection settings.', '/settings'],
    ],
  },
  logistics: {
    name: 'WhatsChat Logistics',
    description: 'Delivery tracking, route management and real-time customer notifications for logistics and courier businesses.',
    sections: [
      ['Conversations', 'Handle delivery enquiries and customer messages.', '/chats'],
      ['Deliveries', 'Track active shipments, status and proof of delivery.', '/logistics/operations'],
      ['Routes', 'Plan and optimise daily delivery routes.', '/logistics/operations'],
      ['Driver Dispatch', 'Assign and communicate with drivers in real time.', '/logistics/operations'],
      ['Customers', 'View customer delivery history and preferences.', '/crm'],
      ['Notifications', 'Send automated delivery status messages.', '/marketing'],
      ['AI Dispatch Agent', 'Answer status queries and capture delivery requests.', '/agents'],
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
