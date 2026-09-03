/**
 * Section 04 (Conversational Intelligence Engine) - the first pipeline
 * stage: intent classification, entity detection, sensitive-information
 * detection and risk scoring, run BEFORE the Gemini call.
 *
 * Deliberately deterministic, not a second AI call - the master directive's
 * own performance guidance (Section 101) is explicit that not every message
 * should get expensive AI processing, and this codebase already has a real
 * precedent for this shape (commitmentDetector.ts: pattern-based, never an
 * AI call). This runs on every inbound message essentially for free and
 * feeds the downstream pipeline (next-best-action, permission evaluation,
 * audit logging) a real signal instead of nothing.
 *
 * This is intentionally a *first pass*, not a claim of full NLU: pattern
 * matching catches the unambiguous cases (an email address is an email
 * address) and reports a broad intent bucket. Anything genuinely ambiguous
 * falls into 'general' rather than guessing - a wrong 'general' costs
 * nothing downstream, a wrong specific label could.
 */

export type ConversationIntent =
  | 'greeting'
  | 'scheduling_request'
  | 'cancellation'
  | 'complaint'
  | 'confirmation'
  | 'question'
  | 'general';

export type DetectedEntityType = 'email' | 'phone' | 'money';

export interface DetectedEntity {
  type: DetectedEntityType;
  value: string;
}

/**
 * Separate from confidence (Section 47's own explicit rule: "Risk must be
 * separate from confidence. High confidence does not mean permission to
 * act."). This classifier is always fully confident in its pattern match -
 * the risk level is about what the message CONTAINS, not how sure we are.
 */
export type RiskLevel = 0 | 1 | 2 | 3 | 4;

export interface IntentClassification {
  intent: ConversationIntent;
  entities: DetectedEntity[];
  sensitiveInfoDetected: boolean;
  riskLevel: RiskLevel;
}

const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// International-friendly: 7-15 digits, optional leading +, allowing spaces/dashes/parens/dots as separators.
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{6,17}\d)/g;
const MONEY_PATTERN = /(?:[$£€]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|usd|dollars))/g;

// Deliberately conservative - real government/financial identifiers only,
// not anything that merely looks numeric (a phone number is not sensitive
// in the same way an SSN or card number is, so PHONE_PATTERN above is never
// treated as sensitive on its own).
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]?){13,16}\b/;

const GREETING_PATTERN = /^\s*(hi|hello|hey|good\s?(morning|afternoon|evening)|yo|greetings)\b/i;
const SCHEDULING_PATTERN = /\b(book|schedule|appointment|meeting|reschedul|available|availability|call\s?me|set up a (call|time))\b/i;
const CANCELLATION_PATTERN = /\b(cancel|can'?t make it|won'?t be able to|not able to make|reschedule)\b/i;
const COMPLAINT_PATTERN = /\b(angry|upset|frustrat|terrible|awful|worst|unacceptable|refund|complain|disappointed|not happy|never again)\b/i;
// Matches short affirmative replies, including a run of them ("Yes, sounds good") -
// anchored to the whole message so it never fires on an affirmative word used
// mid-sentence in something longer and more ambiguous.
const CONFIRMATION_PATTERN = /^\s*(?:(?:yes|yep|yeah|sure|ok(?:ay)?|confirmed?|perfect|great|sounds good|works for me|that works)[\s,.!]*){1,3}$/i;
const QUESTION_PATTERN = /\?\s*$|^\s*(what|when|where|who|why|how|can you|could you|do you|is it|are you)\b/i;

function detectEntities(text: string): DetectedEntity[] {
  const entities: DetectedEntity[] = [];
  for (const match of text.match(EMAIL_PATTERN) ?? []) entities.push({ type: 'email', value: match });
  for (const match of text.match(PHONE_PATTERN) ?? []) {
    const digitCount = match.replace(/\D/g, '').length;
    if (digitCount >= 7 && digitCount <= 15) entities.push({ type: 'phone', value: match.trim() });
  }
  for (const match of text.match(MONEY_PATTERN) ?? []) entities.push({ type: 'money', value: match.trim() });
  return entities;
}

function detectIntent(text: string): ConversationIntent {
  const trimmed = text.trim();
  if (COMPLAINT_PATTERN.test(trimmed)) return 'complaint';
  if (CANCELLATION_PATTERN.test(trimmed)) return 'cancellation';
  if (SCHEDULING_PATTERN.test(trimmed)) return 'scheduling_request';
  if (CONFIRMATION_PATTERN.test(trimmed)) return 'confirmation';
  if (GREETING_PATTERN.test(trimmed)) return 'greeting';
  if (QUESTION_PATTERN.test(trimmed)) return 'question';
  return 'general';
}

function detectSensitiveInfo(text: string): boolean {
  return SSN_PATTERN.test(text) || CREDIT_CARD_PATTERN.test(text.replace(/[ -]/g, (m) => m));
}

function computeRiskLevel(intent: ConversationIntent, sensitiveInfoDetected: boolean): RiskLevel {
  if (sensitiveInfoDetected) return 3;
  if (intent === 'complaint') return 3;
  if (intent === 'scheduling_request' || intent === 'cancellation') return 2;
  if (intent === 'question' || intent === 'confirmation') return 1;
  return 0; // greeting, general
}

export function classifyMessage(text: string): IntentClassification {
  const intent = detectIntent(text);
  const entities = detectEntities(text);
  const sensitiveInfoDetected = detectSensitiveInfo(text);
  return { intent, entities, sensitiveInfoDetected, riskLevel: computeRiskLevel(intent, sensitiveInfoDetected) };
}
