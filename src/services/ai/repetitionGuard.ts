import type { WhatsAppMessageRecord } from '../../repositories/whatsappMessageRepository.js';

/**
 * Stops the agent saying something the customer has already been told.
 *
 * THE PRODUCTION FAILURE. The owner typed "good morning." to a customer from
 * his own phone. The customer wrote back "Good morning". The agent then said
 * "Good morning to you too! How are you feeling as we step into today?" -
 * three greetings in one exchange, and the customer had asked for none of
 * them. The same shape happens with any repeated line: a price quoted
 * twice, a question asked again, an instruction restated.
 *
 * WHY IT HAPPENS. Our side has two typists - the agent, and the operator on
 * his own phone - and only one voice as far as the customer is concerned.
 * The agent was shown the operator's turns but told to treat them as a
 * colleague's aside it must never acknowledge, so it discounted them
 * instead of counting them as things already said.
 *
 * The prompt is where that is fixed properly (see buildSystemInstruction:
 * one voice, two typists). This module is the deterministic backstop for
 * when the model does it anyway - the same posture as Section 19's name
 * repetition protection, which also checks the real sent text rather than
 * trusting the model to police itself.
 *
 * DELIBERATELY CONSERVATIVE. It removes a sentence only when our side has
 * genuinely already sent that sentence, and it never returns an empty
 * reply. Every doubtful case is left exactly as the model wrote it: a reply
 * that repeats itself is a far smaller failure than a reply that arrives
 * mangled, or does not arrive at all.
 */

// ── Greetings ────────────────────────────────────────────────────────────

/**
 * Greetings need their own matcher rather than going through the
 * near-duplicate check below, because two greetings can share almost no
 * words - "Good morning" and "Hey there" are the same move - and because
 * what words they do share are the common ones that check ignores.
 */
const GREETING_OPENER = new RegExp(
  '^\\s*(?:a\\s+very\\s+)?(?:' +
    // "good morning", "good afternoon", "good evening", "good day"
    'good\\s*(?:morning|afternoon|evening|day)' +
    // The bare time-of-day form, which is only a greeting when the message
    // opens on it and it stands alone - "Morning!" is a hello, while
    // "Morning appointments are full" is a sentence about appointments.
    '|(?:morning|afternoon|evening)(?=\\s*[,.!?\u2026]|\\s*$)' +
    '|hello+|hi+|hey+|yo|greetings|howdy|hiya|welcome\\s+back|welcome' +
    // \b is load-bearing: without it "hi+" matches the start of "Hire a
    // van" and the guard would turn it into "Re a van".
    ')\\b',
  'i',
);

/**
 * The words that can trail a greeting and still be part of it - "Hi there",
 * "Good morning to you too", "Hello again". Without these the guard removes
 * "Good morning" and leaves "to you too!" standing on its own.
 */
const GREETING_TAIL = /^(?:\s+(?:there|again|too|back|folks|all|everyone|as\s+well|to\s+you(?:\s+too)?|and\s+welcome))+/i;

/** Trailing punctuation between the greeting and whatever the message actually says. */
const GREETING_TERMINATOR = /^\s*[,.!?\u2026:;-]+\s*/;

interface GreetingMatch {
  /** How many characters of the original text the whole greeting occupies. */
  length: number;
}

function matchGreeting(text: string): GreetingMatch | null {
  const opener = GREETING_OPENER.exec(text);
  if (!opener) return null;

  let length = opener[0].length;
  const tail = GREETING_TAIL.exec(text.slice(length));
  if (tail) length += tail[0].length;
  const terminator = GREETING_TERMINATOR.exec(text.slice(length));
  if (terminator) length += terminator[0].length;

  return { length };
}

/** Whether a message opens with a greeting. */
export function hasOpeningGreeting(text: string): boolean {
  return matchGreeting(text) !== null;
}

/** Whether a message is a greeting and nothing else - "Good morning", "Hi there!". */
export function isGreetingOnly(text: string): boolean {
  const match = matchGreeting(text);
  return match !== null && text.slice(match.length).trim().length === 0;
}

/**
 * Removes an opening greeting, leaving the rest of the reply intact:
 * "Good morning to you too! How are you feeling today?" becomes "How are
 * you feeling today?", which is what the agent should have said.
 *
 * A reply that is nothing but a greeting comes back unchanged. This guard
 * has no business inventing replacement words for a message it did not
 * write, and sending nothing is the worse failure.
 */
export function stripOpeningGreeting(text: string): string {
  const match = matchGreeting(text);
  if (!match) return text;

  const remainder = text.slice(match.length).trimStart();
  if (remainder.trim().length === 0) return text;

  // The greeting often ran into the next clause ("Hi there, how can I
  // help?"), so the word now starting the message is lowercase.
  return remainder.replace(/^([a-z])/, (letter) => letter.toUpperCase());
}

// ── Near-duplicate sentences ─────────────────────────────────────────────

