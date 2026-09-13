import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ConversationStateRepository } from '../src/repositories/conversationStateRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';
import {
  describeEpisodeBoundary,
  judgeClosure,
  readsAsAQuestion,
  readsAsASignOff,
  silenceIsAvailable,
  reopensConversation,
  splitEpisode,
} from '../src/domain/conversation/conversationClosure.js';

/**
 * When the agent is allowed to decide a conversation is over.
 *
 * Reported from the live logs: three messages in a row answered with "the
 * agent judged the exchange closed and chose to say nothing". That
 * judgement was made fresh each time against no memory, and nothing
 * checked it - so a customer could ask something and simply never be
 * answered, with the log line reading as though that were fine.
 *
 * The rule these pin: every check may keep a conversation OPEN and none of
 * them may close one. An unnecessary reply is mildly annoying and visible.
 * Silence in front of a question looks like a business that does not care,
 * and nobody finds out until the customer gives up.
 */

describe('deciding the conversation is finished', () => {
  const closed = { modelSaysClosed: true, customerText: 'ok thanks', openQuestionCount: 0 };

  it('closes when the agent has nothing to say and nothing is outstanding', () => {
    expect(judgeClosure(closed).closed).toBe(true);
  });

  it('never closes while the agent still has something to say', () => {
    expect(judgeClosure({ ...closed, modelSaysClosed: false }).closed).toBe(false);
  });

  it('refuses to close on an unanswered question', () => {
    const judgement = judgeClosure({ ...closed, customerText: 'how much is delivery to worthing?' });
    expect(judgement.closed).toBe(false);
    expect(judgement.reason).toContain('asked something');
  });

  it('refuses to close while we are on record as owing them an answer', () => {
    expect(judgeClosure({ ...closed, openQuestionCount: 2 }).closed).toBe(false);
  });

  it('still closes on a plain sign-off', () => {
    for (const text of ['ok thanks', 'thanks!', 'cool', 'got it', 'later', 'nice one']) {
      expect(judgeClosure({ ...closed, customerText: text }).closed).toBe(true);
    }
  });

  it('closes when there is nothing to read at all', () => {
    expect(judgeClosure({ ...closed, customerText: null }).closed).toBe(true);
  });
});

describe('going quiet on somebody who is still talking', () => {
  /**
   * The complaint, in the words it arrived in: "this is too strict - once
   * someone is talking they should respond". The agent was deciding that
   * exchanges were finished while the customer was mid-sentence, and the
   * only thing that had ever overruled it was a question mark.
   *
   * The rule now: a question gets an answer, and so does anything else
   * somebody actually said. Silence is for a goodbye and nothing else.
   */
  const closed = { modelSaysClosed: true, customerText: 'ok thanks', openQuestionCount: 0 };

  it('refuses to close on a statement that is not a question', () => {
    // Nothing here has a question mark and nothing starts with a question
    // word, and every one of them is somebody waiting to be answered.
    for (const text of [
      'i will take two fish cutters',
      'my order never came',
      'the driver went to the wrong house',
      'send it to worthing main road',
      'i need it for 6',
    ]) {
      expect(judgeClosure({ ...closed, customerText: text }).closed).toBe(false);
    }
  });

  it('says why, in words an operator reading a log would understand', () => {
    const judgement = judgeClosure({ ...closed, customerText: 'my order never came' });
    expect(judgement.reason).toContain('said something of their own');
  });

  it('still lets a conversation actually end', () => {
    // The other half of the same complaint: it must still know when things
    // are winding down. A sign-off that gets a reply is a thread that never
    // closes.
    for (const text of ['ok', 'thanks!', 'ok thanks', 'alright cool', 'thank you very much', 'see you later', 'got it', '👍']) {
      expect(judgeClosure({ ...closed, customerText: text }).closed).toBe(true);
    }
  });
});

