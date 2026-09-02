/**
 * Real, deterministic phrase matching - never a second AI call just to
 * detect a commitment (cost/latency, and "deterministic wherever
 * practical" per the AURA Master Engineering Prompt's own recommendation-
 * engine principle). Deliberately erring toward precision over recall:
 * a missed commitment is a minor gap, a false positive trains operators
 * to ignore the feature. Matches only a real promise-to-follow-up shape,
 * not every future-tense sentence.
 */
const COMMITMENT_PATTERNS: RegExp[] = [
  /\bi('| wi)?ll (check|confirm|follow up|get back to you|look into|find out|verify)\b/i,
  /\bwe('| wi)?ll (check|confirm|follow up|get back to you|look into|find out|verify|reach out)\b/i,
  /\blet me (check|confirm|look into|find out|verify)\b/i,
  /\b(someone|a team member|our team) will (reach out|get back to you|follow up|be in touch)\b/i,
  /\b(checking|confirming) (with|shortly)\b/i,
];

/** Returns the first matched commitment phrase, or null if the text makes no detectable promise to follow up. */
export function detectCommitmentPhrase(replyText: string): string | null {
  for (const pattern of COMMITMENT_PATTERNS) {
    const match = pattern.exec(replyText);
    if (match) return match[0];
  }
  return null;
}