/**
 * Words carried by almost every sentence. Ignored when judging whether two
 * sentences say the same thing, so "the price is forty dollars" and "the
 * van is booked for nine" are not counted as similar for sharing "the" and
 * "is".
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'so', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'have', 'has', 'had',
  'i', 'you', 'we', 'they', 'he', 'she', 'it', 'me', 'us', 'them', 'him', 'her', 'my', 'your', 'our', 'their',
  'this', 'that', 'these', 'those', 'there', 'here', 'as', 'will', 'would', 'can', 'could', 'just', 'not',
]);

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 0 && !STOPWORDS.has(word)),
  );
}

/**
 * Dice coefficient over content words: twice the shared words, divided by
 * the total. 1 means the same words, 0 means nothing in common.
 *
 * Word sets rather than character n-grams or embeddings, because this has
 * to be exactly reproducible and explainable - an operator asking why a
 * sentence was dropped deserves an answer better than "the model thought
 * they were similar".
 */
export function sentenceSimilarity(a: string, b: string): number {
  const left = contentTokens(a);
  const right = contentTokens(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * How alike two sentences must be before one is treated as a repeat.
 *
 * High on purpose. At this level a sentence has to be a near-verbatim
 * restatement, not merely on the same topic - a customer who asks twice
 * deserves a real answer twice, and a follow-up that reuses the same nouns
 * ("the van is booked" then "the van is booked for nine") must survive.
 */
export const REPEAT_SIMILARITY_THRESHOLD = 0.85;

/**
 * Below this many content words, similarity stops meaning anything: "Yes."
 * and "Yes, absolutely" both reduce to one word and would score 1.0 against
 * anything else short. Short sentences are therefore never dropped, which
 * also protects the genuinely useful ones - "Confirmed.", "On my way."
 */
const MIN_CONTENT_WORDS = 3;

/** Splits on real sentence ends, keeping the terminator so the rejoined reply reads as it was written. */
function splitSentences(text: string): string[] {
  return text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g)?.filter((part) => part.trim().length > 0) ?? [text];
}

export interface RepetitionInput {
  /** What our side has already sent recently, newest first - the agent's own replies and the operator's alike. */
  alreadySaid: string[];
  /** True when our side has already greeted, so an opening greeting is a third one. */
  alreadyGreeted: boolean;
}

/**
 * The whole decision: a generated reply with anything our side has already
 * said taken out of it.
 *
 * Returns the reply unchanged whenever removing the repeats would leave
 * nothing to send.
 */
export function removeRepetition(reply: string, input: RepetitionInput): string {
  const withoutGreeting = input.alreadyGreeted ? stripOpeningGreeting(reply) : reply;

  const kept = splitSentences(withoutGreeting).filter((sentence) => {
    if (contentTokens(sentence).size < MIN_CONTENT_WORDS) return true;
    return !input.alreadySaid.some((said) => sentenceSimilarity(sentence, said) >= REPEAT_SIMILARITY_THRESHOLD);
  });

  const rebuilt = kept.join('').trim();
  if (rebuilt.length === 0) return withoutGreeting;
  return rebuilt.replace(/^([a-z])/, (letter) => letter.toUpperCase());
}

// ── What our side has already said ───────────────────────────────────────

/**
 * How far back a line still counts as "already said".
 *
 * Long enough to cover a conversation that pauses while somebody steps away
 * - the owner typing "brb" and the customer answering two minutes later is
 * the exact case this exists for - and short enough that a chat picked up
 * the next day is allowed to open properly again.
 */
export const ALREADY_SAID_WINDOW_MINUTES = 90;

export interface OurSideInput {
  /** Newest-first, exactly as WhatsAppMessageRepository.listByChat returns it. */
  history: WhatsAppMessageRecord[];
  now?: Date | undefined;
  windowMinutes?: number | undefined;
}

/**
 * Everything our side has said recently, as plain sentences.
 *
 * "Our side" is the point, and it is why this reads fromMe rather than the
 * agent's own message ids: to the customer, a line the owner typed on his
 * phone and a line the agent generated came from the same business. Both
 * have been said.
 *
 * Read from the conversation history rather than from a stored summary,
 * because the history is what actually happened - a remembered flag can
 * drift from the conversation, and the conversation cannot drift from
 * itself.
 */
export function whatOurSideSaid(input: OurSideInput): string[] {
  const now = (input.now ?? new Date()).getTime();
  const windowMs = (input.windowMinutes ?? ALREADY_SAID_WINDOW_MINUTES) * 60_000;

  return input.history
    .filter((message) => {
      if (!message.fromMe || !message.textContent) return false;
      const at = new Date(message.timestamp).getTime();
      return !Number.isNaN(at) && now - at <= windowMs;
    })
    .flatMap((message) => splitSentences(message.textContent!));
}

/**
 * Whether the customer has already been greeted in this exchange.
 *
 * Counts a greeting from EITHER side. Ours is obvious. Theirs matters
 * because a greeting is half of a pair: once the customer has said good
 * morning, the remaining half is the reply to it, and by the time the agent
 * is composing anything further that half has been used up.
 */
export function greetingAlreadyExchanged(input: OurSideInput): boolean {
  const now = (input.now ?? new Date()).getTime();
  const windowMs = (input.windowMinutes ?? ALREADY_SAID_WINDOW_MINUTES) * 60_000;

  return input.history.some((message) => {
    if (!message.textContent || !hasOpeningGreeting(message.textContent)) return false;
    const at = new Date(message.timestamp).getTime();
    return !Number.isNaN(at) && now - at <= windowMs;
  });
}