describe('telling a goodbye from a sentence', () => {
  it('reads the ordinary ways people sign off', () => {
    for (const text of ['ok', 'okay', 'k', 'thanks', 'thank you', 'cool', 'nice one', 'later', 'take care', 'walk good', 'bet']) {
      expect(readsAsASignOff(text)).toBe(true);
    }
  });

  it('reads two of them stuck together, which is how people really write', () => {
    for (const text of ['ok thanks', 'alright cool thanks', 'thanks so much see you later', 'ok cool bet']) {
      expect(readsAsASignOff(text)).toBe(true);
    }
  });

  it('reads a bare emoji, which ends more conversations than any word', () => {
    for (const text of ['\u{1F44D}', '\u{1F64F}', '\u{2764}\u{FE0F}']) {
      expect(readsAsASignOff(text)).toBe(true);
    }
  });

  it('is not fooled by a sentence that merely starts like one', () => {
    // "ok so what time do you close" is the exact shape that made silence
    // look reasonable: it opens with an acknowledgement and then asks.
    for (const text of ['ok so what time do you close', 'thanks but it never came', 'cool can i get two', 'nice i need one for friday']) {
      expect(readsAsASignOff(text)).toBe(false);
    }
  });

  it('does not treat yes or no as a goodbye', () => {
    // On WhatsApp those answer something our side asked, and the reply to
    // an answer is not silence.
    for (const text of ['yes', 'no', 'yeah', 'nope']) {
      expect(readsAsASignOff(text)).toBe(false);
    }
  });

  it('refuses anything long enough to be carrying a request', () => {
    expect(readsAsASignOff('thanks '.repeat(20))).toBe(false);
  });
});

describe('the one predicate the prompt and the safety net share', () => {
  it('is what decides whether the model is even offered silence', () => {
    // If these two ever disagreed, the model would be handed an option the
    // worker then overruled - a wasted call and a customer left waiting.
    const cases = [
      { customerText: 'ok thanks', openQuestionCount: 0 },
      { customerText: 'how much is delivery', openQuestionCount: 0 },
      { customerText: 'i want two cutters', openQuestionCount: 0 },
      { customerText: 'ok', openQuestionCount: 1 },
      { customerText: null, openQuestionCount: 0 },
    ];
    for (const input of cases) {
      expect(judgeClosure({ ...input, modelSaysClosed: true }).closed).toBe(silenceIsAvailable(input).available);
    }
  });
});

describe('spotting a question', () => {
  it('reads a question mark', () => {
    expect(readsAsAQuestion('are you open?')).toBe(true);
  });

  it('reads a question nobody punctuated', () => {
    // People do not punctuate on WhatsApp. A question mark alone would
    // miss most real questions, and missing one means not answering it.
    for (const text of ['how much is the fish cutter', 'when you open', 'do you deliver to oistins', 'any chicken left']) {
      expect(readsAsAQuestion(text)).toBe(true);
    }
  });

  it('does not read a sign-off as a question', () => {
    for (const text of ['ok thanks', 'cool', 'see you then', 'nice one', 'perfect']) {
      expect(readsAsAQuestion(text)).toBe(false);
    }
  });

  it('is not fooled by a word that merely contains an opener', () => {
    expect(readsAsAQuestion('however you like')).toBe(false);
    expect(readsAsAQuestion('doing that now')).toBe(false);
  });

  it('handles nothing at all', () => {
    expect(readsAsAQuestion(null)).toBe(false);
    expect(readsAsAQuestion('   ')).toBe(false);
  });
});

describe('who reopens a finished conversation', () => {
  it('the customer does', () => {
    expect(reopensConversation({ fromMe: false })).toBe(true);
  });

  it('our own side does not - neither the operator nor the assistant', () => {
    // The assistant waking itself is an obvious loop. The operator is the
    // subtler one: when a person on this side writes into a chat they are
    // handling it, and an assistant that treated that as a new customer
    // turn would be answering its own colleague.
    expect(reopensConversation({ fromMe: true })).toBe(false);
  });
});

