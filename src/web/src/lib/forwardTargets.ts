import type { WorkspaceChatSummary } from './api.js';

/**
 * Which conversations a message can be forwarded to, and in what order.
 *
 * Separated from the dialog because the ordering is the part with real
 * decisions in it - what counts as recent, what is excluded, what a search
 * actually searches - and none of that is testable while it lives inside a
 * component that needs a running API to render.
 */

/** How many to offer before somebody asks for the rest. */
export const RECENT_COUNT = 10;

export interface ForwardTargetOptions {
  /** The conversation the message is already in. Forwarding it back there is not a thing anybody means to do. */
  excludeChatId: string;
  query: string;
  /** Set once somebody has asked past the recent shortlist. */
  showAll: boolean;
  recentCount?: number;
}

export interface ForwardTargets {
  /** What to render now. */
  visible: WorkspaceChatSummary[];
  /** Everything that matched, shown or not - the number the "show all" button quotes. */
  matching: WorkspaceChatSummary[];
  /** How many matched but are not being shown. Zero while searching or after "show all". */
  hiddenCount: number;
  /** True when a query is narrowing the list, which changes both the empty-state wording and whether a shortlist applies. */
  searching: boolean;
}

/** Digits only, so a typed number matches however the contact happens to be punctuated. */
function digits(value: string): string {
  return value.replace(/[^0-9]/g, '');
}

export function forwardTargets(
  chats: WorkspaceChatSummary[],
  options: ForwardTargetOptions,
): ForwardTargets {
  const recentCount = options.recentCount ?? RECENT_COUNT;

  const forwardable = chats
    // A channel is a broadcast feed only its owner can post to - a forward
    // into one would be refused by WhatsApp after we had already told the
    // operator it was sent.
    .filter((chat) => chat.chatType !== 'newsletter' && chat.id !== options.excludeChatId)
    /**
     * Most recently active first, not alphabetical.
     *
     * Forwarding is nearly always to somebody you were just talking to, and
     * sorting by name puts them wherever their name happens to fall. A
     * conversation that has never carried a message sorts last: it has no
     * recency to claim, and it is not what anybody is looking for.
     */
    .sort((left, right) => {
      const leftAt = left.lastMessageAt ? Date.parse(left.lastMessageAt) : 0;
      const rightAt = right.lastMessageAt ? Date.parse(right.lastMessageAt) : 0;
      return rightAt - leftAt;
    });

  const wanted = options.query.trim().toLowerCase();
  const searching = wanted.length > 0;
  const wantedDigits = digits(wanted);

  const matching = searching
    ? forwardable.filter((chat) => {
        if (chat.displayName.toLowerCase().includes(wanted)) return true;
        const phone = chat.phoneNumber ?? '';
        if (phone.toLowerCase().includes(wanted)) return true;
        // Only when the query actually contains digits - an empty digit
        // string is a substring of everything, which would match every
        // conversation for a purely alphabetic search.
        return wantedDigits.length > 0 && digits(phone).includes(wantedDigits);
      })
    : forwardable;

  // Searching always shows everything it found: somebody who typed a name is
  // asking for that name, not for the ten most recent things containing it.
  const visible = searching || options.showAll ? matching : matching.slice(0, recentCount);

  return { visible, matching, hiddenCount: matching.length - visible.length, searching };
}
