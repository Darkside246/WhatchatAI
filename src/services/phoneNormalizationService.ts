import { parsePhoneNumberFromString } from 'libphonenumber-js';

export class InvalidPhoneNumberError extends Error {}

/**
 * Normalizes a phone number to E.164 (e.g. "+14155552671"). No default
 * country is assumed - the input must already carry its own country code
 * (a leading '+' or international dialing prefix), the same "already
 * normalized at the edge" expectation trialPolicy.ts's normalizeTrialEmail
 * already places on email input. Two inputs that represent the same real
 * number in different formats (spacing, a leading '00' vs '+') always
 * normalize to the identical E.164 string, which is what makes the
 * fingerprint-based dedup in phoneFingerprint.ts actually work.
 */
export function normalizePhoneToE164(rawPhone: string): string {
  const parsed = parsePhoneNumberFromString(rawPhone.trim());
  if (!parsed || !parsed.isValid()) {
    throw new InvalidPhoneNumberError('Enter a valid phone number, including country code.');
  }
  return parsed.number;
}