describe('separating the old conversation from the new one', () => {
  const history = [
    { id: 'a', text: 'morning' },
    { id: 'b', text: 'we open at 11' },
    { id: 'c', text: 'ok thanks' },
    { id: 'd', text: 'actually - do you cater?' },
  ];

  it('puts everything up to and including the closure behind us', () => {
    const { background, current } = splitEpisode(history, 'c');
    expect(background.map((message) => message.id)).toEqual(['a', 'b', 'c']);
    expect(current.map((message) => message.id)).toEqual(['d']);
  });

  it('treats the whole window as current when nothing has been closed', () => {
    const { background, current } = splitEpisode(history, null);
    expect(background).toEqual([]);
    expect(current).toHaveLength(4);
  });

  it('keeps everything current when the closure message is no longer in the window', () => {
    // It scrolled out of the window, or it was deleted. Discarding the
    // whole history on a boundary we cannot find would leave the agent
    // replying with no idea what to. Reading a little too much is the
    // cheaper mistake.
    const { background, current } = splitEpisode(history, 'long-gone');
    expect(background).toEqual([]);
    expect(current).toHaveLength(4);
  });

  it('leaves nothing current when the closure is the newest thing there is', () => {
    const { current } = splitEpisode(history, 'd');
    expect(current).toEqual([]);
  });
});

describe('telling the model where the old conversation ended', () => {
  it('says nothing at all for an ordinary continuing conversation', () => {
    expect(describeEpisodeBoundary(0)).toBeNull();
  });

  it('names the boundary and forbids replying across it', () => {
    const line = describeEpisodeBoundary(3)!;
    expect(line).toContain('first 3 messages');
    expect(line).toContain('already finished');
    expect(line).toMatch(/do not reply to them/i);
    expect(line).toMatch(/reply only to what they have said since/i);
  });

  it('says "first message" rather than "first 1 messages"', () => {
    expect(describeEpisodeBoundary(1)).toContain('first message');
  });
});

describe('remembering that the conversation finished', () => {
  let businessId: string;
  let chatId: string;
  let states: ConversationStateRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    states = new ConversationStateRepository(pool);

    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550003333@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
  });

  const MESSAGE = '11111111-1111-4111-8111-111111111111';
  const LATER = '22222222-2222-4222-8222-222222222222';

  it('starts with no closure, so an ordinary conversation behaves as it always did', async () => {
    const state = await states.getOrCreate(businessId, chatId);
    expect(state.closedAt).toBeNull();
    expect(state.closedAtMessageId).toBeNull();
  });

  it('records the message the agent was looking at when it closed', async () => {
    await states.markClosed(businessId, chatId, MESSAGE);

    const state = await states.find(businessId, chatId);
    expect(state?.closedAtMessageId).toBe(MESSAGE);
    expect(state?.closedAt).not.toBeNull();
  });

  it('moves the boundary when the conversation closes a second time', async () => {
    await states.markClosed(businessId, chatId, MESSAGE);
    await states.markClosed(businessId, chatId, LATER);
    expect((await states.find(businessId, chatId))?.closedAtMessageId).toBe(LATER);
  });

  it('creates the row when none exists yet, rather than losing the closure', async () => {
    // A conversation the model has never written state for is the common
    // case for a short exchange - which is exactly the kind that closes.
    await states.markClosed(businessId, chatId, MESSAGE);
    expect(await states.find(businessId, chatId)).not.toBeNull();
  });

  it('leaves the model\'s own reasoning untouched', async () => {
    // markClosed deliberately sidesteps the optimistic version check, so
    // this pins that sidestepping it does not trample what the model wrote.
    const created = await states.getOrCreate(businessId, chatId);
    await states.update(businessId, chatId, created.version, {
      confirmedFacts: [{ fact: 'Lives in Oistins', confidence: 'HIGH', source: 'customer' }] as never,
    });

    await states.markClosed(businessId, chatId, MESSAGE);

    const state = await states.find(businessId, chatId);
    expect(state?.confirmedFacts).toHaveLength(1);
    expect(state?.closedAtMessageId).toBe(MESSAGE);
  });
});
