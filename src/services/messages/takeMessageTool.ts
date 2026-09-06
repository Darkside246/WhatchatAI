import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

export const TAKE_MESSAGE_TOOL_NAME = 'take_a_message';

/**
 * Real, confirmed gap this closes: a customer asking the AI to relay
 * something to someone else (the business owner, a family member, a
 * colleague) had nowhere real to land - the AI would acknowledge it in
 * the chat, but nothing ever surfaced it anywhere a human would actually
 * see it, the same way a phone message taken by a receptionist would be
 * lost if it were never written down. Writes only to relayed_messages
 * for this exact (business, chat) - cannot touch any other record or
 * execute any action, same narrow shape as update_conversation_memory.
 *
 * The AM/PM disambiguation instruction below is deliberately load-bearing,
 * not decorative: get_current_time is already available to every agent
 * that has this tool, and the model is expected to actually use it before
 * guessing at an ambiguous time - asking the customer directly in a
 * normal chat reply costs nothing, while guessing wrong on "call me at 8"
 * could mean a message that's already hours late by the time anyone sees it.
 */
export const takeMessageFunctionDeclaration: FunctionDeclaration = {
  name: TAKE_MESSAGE_TOOL_NAME,
  description:
    'Call this when the customer asks you to pass a message along to someone else - the business owner, or a ' +
    'specific named person (e.g. "tell John to call me", "let my son know I\'m on my way") - rather than something ' +
    'you can answer yourself. Do not call this for a message meant for you or for routine conversation. ' +
    'If the customer mentions a time but does not say AM or PM, check get_current_time first: if the current time ' +
    'makes only one interpretation possible (e.g. it is 9pm and they said "call me at 8" - 8am tomorrow is the only ' +
    'sensible reading, since 8pm already passed), resolve it yourself and say so plainly in whenText. If it is ' +
    'genuinely ambiguous (either reading is still plausible), ask the customer to clarify in your own reply first - ' +
    'do not call this tool until you have a clear answer or the customer has moved on without giving one, in which ' +
    'case call it without a whenText.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      recipientDescription: {
        type: Type.STRING,
        description: 'Who the message is for, in the customer\'s own words or a short accurate paraphrase - e.g. "the owner", "John", "my son".',
      },
      messageText: {
        type: Type.STRING,
        description: 'The message itself, in the customer\'s own words or a short accurate paraphrase. Never invent or embellish beyond what they actually said.',
      },
      whenText: {
        type: Type.STRING,
        description:
          'A clear, already-disambiguated description of when, only if the customer mentioned a time - e.g. "8:00 PM today" or "tomorrow morning". Omit entirely if no time was mentioned, or if AM/PM is still genuinely ambiguous (ask the customer instead of guessing).',
      },
    },
    required: ['recipientDescription', 'messageText'],
  },
};

export interface TakeMessageToolArgs {
  recipientDescription: string;
  messageText: string;
  whenText?: string;
}
