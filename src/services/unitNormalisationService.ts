/**
 * Pure unit normalisation service for food ordering.
 *
 * Converts natural-language ingredient quantities ("3 tbsp", "1/2 cup", "2kg")
 * into canonical form. Returns a confidence score so callers can decide
 * whether to accept silently or prompt the user to confirm.
 *
 * No I/O — all lookups are in-memory. Business-specific aliases from the
 * business_unit_aliases table are injected at the call site.
 */

export interface NormalisedUnit {
  canonical: string;
  quantity: number;
  confidence: 'high' | 'medium' | 'low';
  original: string;
}

/** Canonical unit → set of aliases (case-insensitive). Ordered most-specific first. */
const UNIT_ALIASES: Record<string, string[]> = {
  // Volume
  teaspoon: ['tsp', 'teaspoon', 'teaspoons', 't.'],
  tablespoon: ['tbsp', 'tbs', 'tablespoon', 'tablespoons', 'T.'],
  cup: ['cup', 'cups', 'c.'],
  fluid_ounce: ['fl oz', 'fluid ounce', 'fluid ounces', 'floz'],
  pint: ['pt', 'pint', 'pints'],
  quart: ['qt', 'quart', 'quarts'],
  gallon: ['gal', 'gallon', 'gallons'],
  millilitre: ['ml', 'mL', 'millilitre', 'milliliter', 'millilitres', 'milliliters'],
  litre: ['l', 'L', 'litre', 'liter', 'litres', 'liters'],
  // Mass
  gram: ['g', 'gram', 'grams', 'gr'],
  kilogram: ['kg', 'kilogram', 'kilograms', 'kilo', 'kilos'],
  ounce: ['oz', 'ounce', 'ounces'],
  pound: ['lb', 'lbs', 'pound', 'pounds'],
  // Count
  piece: ['piece', 'pieces', 'pc', 'pcs', 'each'],
  dozen: ['dozen', 'doz'],
  pinch: ['pinch', 'pinches'],
  dash: ['dash', 'dashes'],
  slice: ['slice', 'slices'],
  clove: ['clove', 'cloves'],
  sprig: ['sprig', 'sprigs'],
  bunch: ['bunch', 'bunches'],
  can: ['can', 'cans', 'tin', 'tins'],
  package: ['pkg', 'pack', 'package', 'packet', 'packages'],
  bottle: ['bottle', 'bottles', 'btl'],
};

/** Build a reverse-lookup map at module init, not on every call. */
const ALIAS_MAP = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(UNIT_ALIASES)) {
  for (const alias of aliases) {
    ALIAS_MAP.set(alias.toLowerCase(), canonical);
  }
}

/** Fraction strings → decimal. Handles "1/2", "1/4", "3/4", "1/3", "2/3". */
function parseFraction(s: string): number | null {
  const m = s.match(/^(\d+)\/(\d+)$/);
  if (!m) return null;
  const [, num, den] = m;
  const d = Number(den);
  return d === 0 ? null : Number(num) / d;
}

/** Parse a quantity string that may include mixed fractions ("1 1/2", "2.5", "½"). */
function parseQuantity(raw: string): number | null {
  const s = raw.trim()
    .replace('½', '1/2').replace('⅓', '1/3').replace('⅔', '2/3')
    .replace('¼', '1/4').replace('¾', '3/4');

  const parts = s.split(/\s+/);
  if (parts.length === 2) {
    const whole = Number(parts[0]);
    const frac = parseFraction(parts[1]);
    if (!isNaN(whole) && frac !== null) return whole + frac;
  }
  if (parts.length === 1) {
    const direct = Number(parts[0]);
    if (!isNaN(direct)) return direct;
    const frac = parseFraction(parts[0]);
    if (frac !== null) return frac;
  }
  return null;
}

/**
 * Normalise a raw ingredient string into a canonical unit.
 *
 * @param raw      e.g. "3 tbsp olive oil", "1/2 cup flour", "2kg chicken"
 * @param aliases  Optional business-specific aliases injected from the DB.
 */
export function normaliseUnit(raw: string, aliases: Record<string, string> = {}): NormalisedUnit {
  const s = raw.trim();

  // Combine business aliases (higher priority) with built-in aliases.
  const lookupAlias = (token: string): string | undefined =>
    aliases[token.toLowerCase()] ?? ALIAS_MAP.get(token.toLowerCase());

  // Match: optional quantity + optional unit + rest
  const pattern = /^([\d\s\/½⅓⅔¼¾]+)\s*([a-zA-Z.]+(?:\s+[a-zA-Z]+)?)\b/;
  const m = s.match(pattern);

  if (m) {
    const quantityStr = m[1].trim();
    const unitStr = m[2].trim();
    const quantity = parseQuantity(quantityStr);
    const canonical = lookupAlias(unitStr);

    if (quantity !== null && canonical) {
      return { canonical, quantity, confidence: 'high', original: s };
    }
    if (quantity !== null && !canonical) {
      return { canonical: unitStr.toLowerCase(), quantity, confidence: 'medium', original: s };
    }
  }

  // Fallback: try to find a unit anywhere in the string.
  const tokens = s.toLowerCase().split(/\s+/);
  for (const token of tokens) {
    const canonical = lookupAlias(token);
    if (canonical) {
      return { canonical, quantity: 1, confidence: 'low', original: s };
    }
  }

  // No unit found — treat the whole thing as a single piece.
  return { canonical: 'piece', quantity: 1, confidence: 'low', original: s };
}

/**
 * Normalise a batch of ingredient strings, returning those below the
 * confidence threshold separately so callers can gate them behind a
 * confirmation prompt.
 */
export function normaliseBatch(
  raws: string[],
  aliases: Record<string, string> = {},
): { confident: NormalisedUnit[]; needsConfirmation: NormalisedUnit[] } {
  const confident: NormalisedUnit[] = [];
  const needsConfirmation: NormalisedUnit[] = [];

  for (const raw of raws) {
    const result = normaliseUnit(raw, aliases);
    if (result.confidence === 'high') {
      confident.push(result);
    } else {
      needsConfirmation.push(result);
    }
  }

  return { confident, needsConfirmation };
}
