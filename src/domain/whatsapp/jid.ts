export type WhatsAppJidKind = 'individual' | 'lid' | 'group' | 'broadcast' | 'newsletter' | 'unknown';

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
