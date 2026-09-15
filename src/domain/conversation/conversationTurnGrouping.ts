import type { Content } from '@google/genai';

/**
 * Coalesces consecutive turns from the same speaker into one model turn.
 *
 * Messaging clients commonly deliver a thought as several bubbles. Presenting
 * every bubble as a separate turn makes the model treat one thought as a
 * back-and-forth. Text is joined in arrival order, while non-text parts such
 * as inline media remain attached to the merged turn.
 */
export function groupConversationTurns(turns: readonly Content[]): Content[] {
  const grouped: Content[] = [];

  for (const turn of turns) {
    const previous = grouped[grouped.length - 1];
    const canMerge =
      previous != null &&
      (turn.role === 'user' || turn.role === 'model') &&
      previous.role === turn.role;

    if (!canMerge) {
      grouped.push({ ...turn, parts: [...(turn.parts ?? [])] });
      continue;
    }

    const combinedParts = [...(previous.parts ?? []), ...(turn.parts ?? [])];
    const textParts = combinedParts.filter(isTextPart);
    const nonTextParts = combinedParts.filter((part) => !isTextPart(part));
    const text = textParts.map((part) => part.text).filter((part) => part.length > 0).join('\n');

    grouped[grouped.length - 1] = {
      ...previous,
      parts: [
        ...(text.length > 0 ? [{ text }] : []),
        ...nonTextParts,
      ],
    };
  }

  return grouped;
}

function isTextPart(part: unknown): part is { text: string } {
  return typeof part === 'object' && part !== null && 'text' in part && typeof (part as { text?: unknown }).text === 'string';
}
