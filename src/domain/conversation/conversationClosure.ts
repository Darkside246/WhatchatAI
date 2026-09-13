/**
 * When a conversation is finished, and what happens when it starts again.
 *
 * THE PROBLEM THIS SOLVES. The agent already decides, turn by turn, whether
 * there is anything worth saying - and when it decides there is not, the
 * reply pipeline records "the agent judged the exchange closed and chose to
 * say nothing". That judgement was made fresh every single time, against no
 * memory of having made it before, and nothing anywhere recorded that the
 * conversation had ended. Two things followed, both seen in production:
 *
 *   The agent went quiet on a customer who was still waiting, because one
 *   turn's judgement of "closed" is exactly the kind of call a model gets
 *   wrong on a short message, and nothing checked it.
 *
 *   When the customer did come back hours later, their message arrived at
 *   the bottom of a long history the model read as one continuous thread,
 *   so it answered a conversation that had already ended instead of the
 *   sentence in front of it.
 *
 * THE SHAPE OF THE ANSWER. The model decides; this module checks the
 * decision and the system remembers it.
 *
 *   1. The model says whether it has anything to say.
 *   2. judgeClosure() can OVERRULE a "closed" - never an "open". It refuses
 *      to close a conversation where the customer has asked something, or
 *      where we are on record as owing them an answer.
 *   3. The closure is recorded against the message it was made on.
 *   4. The next message from the customer - not from the operator, not from
 *      the assistant - opens a NEW episode. Everything before the closure
 *      is background: read for context, never answered.
 *
 * WHY THE OVERRULE ONLY GOES ONE WAY. The two mistakes are not equal. An
 * agent that says something unnecessary is mildly annoying and a person can
 * see what happened. An agent that goes silent in front of a customer who
 * asked a question looks exactly like a business that does not care, and
 * nobody finds out until the customer gives up. So every rule here is
 * allowed to keep a conversation open and none of them is allowed to close
 * one.
 *
 * Pure and dependency-free on purpose: this decides whether a real customer
 * gets an answer, and it has to be checkable on its own rather than only
 * observable through a live chat and a model call.
 */

export interface ClosureJudgement {
  closed: boolean;
  /** Why, in words that belong in a log line an operator might read. */
  reason: string;
}

/**
 * Words that open a question without a question mark.
 *
 * People rarely punctuate on WhatsApp - "how much is delivery" and "when
 * you open" are the normal forms, not the exception - so a question mark
 * alone would miss most real questions. Deliberately short and deliberately
 * only used to keep a conversation OPEN: a false positive here costs one
 * unnecessary reply, and the list never has the power to end anything.
 */
const QUESTION_OPENERS = [
  'who', 'what', 'when', 'where', 'why', 'how', 'which', 'whose',
  'can', 'could', 'would', 'will', 'do', 'does', 'did', 'is', 'are', 'was', 'were',
  'any', 'anyone', 'anybody', 'is there', 'you have', 'yall have', 'allyuh have',
];

/** Asks something without necessarily punctuating it. */
export function readsAsAQuestion(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  if (trimmed.includes('?')) return true;

  const lowered = trimmed.toLowerCase();
  return QUESTION_OPENERS.some(
    (opener) => lowered === opener || lowered.startsWith(`${opener} `) || lowered.startsWith(`${opener}'`),
  );
}

/**
 * The short things people say when they are done talking.
 *
 * Matched as whole phrases rather than loose words, and consumed from the
 * front until nothing is left - so "ok thanks", "alright cool see you
 * later" and "thank you very much" all read as one sign-off, while "ok so
 * what time do you close" does not, because "what" is not on the list.
 *
 * Deliberately missing: "yes" and "no". On WhatsApp those are almost never
 * a goodbye - they are the answer to something our side asked, and the
 * reply to an answer is not silence.
 */
