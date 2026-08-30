export type WhatsAppJidKind = 'individual' | 'lid' | 'group' | 'broadcast' | 'newsletter' | 'unknown';

/**
 * Baileys' own `socket.user.id` for a QR-paired session includes a
 * ":<deviceId>" suffix (e.g. "12462451422:20@s.whatsapp.net") - that
 * device slot number changes on every fresh pairing (logged out and
 * re-scanned), even though the underlying WhatsApp account/phone number
 * does not. whatsapp_accounts.upsertConnected() matches/creates a row by
 * this exact JID string - passing the raw, device-suffixed value through
 * would silently mint a brand-new account row (orphaning every previously
 * synced chat/message/contact from the one the live connection now uses)
 * every time this account gets re-paired, instead of reconnecting the
 * existing one. derivePhoneNumber() already strips this same suffix when
 * computing the phone number; this applies the identical strip to the JID
 * itself, once, at the single point it is captured from the socket, so
 * every downstream consumer (the account upsert, message persistence's
 * accountJid, sync context) sees the device-independent form.
 */
export function stripDeviceSuffix(jid: string): string {
  const atIndex = jid.indexOf('@');
  if (atIndex === -1) return jid;
  const userPart = (jid.slice(0, atIndex).split(':')[0]) ?? '';
  return `${userPart}${jid.slice(atIndex)}`;
}

export function classifyJid(jid: string | null | undefined): WhatsAppJidKind {
  if (!jid) return 'unknown';
  if (jid.endsWith('@lid')) return 'lid';
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@broadcast')) return 'broadcast';
  if (jid.endsWith('@newsletter')) return 'newsletter';
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) return 'individual';
  return 'unknown';
}

/**
 * A `@lid` local part is an internal linked-device identifier, not a phone
 * number - parsing digits out of it produces a fabricated number. Baileys
 * separately exposes the genuine phone-based counterpart JID as
 * `key.remoteJidAlt` when one is known; only that (or a native
 * `@s.whatsapp.net` JID) is ever treated as a real phone number.
 */
export function derivePhoneNumber(
  remoteJid: string,
  jidKind: WhatsAppJidKind,
  remoteJidAlt: string | null,
): string | null {
  let source: string | null = null;
  if (jidKind === 'individual') {
    source = remoteJid;
  } else if (jidKind === 'lid' && remoteJidAlt?.endsWith('@s.whatsapp.net')) {
    source = remoteJidAlt;
  }

  if (!source) return null;
  // The user part can carry a ":device" suffix (multi-device JIDs, and the
  // raw signal-store lookup this also feeds) - stripping non-digits without
  // dropping that first would silently fold the device index into the
  // phone number itself.
  const userPart = (source.split('@')[0] ?? '').split(':')[0] ?? '';
  const digits = userPart.replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}
