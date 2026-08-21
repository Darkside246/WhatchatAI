/**
 * Presentation-only resolver for how a connected WhatsApp identity is
 * labelled in the UI. It never touches the underlying session/account
 * identifier (jid, account id) - callers keep using those for anything that
 * actually references the connection. This only decides what a human reads.
 *
 * Priority, matching what a real operator would find least to most
 * ambiguous:
 *   1. A business-set display name for this account (not yet configurable
 *      anywhere in the product - the field exists in the schema for when it
 *      is - so this is always undefined today and the chain falls through).
 *   2. WhatsApp's own reported profile name (pushName) - the same name the
 *      person's contacts see for them on WhatsApp.
 *   3. The phone number.
 *   4. A stable fallback label, so a fully-unresolvable identity is never
 *      left blank.
 *
 * When a name resolves, the phone number (if also known) is returned as a
 * secondary line rather than being dropped - "John Smith" alone doesn't tell
 * an operator with several connected numbers which one they're looking at.
 */
export interface WhatsAppDisplayNameInput {
  /** A business-set label for the account, once that becomes configurable. Always undefined today. */
  accountName?: string | null;
  /** WhatsApp's own reported profile name for the connected number. */
  pushName?: string | null;
  phoneNumber?: string | null;
}

export interface WhatsAppDisplayIdentity {
  primary: string;
  secondary: string | null;
}

const DEFAULT_FALLBACK_LABEL = 'Line 1';

function cleaned(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getWhatsAppDisplayName(
  input: WhatsAppDisplayNameInput,
  fallbackLabel: string = DEFAULT_FALLBACK_LABEL,
): WhatsAppDisplayIdentity {
  const name = cleaned(input.accountName) ?? cleaned(input.pushName);
  const phone = cleaned(input.phoneNumber);

  if (name && phone) return { primary: name, secondary: phone };
  if (name) return { primary: name, secondary: null };
  if (phone) return { primary: phone, secondary: null };
  return { primary: fallbackLabel, secondary: null };
}

/** Convenience for single-line contexts (e.g. "Connected as X") that can't render a secondary line. */
export function getWhatsAppDisplayLabel(input: WhatsAppDisplayNameInput, fallbackLabel?: string): string {
  const identity = getWhatsAppDisplayName(input, fallbackLabel);
  return identity.secondary ? `${identity.primary} (${identity.secondary})` : identity.primary;
}
