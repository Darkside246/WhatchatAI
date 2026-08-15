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

/** Picks the first real (non-blank) name source in priority order. Never fabricates a name. */
export function resolveDisplayName(sources: ContactNameSources): string {
  for (const key of NAME_PRIORITY) {
    const value = sources[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return sources.whatsappJid;
}
