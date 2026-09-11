/**
 * Refuses to store an answer that looks like a credential.
 *
 * The onboarding never ASKS for passwords, government identifiers, banking
 * or card details, or API keys - but "we never ask" is not the same as "it
 * can never be stored". People paste the wrong thing into the wrong box, and
 * an onboarding that silently encrypted a card number into a brand profile
 * would have created a compliance problem out of a typo.
 *
 * So this is a real gate on the write path, not advice in a placeholder.
 *
 * DELIBERATELY CONSERVATIVE. A false positive costs the owner one confusing
 * rejection on a question they can rephrase or skip; a false negative puts a
 * card number in a business profile that feeds marketing copy. Where the two
 * are in tension this errs toward rejecting. It is still only a safety net:
 * it recognises the SHAPES of common secrets, and cannot recognise a
 * password that looks like an ordinary word. Nothing else in the system
 * relies on it having caught everything.
 */

export interface SensitiveAnswerVerdict {
  safe: boolean;
  /** What was recognised, in terms the owner can act on. Never quotes the matched text back. */
  reason?: string;
}

/** Luhn check, so a 16-digit order number is not mistaken for a card. */
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

const API_KEY_PATTERNS: { pattern: RegExp; reason: string }[] = [
  // Common vendor-prefixed key formats. Matched on shape, so a new vendor
  // with the same shape is caught too.
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/, reason: 'what looks like an API secret key' },
  { pattern: /\bAIza[A-Za-z0-9_-]{20,}\b/, reason: 'what looks like a Google API key' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, reason: 'what looks like a GitHub token' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, reason: 'what looks like a Slack token' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: 'what looks like an AWS access key' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'a private key block' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, reason: 'what looks like a JSON web token' },
];

const LABELLED_SECRET_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    // "password: hunter2", "my pin is 4821", "passcode = ...". Requires a
    // value after the label, so "I never share my password" is not caught.
    pattern: /\b(?:password|passcode|pass\s?word|pin|otp|security\s?code|secret)\b\s*(?:is|:|=)\s*\S+/i,
    reason: 'what looks like a password, PIN or access code',
  },
  {
    pattern: /\b(?:cvv|cvc)\b\s*(?:is|:|=)?\s*\d{3,4}\b/i,
    reason: 'what looks like a card security code',
  },
  {
    pattern: /\b(?:sort\s?code|routing\s?number|iban|swift|bic)\b\s*(?:is|:|=)?\s*[A-Z0-9]{4,}/i,
    reason: 'what looks like bank routing details',
  },
  {
    pattern: /\b(?:account\s?number|acct\s?no)\b\s*(?:is|:|=)?\s*\d{6,}/i,
    reason: 'what looks like a bank account number',
  },
  {
    pattern: /\b(?:ssn|social\s?security|national\s?insurance|nib|passport\s?(?:no|number))\b\s*(?:is|:|=)?\s*[A-Z0-9-]{5,}/i,
    reason: 'what looks like a government identification number',
  },
];

export function screenBrandDnaAnswer(answer: string): SensitiveAnswerVerdict {
  const text = answer.trim();
  if (text.length === 0) return { safe: true };

  for (const { pattern, reason } of API_KEY_PATTERNS) {
    if (pattern.test(text)) return { safe: false, reason };
  }
  for (const { pattern, reason } of LABELLED_SECRET_PATTERNS) {
    if (pattern.test(text)) return { safe: false, reason };
  }

  // Card numbers are usually written with spaces or dashes between groups,
  // so digits are gathered per candidate run rather than across the whole
  // answer - otherwise two unrelated numbers in one sentence could
  // accidentally form a Luhn-valid string.
  for (const candidate of text.match(/\b(?:\d[ -]?){12,22}\b/g) ?? []) {
    if (looksLikePaymentCard(candidate.replace(/[^0-9]/g, ''))) {
      return { safe: false, reason: 'what looks like a payment card number' };
    }
  }

  return { safe: true };
}
