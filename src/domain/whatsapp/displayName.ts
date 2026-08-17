export interface ContactNameSources {
  verifiedName?: string | null;
  businessName?: string | null;
  displayName?: string | null;
  pushName?: string | null;
  shortName?: string | null;
  phoneNumber?: string | null;
  whatsappJid: string;
}

const NAME_PRIORITY: (keyof ContactNameSources)[] = [
  'verifiedName',
  'businessName',
  'displayName',
  'pushName',
  'shortName',
  'phoneNumber',
];

/**
 * Picks the first real (non-blank) name source in priority order. Never
 * fabricates a name - but a raw `269281631678624@lid` string is not a real
 * name either, just an internal routing identifier. When nothing else is
 * known (a strict-privacy account whose phone number WhatsApp never
 * discloses, and who has never sent a message carrying a pushName), this
 * formats that same real, honest LID into a clean, truncated label instead
 * of surfacing the raw protocol string - the full LID is never lost, it's
 * still the caller's `whatsappJid` for every actual messaging operation.
 */
export function resolveDisplayName(sources: ContactNameSources): string {
  for (const key of NAME_PRIORITY) {
    const value = sources[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }

  if (sources.whatsappJid.endsWith('@lid')) {
    const localPart = sources.whatsappJid.split('@')[0] ?? '';
    return `WhatsApp User (${localPart.slice(0, 6)}…)`;
  }

  return sources.whatsappJid;
}
