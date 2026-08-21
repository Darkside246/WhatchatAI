import { isValidTimezone } from '../../repositories/businessRepository.js';

export const SYSTEM_FALLBACK_TIMEZONE = 'UTC';

function firstValid(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && isValidTimezone(candidate)) return candidate;
  }
  return null;
}

export interface BusinessTimezoneInput {
  timezone: string | null | undefined;
}

/** Business priority: explicit business timezone -> system fallback (no account/location tier exists yet - single business per deployment today). */
export function resolveBusinessTimezone(input: BusinessTimezoneInput): string {
  return firstValid(input.timezone) ?? SYSTEM_FALLBACK_TIMEZONE;
}

export interface UserTimezoneInput {
  explicitTimezone?: string | null;
  browserTimezone?: string | null;
}

/** User priority: explicit preference -> browser/device-reported zone -> account (business) default -> system fallback. */
export function resolveUserTimezone(input: UserTimezoneInput, accountDefaultTimezone: string): string {
  return firstValid(input.explicitTimezone, input.browserTimezone, accountDefaultTimezone) ?? SYSTEM_FALLBACK_TIMEZONE;
}

export interface CustomerTimezoneInput {
  explicitTimezone?: string | null;
  locationDerivedTimezone?: string | null;
}

/**
 * Customer priority: explicit customer timezone -> location-derived timezone
 * -> business default -> system fallback. WhatchatAI has no per-contact
 * timezone field yet (no location/device signal is ever collected from a
 * WhatsApp customer today), so in practice this always resolves to the
 * business default - the full chain is implemented so a future explicit or
 * location-derived customer timezone slots in without changing any caller.
 */
export function resolveCustomerTimezone(input: CustomerTimezoneInput, businessDefaultTimezone: string): string {
  return firstValid(input.explicitTimezone, input.locationDerivedTimezone, businessDefaultTimezone) ?? SYSTEM_FALLBACK_TIMEZONE;
}
