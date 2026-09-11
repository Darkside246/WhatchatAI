/**
 * Removes a team member's name used to ADDRESS them, from a reply that is
 * about to be sent to a customer.
 *
 * THE FAILURE THIS EXISTS FOR. An operator typed "ok give me a min" while
 * working a chat. The customer sent a bare "Ok". What went out to the
 * CUSTOMER was "Take all the time you need, Hasan." - Hasan being the
 * business owner, who was never on the receiving end of that conversation.
 * Every reply is delivered to the customer regardless of who the model
 * aimed it at, so a reply aimed at a colleague reaches the wrong person and
 * names someone the customer has never heard of.
 *
 * WHY A SECOND LINE OF DEFENCE. aiReplyService.ts now says this in the
 * prompt, twice - on the colleague's own turn and as a standing rule. That
 * is instruction-following, not enforcement: it makes the right behaviour
 * unambiguous where before nothing was said at all, but it cannot
 * guarantee it. This pass is deterministic and runs on the generated text,
 * so the guarantee does not depend on the model having complied.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH. Only DIRECT ADDRESS is removed - the
 * vocative. A mention is left exactly as written:
 *
 *   "Take all the time you need, Hasan."  ->  "Take all the time you need."
 *   "Hasan will send that over shortly."  ->  unchanged
 *
 * That distinction is the whole point, and it is the operator's own
 * requirement: the AI must never reply to them, but must stay aware of what
 * they said so it can tell the customer about it. Stripping every mention
 * would break the second half to satisfy the first.
 *
 * It also never fires on a name the CUSTOMER is known by. Two people can
 * share a first name, and silently deleting a customer's own name from a
 * greeting addressed to them would be a worse bug than the one being fixed.
 */

export interface TeamAddressGuardInput {
  /** Real names of people on the business side - users of this business, never the business's own trading name. */
  teamNames: string[];
  /** Every name this customer is known by, from contactNameSources. A shared first name means we do nothing. */
  customerNames: string[];
}

export interface TeamAddressGuardResult {
  text: string;
  /**
   * Which names were removed, for the audit line. The names only - the
   * reply text itself is never carried into a log by this module.
   */
  removed: string[];
}

/** "Hasan Alkins" -> ["hasan alkins", "hasan"]. A full name and the first name are both used to address someone. */
function addressableForms(fullName: string): string[] {
  const cleaned = fullName.trim().replace(/\s+/g, ' ');
  if (cleaned.length < 2) return [];
  const forms = [cleaned];
  const first = cleaned.split(' ')[0]!;
  if (first.length >= 2 && first !== cleaned) forms.push(first);
  // A name has to start with a letter to be addressable. Guards against a
  // display name like "-" or "247" turning into a regex that matches
  // punctuation across the whole reply.
  return forms.filter((form) => /^\p{L}/u.test(form));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GREETINGS = 'hi|hello|hey|thanks|thank you|good morning|good afternoon|good evening|morning|afternoon|evening';

/**
 * Strips direct address of a team member, leaving everything else alone.
 *
 * Returns the text unchanged (and `removed` empty) whenever there is
 * nothing to do, so a caller can treat "no change" as the common path
 * without comparing strings.
 */
export function stripTeamAddress(text: string, input: TeamAddressGuardInput): TeamAddressGuardResult {
  const customerForms = new Set(
    input.customerNames.flatMap((name) => addressableForms(name)).map((form) => form.toLowerCase()),
  );

  const candidates = [...new Set(input.teamNames.flatMap((name) => addressableForms(name)))]
    .filter((form) => !customerForms.has(form.toLowerCase()))
    // Longest first, so "Hasan Alkins" is removed as one unit rather than
    // leaving a stray surname behind after "Hasan" matched.
    .sort((a, b) => b.length - a.length);

  let result = text;
  const removed: string[] = [];

  for (const name of candidates) {
    const n = escapeRegExp(name);
    const before = result;

    // "…, Hasan." / "…, Hasan!" / "… - Hasan" at the end of a sentence.
    result = result.replace(new RegExp(`[,\\u2013\\u2014-]\\s*${n}\\s*(?=[.!?]|$)`, 'giu'), '');

    // "Hi Hasan", "Thanks, Hasan" - the greeting is fine, the name is not.
    result = result.replace(new RegExp(`\\b(${GREETINGS})\\s*,?\\s+${n}\\b`, 'giu'), '$1');

    // "Hasan, take your time" at the very start of the reply or a sentence.
    result = result.replace(new RegExp(`(^|[.!?]\\s+)${n}\\s*,\\s*(\\p{L})`, 'giu'), (_m, lead: string, letter: string) =>
      `${lead}${letter.toUpperCase()}`,
    );

    if (result !== before) removed.push(name);
  }

  if (removed.length === 0) return { text, removed };

  // Tidy only what the removals themselves can leave behind: a doubled
  // space, a space before punctuation, a dangling comma.
  result = result
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.!?,])/g, '$1')
    .replace(/,\s*([.!?])/g, '$1')
    .trim();

  // A reply that was ONLY a form of address ("Hi Hasan") has nothing left
  // to send. Returning the original is the honest failure mode: an odd
  // reply naming the wrong person is still better than an empty message,
  // and the audit line records that this happened.
  if (result.length === 0) return { text, removed };

  return { text: result, removed };
}
