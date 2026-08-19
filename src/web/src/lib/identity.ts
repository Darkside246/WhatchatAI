/**
 * Mirrors the backend's resolveDisplayName Tier-5 fallback (see
 * src/domain/whatsapp/displayName.ts) for the handful of frontend spots
 * that build their own name fallback chain instead of consuming a
 * pre-resolved displayName from the API. A raw `269281631678624@lid`
 * string is not a real name - this formats it into the same clean,
 * truncated label instead of leaking the internal protocol identifier
 * into the UI, without losing the real JID (still used untouched for
 * every actual messaging operation elsewhere).
 */
export function formatIdentityFallback(jid: string): string {
  if (jid.endsWith('@lid')) {
    const localPart = jid.split('@')[0] ?? '';
    return `WhatsApp User (${localPart.slice(0, 6)}…)`;
  }
  return jid;
}
