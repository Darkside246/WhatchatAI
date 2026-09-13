/**
 * Where a conversation should be scrolled to, and whether the deep-link
 * anchor has been used up.
 *
 * THE BUG THIS EXISTS TO FIX. Opening a chat from the "Messages for you"
 * board deep-links to one message: /inbox/<chat>?message=<id>. The thread
 * scrolls there, and marks the operator as reading history rather than
 * following the live end - both correct. What was missing is that nothing
 * ever removed `message` from the URL, so the anchor was not used once. It
 * was permanent:
 *
 *   Every later render of that chat - a reply arriving, a poll, a message
 *   the operator sent themselves - found followNewest false and left the
 *   view pinned up in the history. The new message was at the bottom, out
 *   of sight.
 *
 *   Every RE-ENTRY to that chat re-read the same `message` from the URL and
 *   scrolled back to the same old message again. For as long as that tab
 *   lived, the conversation opened a day ago.
 *
 * Reported as a forwarding bug - "when i forward something the image goes
 * but it goes not to the bottom of the chat but to a random location in the
 * chat starting the chat from like a day before" - which is exactly what
 * this produces and is nothing to do with forwarding. The message really is
 * at the bottom; the thread is looking somewhere else. A test driving the
 * whole server pipeline (forwardPlacement.test.ts) puts a forward last in
 * the thread, stored at the second it was sent, which is what sent the
 * search here.
 *
 * Extracted as a pure decision so the rule is checkable without a browser:
 * the component then only has to carry it out.
 */

export type ThreadScrollAction =
  /** Put this message in the middle of the view - a deep link being followed. */
  | { kind: 'anchor'; messageId: string; consumeAnchor: true; followNewest: false }
  /** Go to the newest message. */
  | { kind: 'newest'; consumeAnchor: boolean; followNewest: true }
  /** Leave the view exactly where the operator put it. */
  | { kind: 'stay'; consumeAnchor: boolean };

export interface ThreadScrollState {
  /** True until this chat has been positioned once since it was opened. */
  pendingInitialScroll: boolean;
  /** The ?message= id, or null. */
  anchorMessageId: string | null;
  /** Whether that message is actually in the window the browser has loaded. */
  anchorIsLoaded: boolean;
  /** Whether the operator is currently reading the live end. */
  followNewest: boolean;
}

/**
 * Decides what the thread should do now that its messages have changed.
 *
 * `consumeAnchor` means "take `message` out of the URL". It is returned
 * true whenever the anchor has served its purpose OR can no longer serve
 * it - an anchor pointing at a message that is not in this chat is not
 * something to keep trying, it is something to forget. Leaving it in the
 * URL is the whole bug.
 */
export function decideThreadScroll(state: ThreadScrollState): ThreadScrollAction {
  if (state.pendingInitialScroll && state.anchorMessageId) {
    if (state.anchorIsLoaded) {
      // Landed on the message somebody was sent to. From here the thread is
      // ordinary: the anchor is spent, and the operator is reading history
      // rather than following the live end until they scroll back down.
      return { kind: 'anchor', messageId: state.anchorMessageId, consumeAnchor: true, followNewest: false };
    }

    // Not in the loaded window, or deleted. Falling through to the newest
    // message rather than stranding somebody at the top with no
    // explanation - and dropping the anchor, because an id this chat does
    // not contain will not start containing one.
    return { kind: 'newest', consumeAnchor: true, followNewest: true };
  }

  if (state.pendingInitialScroll || state.followNewest) {
    return { kind: 'newest', consumeAnchor: Boolean(state.anchorMessageId), followNewest: true };
  }

  // Reading history. An arriving message must never yank the view - that is
  // a deliberate feature, and the reason the permanent anchor was able to
  // hide new messages for so long without looking like a bug.
  return { kind: 'stay', consumeAnchor: Boolean(state.anchorMessageId) };
}