const SIGN_OFF_PHRASES = [
  // Longest first: the matcher takes the first phrase that fits, and
  // "thank" would otherwise swallow the front of "thank you very much".
  'thank you very much', 'thank you so much', 'thanks very much', 'thanks so much',
  'talk to you later', 'catch you later', 'have a good night', 'have a good day',
  'have a great day', 'have a good one', 'see you later', 'see you soon',
  'much appreciated', 'appreciate it', 'appreciated', 'good looking out',
  'see you then', 'see you', 'see ya', 'sounds good', 'sounds great',
  'works for me', 'that works', 'no problem', 'not a problem', 'no worries',
  'sure thing', 'will do', 'walk good', 'one love', 'take care', 'good night',
  'nighty night', 'all right', 'bye bye', 'nice one', 'good one', 'great stuff',
  'thank you', 'thankyou', 'thanks', 'thanx', 'thankx', 'thx', 'ty', 'tysm',
  'okay', 'okey', 'oki', 'ok', 'kk', 'k',
  'alright', 'aight', 'iight', 'ight',
  'cool', 'kool', 'nice', 'great', 'sweet', 'perfect', 'excellent', 'awesome',
  'lovely', 'wonderful', 'brilliant', 'fine', 'good',
  'bet', 'word', 'respect', 'blessings', 'peace', 'cheers',
  'got it', 'gotcha', 'gotchu', 'understood', 'noted',
  'goodbye', 'byebye', 'bye', 'laters', 'later', 'cya', 'night',
  'lol', 'lmao', 'haha', 'hahaha', 'hehe',
];

/** Words that only ever join two sign-offs together, never carry meaning of their own. */
const SIGN_OFF_FILLERS = ['and', 'then', 'again', 'so', 'very', 'much', 'too', 'man', 'boss'];

/**
 * True when the whole message is a sign-off and nothing else.
 *
 * The length cap is defensive rather than clever: a real goodbye is short,
 * and anything long enough to contain a request should be read as one even
 * if every word in it happens to be on the list.
 */
