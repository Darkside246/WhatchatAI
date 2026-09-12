import { describe, expect, it } from 'vitest';
import {
  hasOpeningGreeting,
  isGreetingOnly,
  stripOpeningGreeting,
  removeRepetition,
  sentenceSimilarity,
  whatOurSideSaid,
  greetingAlreadyExchanged,
} from '../src/services/ai/repetitionGuard.js';
import { buildStanding, describeStanding, isClosingMove } from '../src/services/ai/conversationStanding.js';
import { isNoReplyRequest, NO_REPLY_SENTINEL } from '../src/services/aiReplyService.js';
import type { WhatsAppMessageRecord } from '../src/repositories/whatsappMessageRepository.js';

function turn(id: string, fromMe: boolean, textContent: string, minutesAgo: number): WhatsAppMessageRecord {
  return {
    id,
    fromMe,
    textContent,
    messageType: 'text',
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  } as unknown as WhatsAppMessageRecord;
}

/**
 * The real exchange this exists for, newest first, exactly as
 * listByChat returns it. The owner greeted from his own phone, the customer
 * greeted back, and the agent greeted a third time.
 */
const REAL_TRANSCRIPT = [
  turn('c2', false, 'Ok', 0),
  turn('c1', false, 'Good morning', 0),
  turn('o3', true, 'brb', 2),
  turn('o2', true, 'good morning.', 2),
  turn('o1', true, 'hmm i see', 3),
  turn('a1', true, "I'm doing well, keeping everything running smoothly behind the scenes.", 4),
];
const AI_IDS = new Set(['a1']);

describe('the third good morning', () => {
  it('is removed from the reply that actually went out', () => {
    const standing = buildStanding({ history: REAL_TRANSCRIPT, aiGeneratedMessageIds: AI_IDS });
    const whatWasSent = 'Good morning to you too! How are you feeling as we step into today?';

    expect(removeRepetition(whatWasSent, { alreadySaid: standing.alreadySaid, alreadyGreeted: standing.greetingExchanged })).toBe(
      'How are you feeling as we step into today?',
    );
  });

  it('is recognised as already exchanged, whoever said it', () => {
    expect(greetingAlreadyExchanged({ history: REAL_TRANSCRIPT })).toBe(true);
    // The owner typed it, not the agent - and it counts exactly the same,
    // because the customer sees one business, not two typists.
    expect(greetingAlreadyExchanged({ history: [turn('o2', true, 'good morning.', 2)] })).toBe(true);
  });

  /** A greeting stops mattering. A conversation picked up the next day opens properly. */
  it('stops counting once the conversation has gone cold', () => {
    expect(greetingAlreadyExchanged({ history: [turn('o2', true, 'good morning.', 60 * 20)] })).toBe(false);
  });
});

describe('where the conversation stands', () => {
  const standing = buildStanding({ history: REAL_TRANSCRIPT, aiGeneratedMessageIds: AI_IDS });

  it('knows what our side last said, and which of us typed it', () => {
    expect(standing.ourLastTurn).toMatchObject({ text: 'brb', typedBy: 'operator' });
  });

  it('knows what the customer has said since, in order', () => {
    expect(standing.customerSince).toEqual(['Good morning', 'Ok']);
  });

  it('knows the exchange is finished rather than waiting on us', () => {
    expect(standing.exchangeLooksClosed).toBe(true);
  });

  it('tells the model all of it as plain fact', () => {
    const brief = describeStanding(standing, 'Hasan');
    expect(brief).toContain('"brb" - typed by Hasan');
    expect(brief).toContain('"Good morning", then "Ok"');
    expect(brief).toContain('Do not open with another one');
  });

  /**
   * The opposite case, which must not be mistaken for the one above: a
   * customer opening a conversation with "hi" is not a closed exchange.
   */
  it('does not call a conversation closed when the customer opened it', () => {
    const opening = buildStanding({
      history: [turn('c1', false, 'Hi', 0)],
      aiGeneratedMessageIds: new Set(),
    });
    expect(opening.ourLastTurn).toBeNull();
    expect(opening.exchangeLooksClosed).toBe(false);
    expect(describeStanding(opening)).toBeNull();
  });

  it('is still open when the customer asked something', () => {
    const asked = buildStanding({
      history: [turn('c1', false, 'ok but is the van still available?', 0), turn('o1', true, 'Booked for 9.', 1)],
      aiGeneratedMessageIds: new Set(),
    });
    expect(asked.exchangeLooksClosed).toBe(false);
  });

  it('counts what both of our typists said as already said', () => {
    expect(whatOurSideSaid({ history: REAL_TRANSCRIPT })).toContain('good morning.');
    expect(whatOurSideSaid({ history: REAL_TRANSCRIPT })).toContain('brb');
    expect(whatOurSideSaid({ history: REAL_TRANSCRIPT })).not.toContain('Good morning');
  });
});

