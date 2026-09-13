import type { FoodOrderLine } from '../../repositories/foodOperationsRepository.js';

/**
 * Reading a photo of an order that is about to leave.
 *
 * This is a third eye at the pass, not an inspector. It exists because a
 * person packing forty orders on a Friday will not notice the ketchup on
 * the one burger that was ordered without it - and a photo will.
 *
 * The whole design rests on one asymmetry that cannot be argued away: a
 * photograph can prove something is THERE. It can never prove something is
 * absent. The extra cheese is under the bun, the bacon is under the
 * lettuce, the sauce is in a tub inside the bag. So a thing that was
 * ordered and cannot be seen is not a fault, is not a warning, and is not
 * mentioned - it is recorded as unverifiable and nothing more. An agent
 * that says "I cannot see the bacon" on every order is an agent nobody
 * looks at by Friday.
 *
 * A side-on photo sees more than a top-down one - onions, cheese and sauce
 * show in the layers rather than hiding under a lid. That makes the
 * CONTRADICTION finding much better. It does NOT make absence provable,
 * and nothing here treats it as though it does.
 */

export type QcFindingKind =
  /** Something is visible that this order explicitly excluded. The reliable, useful signal. */
  | 'CONTRADICTION'
  /** The number of portions in the photo does not match the number ordered. */
  | 'COUNT'
  /** Something ordered could not be confirmed from the photo. Recorded; never raised as a fault. */
  | 'UNVERIFIABLE'
  /**
   * The photograph is not of food.
   *
   * Reported live: a photograph of a MAN came back as "Nothing seen that
   * should not be" - a clean bill of health for a picture of the order
   * nobody had taken. Every other finding here is about what is wrong with
   * an order; this one is about the check itself being unable to say
   * anything, which is worse than a fault because it looks like a pass.
   */
  | 'NOT_FOOD';

export interface QcFinding {
  kind: QcFindingKind;
  /** Which line it concerns, by name, so the person packing can find it in the bag. */
  line: string;
  message: string;
}

/**
 * What the vision model is allowed to tell us.
 *
 * Every field is about what is VISIBLE. There is nowhere to record "the
 * bacon is missing", because that is not something a photograph can
 * establish - so the model is never asked, and a model that volunteers it
 * has nowhere to put it.
 */
export interface QcVisionObservation {
  /** Ingredients, items and condiments the model can actually see. */
  visible: string[];
  /** How many separate portions are in frame, or null when it cannot tell - which is often and is fine. */
  portionsInFrame: number | null;
  /**
   * Whether this is a photograph of food at all.
   *
   * False on a picture of a person, a room, a receipt, a blurred thumb over
   * the lens. Without it the check gave a clean bill of health to any
   * photograph whatsoever, which is the one outcome worse than finding
   * nothing: it looks like a pass.
   *
   * Defaults TRUE when the model did not say, so an older or malformed
   * answer is not turned into an accusation that somebody photographed the
   * wrong thing.
   */
  isFood: boolean;
  /**
   * One short sentence of what is in the picture, in plain words.
   *
   * Shown to the person at the pass whatever the verdict, because a check
   * that only ever says "nothing wrong" is indistinguishable from a check
   * that is not running. Seeing it describe their own burger is how
   * somebody knows it looked.
   */
  description: string | null;
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does what the camera saw name the thing the order excluded.
 *
 * Matched both ways round on whole words: an order that says "no onions"
 * has to catch a photo that reports "red onion", and an order that says
 * "no cheese" has to catch "melted cheddar cheese". Substring matching
 * without the word boundary would make "no ham" fire on "hamburger bun",
 * which is the kind of false alarm that gets a feature switched off.
 */
function mentions(seen: string, excluded: string): boolean {
  const seenWords = normalise(seen).split(' ').filter(Boolean);
  const excludedWords = normalise(excluded).split(' ').filter(Boolean);
  if (seenWords.length === 0 || excludedWords.length === 0) return false;

  // Singular and plural are the same ingredient. Crude on purpose - a
  // stemmer would start matching things a cook would not call the same.
  const stem = (word: string) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word);
  const seenStems = new Set(seenWords.map(stem));
  return excludedWords.every((word) => seenStems.has(stem(word)));
}

/**
 * What the photo says about this order.
 *
 * Note what is NOT here: nothing compares what was ordered against what
 * was seen looking for gaps. Additions are never checked, because they
 * cannot be. That omission is the feature.
 */
export function classifyQcObservation(lines: FoodOrderLine[], observation: QcVisionObservation): QcFinding[] {
  const findings: QcFinding[] = [];

  /*
   * Not food. Nothing else is worth saying about this photograph, and
   * saying anything else would be worse than saying nothing: every check
   * below reasons about whether the ORDER matches, and the order is not in
   * the frame. Returned alone so the screen cannot show a reassurance
   * beside it.
   */
  if (!observation.isFood) {
    return [
      {
        kind: 'NOT_FOOD',
        line: lines[0]?.name ?? 'this order',
        message: observation.description
          ? `That photo does not look like the order — it looks like ${observation.description}. Take one of the food before it goes out.`
          : 'That photo does not look like food. Take one of the order before it goes out.',
      },
    ];
  }

  for (const line of lines) {
    for (const modifier of line.modifiers) {
      // Only removals. An "add" that cannot be seen proves nothing, and an
      // "on the side" is in a tub the camera may never see into.
      if (modifier.action !== 'remove') continue;

      const seen = observation.visible.find((candidate) => mentions(candidate, modifier.name));
      if (seen) {
        findings.push({
          kind: 'CONTRADICTION',
          line: line.name,
          message: `${line.name} was ordered without ${modifier.name}, but ${seen} is visible.`,
        });
      } else {
        // Recorded so the check has an honest account of itself, not
        // because anybody needs telling.
        findings.push({
          kind: 'UNVERIFIABLE',
          line: line.name,
          message: `Could not confirm from the photo that ${line.name} is without ${modifier.name}.`,
        });
      }
    }
  }

  const ordered = lines.reduce((total, line) => total + line.quantity, 0);
  if (observation.portionsInFrame !== null && observation.portionsInFrame !== ordered) {
    findings.push({
      kind: 'COUNT',
      line: 'the whole order',
      // Worded as a question rather than an accusation: a bag, a drink
      // out of shot or two things on one plate all make this wrong
      // without anything being wrong with the order.
      message: `${ordered} item${ordered === 1 ? '' : 's'} ordered, ${observation.portionsInFrame} visible — is anything out of shot?`,
    });
  }

  return findings;
}

/**
 * What the operator is actually shown.
 *
 * Unverifiable findings are filtered out here rather than never being
 * produced, so the stored record stays complete and honest while the
 * screen stays quiet. Nothing in this file ever blocks a ticket: a person
 * bumps the order, and this only decides whether they see a warning first.
 */
export function raisedFindings(findings: QcFinding[]): QcFinding[] {
  return findings.filter((finding) => finding.kind !== 'UNVERIFIABLE');
}

/** True when the photo found something worth a second look before the order leaves. */
export function needsASecondLook(findings: QcFinding[]): boolean {
  return raisedFindings(findings).length > 0;
}
