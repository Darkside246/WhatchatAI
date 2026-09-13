import {
  Building2, Car, CookingPot, HardHat, Hotel, Package, Scale, Scissors, ShoppingBag, Stethoscope,
  type LucideIcon,
} from 'lucide-react';

/**
 * The verticals AURA can run a business as.
 *
 * One list, because there were previously several: the nav rail knew the
 * icons, ProductDashboardPage knew the names and descriptions, and the
 * router knew which operations pages actually exist. Nothing kept them
 * agreeing, and they had already drifted - the platform nav offered Property
 * Ops and Retail Ops but no way at all to reach Food, which is a whole
 * vertical that only a typed URL could open.
 *
 * `operations` is the real operations screen where one is built and null
 * where it is not, taken from the router rather than asserted here - so a
 * tile cannot promise a page that renders "coming soon".
 */

export type ProductKey =
  | 'property' | 'food' | 'retail' | 'beauty' | 'auto'
  | 'health' | 'legal' | 'hospitality' | 'construction' | 'logistics';

export interface ProductEntry {
  key: ProductKey;
  name: string;
  description: string;
  icon: LucideIcon;
  /** The vertical's own overview, which is also where its nav appears. */
  overview: string;
  /** Its operations screen, or null while that screen is still a placeholder. */
  operations: string | null;
}

/**
 * Ordered so the three verticals that genuinely work come first. The names
 * and descriptions are the ones the product dashboards already show - not a
 * second set written for this page.
 */
export const PRODUCTS: ProductEntry[] = [
  {
    key: 'food',
    name: 'AURA Food',
    description: 'A focused food ordering and operations workspace built around WhatsApp.',
    icon: CookingPot,
    overview: '/food',
    operations: '/food/operations',
  },
  {
    key: 'property',
    name: 'AURA Property',
    description: 'Property operations powered by the conversations already happening on WhatsApp.',
    icon: Building2,
    overview: '/property',
    // The flat path, not '/property/operations', because that is the one the
    // property vertical's own nav uses for Maintenance - the two render the
    // same screen, and a tile that sent you to the other one would leave
    // that nav item unhighlighted on the page it opened. The duplicate pair
    // of paths is older than this file and left alone deliberately.
    operations: '/property-operations',
  },
  {
    key: 'retail',
    name: 'AURA Retail',
    description: 'Run your shop, boutique or store from WhatsApp — orders, stock, and customer conversations in one place.',
    icon: ShoppingBag,
    overview: '/retail',
    operations: '/retail/operations',
  },
  {
    key: 'beauty',
    name: 'AURA Beauty',
    description: 'Bookings, client management and reminders for salons, spas, and beauty studios — all from WhatsApp.',
    icon: Scissors,
    overview: '/beauty',
    operations: null,
  },
  {
    key: 'auto',
    name: 'AURA Auto',
    description: 'Job management, invoicing and customer communication for auto dealers, garages, and rental operators.',
    icon: Car,
    overview: '/auto',
    operations: null,
  },
  {
    key: 'health',
    name: 'AURA Health',
    description: 'Appointment scheduling, patient communication and reminders for clinics, pharmacies, and care providers.',
    icon: Stethoscope,
    overview: '/health',
    operations: null,
  },
  {
    key: 'legal',
    name: 'AURA Legal',
    description: 'Client intake, case enquiries and document requests for law practices — all via WhatsApp.',
    icon: Scale,
    overview: '/legal',
    operations: null,
  },
  {
    key: 'hospitality',
    name: 'AURA Hospitality',
    description: 'Room bookings, guest services and housekeeping coordination for hotels and short-stay properties.',
    icon: Hotel,
    overview: '/hospitality',
    operations: null,
  },
  {
    key: 'construction',
    name: 'AURA Construction',
    description: 'Project tracking, subcontractor coordination and client communication for construction and trade businesses.',
    icon: HardHat,
    overview: '/construction',
    operations: null,
  },
  {
    key: 'logistics',
    name: 'AURA Logistics',
    description: 'Delivery tracking, route management and real-time customer notifications for logistics and courier businesses.',
    icon: Package,
    overview: '/logistics',
    operations: null,
  },
];

/** Where the "Business Types" tiles live. One constant, so the nav and the route cannot disagree about the path. */
export const BUSINESS_TYPES_PATH = '/business-types';
