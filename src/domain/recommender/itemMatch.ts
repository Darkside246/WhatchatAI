/**
 * Turning what a customer called something into what the counting called it.
 *
 * The pair table is keyed by a menu item's id where the order line had one,
 * and by the lowercased line name where it did not - which is what
 * recommenderRepository.foodInteractions stores. A business whose menu was
 * built halfway through its history genuinely has both, for the same dish.
 *
 * So a lookup has to try both, and the matching has to be forgiving in the
 * one direction that is safe: a customer says "the large pepperoni" and
 * means "Pepperoni pizza". It must NOT be forgiving in the other - matching
 * "chicken" to "chicken roti" when the menu also has "chicken wings" would
 * have the agent recommending companions for a dish nobody mentioned.
 */

export interface MatchableItem {
  id: string;
  name: string;
  aliases: string[];
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The keys worth looking up for one spoken item, best first.
 *
 * Returns several rather than one because the answer is genuinely ambiguous
 * - the same dish can be stored under its id and under its name - and the
 * caller stops at the first that has any history. Empty only when the input
 * itself is empty.
 */
export function candidateKeys(spoken: string, menu: MatchableItem[]): string[] {
  const wanted = normalise(spoken);
  if (!wanted) return [];

  const keys: string[] = [];
  const push = (key: string) => {
    if (key && !keys.includes(key)) keys.push(key);
  };

  const exact = menu.find(
    (item) => normalise(item.name) === wanted || item.aliases.some((alias) => normalise(alias) === wanted),
  );
  if (exact) {
    push(exact.id);
    push(normalise(exact.name));
  }

  // What the customer actually typed, which is the key for any order taken
  // before this dish was ever on the menu.
  push(wanted);

  if (!exact) {
    /**
     * A containment match, and only where exactly one item survives it.
     *
     * "the large pepperoni" contains "pepperoni" and should find it. But
     * "chicken" contains nothing and is contained by both "chicken roti" and
     * "chicken wings" - with more than one candidate there is no way to
     * choose, and choosing anyway means recommending companions for a dish
     * the customer never mentioned. Ambiguity resolves to no match, which
     * the tool reports as "no history" and the agent says nothing about.
     */
    const contained = menu.filter((item) => {
      const name = normalise(item.name);
      return name.length > 2 && (wanted.includes(name) || item.aliases.some((alias) => wanted.includes(normalise(alias))));
    });
    if (contained.length === 1) {
      push(contained[0]!.id);
      push(normalise(contained[0]!.name));
    }
  }

  return keys;
}
