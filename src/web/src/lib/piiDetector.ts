/**
 * Recognises personal information in text an OPERATOR is about to send.
 *
 * WHY THIS EXISTS, and what it does not do. Aura sends customer messages to
 * an AI provider (Gemini, Groq, and the other configured fallbacks) in order
 * to generate a reply - that is the product, and it cannot work otherwise.
 * What this guards is the part the business actually controls: text a person
 * on the business side types, which then joins the conversation history and
 * is sent to a provider on every subsequent turn.
 *
 * So this is a WARNING, not a block. It says "this looks like a card number
 * - send anyway?" and the operator decides. A hard block would be wrong:
 * sometimes sending a phone number is exactly the right thing to do, and a
 * tool that refuses is a tool people route around.
 *
 * HONEST LIMITS. This is regex over text. It recognises SHAPES - an email
 * looks like an email anywhere. It cannot recognise a street address woven
 * into a sentence, a person's name, a date of birth written in words, or a
 * medical detail. Anything relying on this having caught everything would be
 * relying on something untrue. It reduces accidental disclosure; it does not
 * prevent deliberate or unusual disclosure.
 *
 * Deliberately mirrors the server-side patterns in
 * services/businessIntelligence/piiRedactionService.ts rather than importing
 * them: the web build cannot reach server code (see lib/identity.ts, which
 * mirrors domain/whatsapp/displayName.ts for the same reason). Where the
 * server REDACTS for the BI pipeline, this only DETECTS, and returns what
 * kind was found so the warning can name it.
 */

export type PiiKind = 'email' | 'phone' | 'card' | 'government_id' | 'secret';

export interface PiiFinding {
  kind: PiiKind;
  /** What to call it in the warning. Never the matched value itself. */
  label: string;
}

/** Luhn, so a 16-digit order reference is not called a card number. */
function looksLikePaymentCard(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

const PATTERNS: { kind: PiiKind; label: string; pattern: RegExp }[] = [
  {
    kind: 'secret',
    label: 'an API key or access token',
    pattern: /\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9]{16,}\b/i,
  },
  { kind: 'email', label: 'an email address', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  {
    kind: 'government_id',
    label: 'a government ID number',
    pattern: /\b(?:ssn|social\s?security|national\s?insurance|nib|passport\s?(?:no|number)|driver'?s?\s?licen[cs]e)\b[\s:#-]*[A-Z0-9-]{5,}/i,
  },
  {
    kind: 'phone',
    label: 'a phone number',
    // Requires a separator or a leading +, so a bare 10-digit reference
    // number is not flagged as a phone number on sight.
    pattern: /(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,
  },
];

/**
 * What personal information this text appears to contain.
 *
 * Returns one finding per KIND, not per occurrence: three email addresses is
 * still "an email address" as far as the warning is concerned, and listing
 * them three times would only make the notice harder to read.
 */
export function detectPii(text: string): PiiFinding[] {
  const value = text.trim();
  if (value.length === 0) return [];

  const findings: PiiFinding[] = [];
  for (const { kind, label, pattern } of PATTERNS) {
    if (pattern.test(value)) findings.push({ kind, label });
  }

  // Card numbers are usually written in groups, so each candidate run is
  // Luhn-checked on its own digits rather than the whole string's - two
  // unrelated numbers in one sentence must not combine into a false match.
  for (const candidate of value.match(/\b(?:\d[ -]?){12,22}\b/g) ?? []) {
    if (looksLikePaymentCard(candidate.replace(/[^0-9]/g, ''))) {
      findings.push({ kind: 'card', label: 'a payment card number' });
      break;
    }
  }

  return findings;
}

/** "an email address and a phone number" - for the body of the warning. */
export function describePiiFindings(findings: PiiFinding[]): string {
  const labels = findings.map((finding) => finding.label);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
