import type { WhatsAppMessageRecord } from '../../repositories/whatsappMessageRepository.js';
import { hasOpeningGreeting, isGreetingOnly, whatOurSideSaid, greetingAlreadyExchanged } from './repetitionGuard.js';

/**
 * Where a conversation actually stands, worked out before the agent writes
 * a word.
 *
 * THE PROBLEM THIS SOLVES. The agent was handed a transcript and asked to
 * reply to the last line in it. That is not what a person does. A person
 * reads back far enough to see what their own side already said, notices
 * whether the customer's message opens something or closes something, and
 * only then decides whether anything more is needed at all.
 *
 * Without that, every inbound message looks like an opening. The owner said
 * "good morning", the customer said "Good morning" back, and the agent - to
 * whom the customer's line was simply the newest thing on screen - greeted
 * them a third time.
 *
 * OUR SIDE HAS TWO TYPISTS. The agent and the operator on his own phone.
 * The customer sees one business, so both count equally as things already
 * said; the only difference that matters is that the agent must never
 * ADDRESS the operator, since every reply is delivered to the customer.
 *
 * Everything here is computed from the real transcript, with real
 * timestamps. Nothing is asked of the model, and nothing is remembered in
 * a flag that could drift from what actually happened.
 */

export type TypedBy = 'agent' | 'operator';

export interface OurLastTurn {
  text: string;
  /** Who physically typed it. The customer cannot tell; the agent must, so it does not answer its own colleague. */
  typedBy: TypedBy;
  at: string;
}

export interface ConversationStanding {
  /** The last thing our side said, whoever typed it. Null when the customer opened the conversation. */
  ourLastTurn: OurLastTurn | null;
  /** Everything the customer has said since then, oldest first. */
  customerSince: string[];
  /**
   * True when everything the customer has said since our last turn reads as
   * closing an exchange rather than opening one - a returned greeting, an
   * acknowledgement, a thanks - and none of it asks anything.
   */
  exchangeLooksClosed: boolean;
  /** True when a greeting has already passed between the two sides recently. */
  greetingExchanged: boolean;
  /** Sentences our side has already sent recently, for the repetition guard. */
  alreadySaid: string[];
}

/** Nothing but emoji, punctuation or whitespace - a reaction, not a question. */
const SYMBOLS_ONLY = /^[\s\p{P}\p{S}\p{Emoji_Presentation}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️]*$/u;

/**
 * Short acknowledgements that end an exchange rather than continuing it.
 * Anchored to the whole message, so "ok" closing a chat is matched while
 * "ok so what about the deposit" is not.
 */
