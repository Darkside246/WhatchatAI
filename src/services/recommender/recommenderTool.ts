import { Type, type FunctionDeclaration } from '@google/genai';

/**
 * Letting the agent say "people usually have that with a mauby".
 *
 * The tool is read-only and deliberately thin. It returns what the counting
 * found and nothing else - no persuasion, no generated copy, no ranking the
 * model is invited to reinterpret. The agent decides whether mentioning it
 * fits the conversation, which is a judgement a model is genuinely better at
 * than a rule.
 *
 * What the tool refuses to do is the important part. It will not invent a
 * pairing, it will not return anything under the evidence floor, and it
 * cannot be asked for "something to upsell" in general - only for what
 * actually goes with a named item. An agent that can ask "what should I push
 * today" will push whatever it likes and call it data.
 */

export const SUGGEST_COMPANIONS_TOOL_NAME = 'suggest_companions';

export const suggestCompanionsFunctionDeclaration: FunctionDeclaration = {
  name: SUGGEST_COMPANIONS_TOOL_NAME,
  description:
    'Tells you what this business\'s own customers usually take ALONGSIDE a particular item, counted from real past ' +
    'orders. Use it when somebody has chosen something and a genuine companion would help them - "people usually ' +
    'have that with a mauby" - never to push whatever is most expensive. It returns nothing when there is not enough ' +
    'real history to be sure, and an empty answer means say nothing rather than make something up. Never claim a ' +
    'pairing this did not return, and never present a suggestion as the customer\'s own idea.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      item: {
        type: Type.STRING,
        description:
          'The item the customer has already chosen, in their words or the menu\'s - e.g. "chicken roti", "the large pepperoni".',
      },
    },
    required: ['item'],
  },
};

export interface CompanionSuggestion {
  name: string;
  /** Why, in a sentence an owner could check. Given to the model so it never has to guess at strength. */
  evidence: string;
}

/**
 * What the model is handed back.
 *
 * `suggestions` is empty rather than absent when there is nothing to say, and
 * the accompanying note tells the model what empty means - otherwise a model
 * handed `{}` will helpfully fill the silence, which is the exact failure
 * this whole feature has to avoid.
 */
export function companionToolResponse(
  item: string,
  companions: { label: string; pairCustomers: number; ofCustomers: number }[],
): { item: string; suggestions: CompanionSuggestion[]; note: string } {
  if (companions.length === 0) {
    return {
      item,
      suggestions: [],
      note:
        'No companion is supported by enough real orders yet. Say nothing about pairings - do not suggest anything ' +
        'from the menu as though customers usually order it together.',
    };
  }

  return {
    item,
    suggestions: companions.map((companion) => ({
      name: companion.label,
      evidence: `${companion.pairCustomers} of the ${companion.ofCustomers} customers who took ${item} also took this.`,
    })),
    note:
      'Mention at most one, only if it fits naturally, and only once in a conversation. A customer who says no has ' +
      'answered - do not ask again.',
  };
}
