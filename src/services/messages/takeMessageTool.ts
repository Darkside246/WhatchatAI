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
    'Call this whenever the customer wants something passed along or wants to be called/followed up with, even ' +
    'when they never name a specific recipient - every conversation is already with this business, so "call me ' +
    'back", "can someone reach out to me at 8pm", "remind me" (meaning: have someone here follow up), or "can you ' +
    'remind him/her/them" all mean the SAME business/owner this chat already belongs to. Do not ask the customer ' +
    'who the message is for - default recipientDescription to "the owner" unless they explicitly named someone ' +
    'else (e.g. "tell John to call me", "let my son know I\'m on my way", "I want Hasan to call me at 8pm"). ' +
    '"Remind" is just as strong a trigger as "tell"/"let ... know"/"call me" - a bare "can you remind him?" later ' +
    'in the same conversation, referring back to something already discussed, still calls for this tool: build ' +
    'messageText as a concise summary of what was actually discussed earlier in this conversation (never invented, ' +
    'never embellished beyond what was really said), not by asking the customer to repeat themselves. Do not call ' +
    'this for a message meant for you or for routine conversation. ' +
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
        description: 'Who the message is for. Default to "the owner" when the customer never named anyone specific - never ask them to clarify this. Only use a specific name/relation (e.g. "Hasan", "John", "my son") when the customer actually said one.',
      },
      messageText: {
        type: Type.STRING,
        description:
          'The message itself, in the customer\'s own words or a short accurate paraphrase - or, when the ' +
          'customer only said "remind him"/"remind them" without restating it, a concise summary of what they ' +
          'actually asked for or discussed earlier in this same conversation. Never invent or embellish beyond ' +
          'what was really said.',
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
