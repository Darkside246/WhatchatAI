/**
 * Canonical form for comparing/classifying a MIME type: strips any
 * parameters (e.g. `; codecs=opus`, `; charset=utf-8`), trims whitespace,
 * and lowercases. WhatsApp/Baileys report real MIME types with parameters
 * attached - voice notes are always `audio/ogg; codecs=opus`, never the
 * bare `audio/ogg` - so every allow-list/classification lookup in this
 * codebase must compare against this normalized form, never the raw
 * string, or a real WhatsApp value silently fails an exact-match check.
 *
 * The raw value is still what gets stored and sent over the wire (it is
 * the real, complete media metadata) - this function exists only for
 * comparison/classification call sites, never for storage or transport.
 */
export function normalizeMimeType(mimeType: string | null | undefined): string {
  return mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}