export function readsAsASignOff(text: string | null | undefined): boolean {
  const raw = (text ?? '').trim();
  if (!raw) return false;
  if (raw.includes('?')) return false;

  /* Emoji on its own is the commonest sign-off there is - a thumbs-up ends
     more WhatsApp conversations than any word does. Stripped to nothing
     with something having been there means exactly that. */
  const withoutEmoji = raw.replace(/[\p{Extended_Pictographic}\p{Emoji_Component}️]/gu, '').trim();
  if (!withoutEmoji) return !raw.includes('❓') && !raw.includes('❔');

  const normalised = withoutEmoji
    .toLowerCase()
    .replace(/[^a-z\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalised || normalised.length > 60) return false;

  let remaining = normalised;
  while (remaining) {
    const match = [...SIGN_OFF_PHRASES, ...SIGN_OFF_FILLERS].find(
      (phrase) => remaining === phrase || remaining.startsWith(`${phrase} `),
    );
    if (!match) return false;
    remaining = remaining.slice(match.length).trim();
  }

  return true;
}

/**
 * Whether the agent is allowed to say nothing this turn.
 *
 * ONE predicate, read in two places that must never disagree: the prompt
 * decides with it whether to even offer the model the option of silence,
 * and judgeClosure below checks the model's answer against it afterwards.
 * Two separate rules for the same decision would drift, and the drift
 * would show up as a customer nobody answered.
 *
 * The reported failure this narrows: the agent was going quiet on people
 * who were still talking. Judging an exchange "finished" is easy to get
 * wrong on a short message, and the rule that fixes it is the one a person
 * would use - if somebody said something, say something back. Silence is
 * for a goodbye, and only for a goodbye.
 */
export function silenceIsAvailable(input: {
  customerText: string | null;
  openQuestionCount: number;
}): { available: boolean; reason: string } {
  if (readsAsAQuestion(input.customerText)) {
    // The expensive failure, and the one actually reported: a customer
    // asks something, the model judges the exchange finished, and the
    // business simply never answers.
    return { available: false, reason: 'the customer asked something - not closing on an unanswered question' };
  }

  if (input.openQuestionCount > 0) {
    return { available: false, reason: `${input.openQuestionCount} question(s) still owed to this customer` };
  }

  const text = (input.customerText ?? '').trim();
  if (text && !readsAsASignOff(text)) {
    // Not a question, but not a goodbye either - they told us something,
    // and a person who is told something answers.
    return { available: false, reason: 'the customer said something of their own - that gets an answer, not silence' };
  }

  return { available: true, reason: 'nothing outstanding and nothing left to say' };
}

/**
 * Decides whether this exchange is over.
 *
 * `modelSaysClosed` is the agent's own judgement for this turn - it had
 * nothing to add. `customerText` is what they actually last said, and
 * `openQuestionCount` is how many questions this conversation's own state
 * records that we still owe them.
 */
export function judgeClosure(input: {
  modelSaysClosed: boolean;
  customerText: string | null;
  openQuestionCount: number;
}): ClosureJudgement {
  if (!input.modelSaysClosed) {
    return { closed: false, reason: 'the agent had something to say' };
  }

  const silence = silenceIsAvailable({ customerText: input.customerText, openQuestionCount: input.openQuestionCount });
  return { closed: silence.available, reason: silence.reason };
}

/**
 * Whether a newly arrived message reopens a closed conversation.
 *
 * Only the customer reopens one. The assistant's own messages obviously do
 * not - it would wake itself forever - and neither does the operator's:
 * when a person on this side writes into a chat they are handling it, and
 * an assistant that treated their message as a new customer turn would be
 * answering its own colleague.
 */
export function reopensConversation(message: { fromMe: boolean }): boolean {
  return !message.fromMe;
}

export interface EpisodeSplit<T> {
  /** Already dealt with. Given to the model for context, never answered. */
  background: T[];
  /** This episode - what the reply is actually to. */
  current: T[];
}

/**
 * Divides the loaded history into what has been handled and what has not.
 *
 * `history` is oldest-first. `closedAtMessageId` is the message the agent
 * was looking at when it last judged the conversation finished; everything
 * up to and including it is behind us.
 *
 * A closure id that is not in the window (the conversation has moved well
 * past it, or the message was deleted) leaves everything as current rather
 * than silently discarding the lot - the failure mode of guessing wrong
 * here is an agent with no idea what it is replying to, which is worse than
 * one that reads a little too much.
 */
export function splitEpisode<T extends { id: string }>(
  history: T[],
  closedAtMessageId: string | null,
): EpisodeSplit<T> {
  if (!closedAtMessageId) return { background: [], current: history };

  const boundary = history.findIndex((message) => message.id === closedAtMessageId);
  if (boundary === -1) return { background: [], current: history };

  return { background: history.slice(0, boundary + 1), current: history.slice(boundary + 1) };
}

/**
 * How many earlier messages the model is shown for context.
 *
 * Enough to know who this is and what was agreed, not so much that a
 * six-week-old thread crowds out the sentence being answered. Ten to
 * fifteen is what the business asked for and it matches what a person
 * scrolling back would actually read.
 */
export const EPISODE_CONTEXT_MESSAGES = 15;

/**
 * The sentence that tells the model where the old conversation ended.
 *
 * Stated rather than implied. A model handed a transcript answers the
 * transcript; the only reliable way to stop it re-answering yesterday is
 * to say, in words, which part of it is already dealt with.
 *
 * Returns null when there is no boundary to draw, so no line is added to
 * an ordinary continuing conversation.
 */
export function describeEpisodeBoundary(backgroundCount: number): string | null {
  if (backgroundCount <= 0) return null;

  return (
    `The ${backgroundCount === 1 ? 'first message' : `first ${backgroundCount} messages`} above are a PREVIOUS ` +
    'conversation that already finished. They are there so you know who this is and what was said before - ' +
    'read them, and do not reply to them, re-open them, or apologise for not having answered them. ' +
    'This customer has come back with something new: reply only to what they have said since.'
  );
}