const ACKNOWLEDGEMENT =
  /^\s*(?:(?:ok(?:ay)?|k|yes|yep|yeah|yup|sure|right|alright|got\s?it|understood|noted|cool|nice|great|perfect|lovely|good|fine|thanks?|thank\s+you|ty|thx|cheers|no\s+problem|np|welcome|you'?re\s+welcome|sounds?\s+good|will\s+do|see\s+you|later|bye|goodbye|good\s?night|take\s+care)[\s,.!…]*){1,3}$/i;

const ASKS_SOMETHING = /\?/;

/**
 * Whether one customer message closes an exchange instead of opening one.
 *
 * A greeting counts as closing here, which looks backwards until you
 * remember that a greeting is half of a pair: when our side has already
 * said good morning, the customer saying it back is the second half, and
 * the exchange is finished. The caller only treats it that way when our
 * side did in fact greet first - see buildStanding.
 */
export function isClosingMove(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (ASKS_SOMETHING.test(trimmed)) return false;
  if (SYMBOLS_ONLY.test(trimmed)) return true;
  if (ACKNOWLEDGEMENT.test(trimmed)) return true;
  return isGreetingOnly(trimmed);
}

export interface BuildStandingInput {
  /** Newest-first, exactly as WhatsAppMessageRepository.listByChat returns it. */
  history: WhatsAppMessageRecord[];
  /** The ids of fromMe messages the agent itself generated; any other fromMe message was typed by a person on our side. */
  aiGeneratedMessageIds: Set<string>;
  now?: Date;
}

export function buildStanding(input: BuildStandingInput): ConversationStanding {
  // Chronological, because "since our last turn" is a question about order.
  const chronological = [...input.history].reverse().filter((message) => Boolean(message.textContent));

  let ourLastTurn: OurLastTurn | null = null;
  const customerSince: string[] = [];

  for (const message of chronological) {
    if (message.fromMe) {
      ourLastTurn = {
        text: message.textContent!,
        typedBy: input.aiGeneratedMessageIds.has(message.id) ? 'agent' : 'operator',
        at: message.timestamp,
      };
      // Anything the customer said before this is answered by definition.
      customerSince.length = 0;
    } else {
      customerSince.push(message.textContent!);
    }
  }

  const greetingExchanged = greetingAlreadyExchanged({ history: input.history, now: input.now });

  // An exchange is only closed if our side actually said something for the
  // customer to be closing. A customer opening with "hi" is not a closed
  // exchange - it is a conversation starting.
  const weSpokeFirst = ourLastTurn !== null;
  const exchangeLooksClosed =
    weSpokeFirst && customerSince.length > 0 && customerSince.every((text) => isClosingMove(text));

  return {
    ourLastTurn,
    customerSince,
    exchangeLooksClosed,
    greetingExchanged,
    alreadySaid: whatOurSideSaid({ history: input.history, now: input.now }),
  };
}

/**
 * The standing, written out for the model as plain facts.
 *
 * Facts rather than instructions, deliberately: the rule about what to do
 * with them is stated once in the system instruction, and repeating a rule
 * inside the data it applies to is how prompts turn into noise. Returns
 * null when there is nothing worth saying - a first message from a new
 * customer has no standing to describe.
 */
/** How many of the customer's recent messages the brief quotes. The rest are still in the transcript below it. */
const MAX_QUOTED_CUSTOMER_TURNS = 4;

/** Keeps one long message from crowding out the rest of the brief. */
const MAX_QUOTE_CHARS = 300;

function truncateQuote(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_QUOTE_CHARS ? `${trimmed.slice(0, MAX_QUOTE_CHARS)}…` : trimmed;
}

export function describeStanding(standing: ConversationStanding, operatorLabel = 'a person on your own side'): string | null {
  if (!standing.ourLastTurn) return null;

  const lines: string[] = ['Where this conversation stands right now:'];

  const who = standing.ourLastTurn.typedBy === 'agent' ? 'you' : operatorLabel;
  lines.push(`- The last thing YOUR SIDE said was "${truncateQuote(standing.ourLastTurn.text)}" - typed by ${who}. The customer has already read it. Do not say it again.`);

  if (standing.customerSince.length > 0) {
    // Bounded, because customerSince is however many messages arrived while
    // our side was quiet - a customer who sent twenty would otherwise push
    // twenty quoted lines into every prompt for the rest of the
    // conversation. The most recent few are what the reply turns on, and
    // the full transcript follows this brief anyway.
    const recent = standing.customerSince.slice(-MAX_QUOTED_CUSTOMER_TURNS);
    const elided = standing.customerSince.length - recent.length;
    const quoted = recent.map((text) => `"${truncateQuote(text)}"`).join(', then ');
    lines.push(`- Since then the customer has said${elided > 0 ? ` (their last ${recent.length} of ${standing.customerSince.length})` : ''}: ${quoted}.`);
  } else {
    lines.push('- The customer has not said anything since.');
  }

  if (standing.greetingExchanged) {
    lines.push('- Greetings have already been exchanged in this conversation. Do not open with another one.');
  }

  if (standing.exchangeLooksClosed) {
    lines.push(
      '- Everything the customer has said since reads as closing the exchange rather than opening one: an acknowledgement, ' +
        'a thanks, or a greeting returned to the one your side already sent. Nothing is outstanding.',
    );
  }

  return lines.join('\n');
}

export { hasOpeningGreeting };
