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

  if (readsAsAQuestion(input.customerText)) {
    // The expensive failure, and the one actually reported: a customer
    // asks something, the model judges the exchange finished, and the
    // business simply never answers.
    return { closed: false, reason: 'the customer asked something - not closing on an unanswered question' };
  }

  if (input.openQuestionCount > 0) {
    return { closed: false, reason: `${input.openQuestionCount} question(s) still owed to this customer` };
  }

  return { closed: true, reason: 'nothing outstanding and nothing left to say' };
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
