/**
 * A structural backstop against a real, repeated incident: the fallback
 * reasoning model, when a customer asked meta-questions about "your
 * thinking process," did not just get truncated mid-thought (that failure
 * mode is guarded separately, via finish_reason) - it completed normally
 * and its own chosen, intentional final answer WAS a verbatim chain-of-
 * thought narrative. A system-prompt instruction not to do this already
 * exists and was not reliably followed under direct questioning - this
 * checks the literal output instead of trusting the model's compliance.
 *
 * Two independent signals, either one alone sufficient:
 *
 * 1. The explicit "Here's a thinking process:" preamble seen in several
 *    incidents - a real reply never opens this way.
 * 2. The literal phrase "the user" anywhere in the text. Confirmed against
 *    a real incident that did NOT use the preamble at all (opened directly
 *    with "The user is saying that Haji told them..."), so the preamble
 *    alone is not a reliable enough signal on its own. "the user" is
 *    reliable specifically because this persona - and any real reply meant
 *    for the customer - only ever addresses them in the second person
 *    ("you", "darling", "love"); referring to the person being replied to
 *    in the third person as "the user" is not natural reply language at
 *    all, it is the model narrating about the conversation from outside
 *    it. Same trade-off the Outbound Leak Guard already makes deliberately:
 *    recall over precision - a rare false positive just means one message
 *    fails over to the next provider or a human, a trivial cost next to
 *    relaying raw internal reasoning to a real customer again.
 */
const REASONING_TRACE_PREAMBLE = /^\s*here'?s\s+(a|my)\s+thinking\s+process\s*:/i;
const THIRD_PERSON_USER_REFERENCE = /\bthe user\b/i;

export function looksLikeRawReasoningTrace(text: string): boolean {
  return REASONING_TRACE_PREAMBLE.test(text) || THIRD_PERSON_USER_REFERENCE.test(text);
}