describe('closing moves', () => {
  for (const text of ['Ok', 'ok', 'thanks!', 'Thank you', '👍', 'Will do', 'Good morning', 'bye', 'noted']) {
    it(`"${text}" closes`, () => expect(isClosingMove(text)).toBe(true));
  }
  for (const text of ['ok so what about the deposit', 'Is it open?', 'I need a van tomorrow', 'Can you send the invoice']) {
    it(`"${text}" does not`, () => expect(isClosingMove(text)).toBe(false));
  }
});

describe('greeting detection', () => {
  /** The failures that would matter: a word that merely starts like a greeting. */
  it('leaves a sentence that only looks like one alone', () => {
    for (const text of ['Hire a van for the weekend?', "I'll call you in the morning", 'Morning appointments are full.', 'Highly recommended.']) {
      expect(hasOpeningGreeting(text)).toBe(false);
      expect(stripOpeningGreeting(text)).toBe(text);
    }
  });

  it('takes the whole greeting, including what trails it', () => {
    expect(stripOpeningGreeting('Good morning to you too! How are you feeling?')).toBe('How are you feeling?');
    expect(stripOpeningGreeting('Hi there, how can I help?')).toBe('How can I help?');
    expect(stripOpeningGreeting('Hello again - your order shipped.')).toBe('Your order shipped.');
  });

  /**
   * Fails safe. A reply that is nothing but a greeting comes back whole:
   * this guard has no business inventing words for a message it did not
   * write, and sending nothing is the worse failure.
   */
  it('never empties a reply', () => {
    for (const text of ['Good morning', 'Hi!', 'Good morning to you too!']) {
      expect(isGreetingOnly(text)).toBe(true);
      expect(stripOpeningGreeting(text)).toBe(text);
    }
  });
});

describe('repeated sentences', () => {
  it('drops a near-verbatim restatement of something our side already sent', () => {
    const alreadySaid = ['The van is booked for 9am tomorrow.'];
    expect(removeRepetition('The van is booked for 9am tomorrow. Anything else?', { alreadySaid, alreadyGreeted: false })).toBe(
      'Anything else?',
    );
  });

  /** A follow-up that reuses the same nouns is not a repeat. */
  it('keeps a sentence that merely shares a subject', () => {
    const alreadySaid = ['The van is booked.'];
    const reply = 'The van needs collecting from the depot before six.';
    expect(removeRepetition(reply, { alreadySaid, alreadyGreeted: false })).toBe(reply);
  });

  it('never drops a short answer, however similar', () => {
    expect(removeRepetition('Yes.', { alreadySaid: ['Yes.'], alreadyGreeted: false })).toBe('Yes.');
  });

  it('returns the reply whole rather than empty when everything in it repeats', () => {
    const alreadySaid = ['The van is booked for 9am tomorrow.'];
    const reply = 'The van is booked for 9am tomorrow.';
    expect(removeRepetition(reply, { alreadySaid, alreadyGreeted: false })).toBe(reply);
  });

  it('scores identical sentences 1 and unrelated ones 0', () => {
    expect(sentenceSimilarity('The van is booked for 9.', 'The van is booked for 9.')).toBe(1);
    expect(sentenceSimilarity('The price is forty dollars.', 'The van is booked for nine.')).toBe(0);
  });
});

describe('choosing to say nothing', () => {
  it('is honoured only when the whole reply is the sentinel', () => {
    expect(isNoReplyRequest(NO_REPLY_SENTINEL)).toBe(true);
    expect(isNoReplyRequest(`  ${NO_REPLY_SENTINEL}\n`)).toBe(true);
  });

  /**
   * The dangerous case: a sentinel inside a real message must never be
   * treated as silence, or the customer's actual reply is swallowed.
   */
  it('is ignored when it is merely mentioned', () => {
    expect(isNoReplyRequest(`Sure thing. ${NO_REPLY_SENTINEL}`)).toBe(false);
    expect(isNoReplyRequest('No reply needed, I think')).toBe(false);
  });
});

describe('the brief stays a brief', () => {
  /**
   * customerSince is however many messages arrived while our side was
   * quiet. Left unbounded, a customer who sent twenty would push twenty
   * quoted lines into every prompt for the rest of the conversation.
   */
  it('quotes only the customer\'s most recent messages, and says so', () => {
    const many = Array.from({ length: 12 }, (_, index) => turn(`c${index}`, false, `message ${index}`, 12 - index));
    const standing = buildStanding({
      history: [...many].reverse().concat(turn('o1', true, 'one moment', 30)),
      aiGeneratedMessageIds: new Set(),
    });

    const brief = describeStanding(standing)!;
    expect(brief).toContain('their last 4 of 12');
    expect(brief).toContain('"message 11"');
    expect(brief).not.toContain('"message 0"');
  });

  it('truncates one very long message rather than letting it crowd everything else', () => {
    const standing = buildStanding({
      history: [turn('c1', false, 'x'.repeat(2000), 0), turn('o1', true, 'y'.repeat(2000), 1)],
      aiGeneratedMessageIds: new Set(),
    });
    const brief = describeStanding(standing)!;
    expect(brief).toContain('…');
    expect(brief.length).toBeLessThan(1200);
  });
});
