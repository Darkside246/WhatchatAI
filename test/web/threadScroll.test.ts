import { describe, expect, it } from 'vitest';
import { decideThreadScroll, type ThreadScrollState } from '../../src/web/src/lib/threadScroll.js';

/**
 * The deep-link anchor has to be spent.
 *
 * Reported as a forwarding bug - "when i forward something the image goes
 * but it goes not to the bottom of the chat but to a random location in the
 * chat starting the chat from like a day before or hours before" - and it
 * has nothing to do with forwarding. A test driving the whole server
 * pipeline puts a forward last in the thread, stored at the second it was
 * sent. The message was at the bottom all along. The THREAD was looking
 * somewhere else, because nothing ever removed ?message= from the URL:
 *
 *   Every later render left the view pinned in the history, so anything
 *   arriving - a reply, a forward the operator had just sent - landed out
 *   of sight below.
 *
 *   Every re-entry to that chat read the same id back out of the URL and
 *   scrolled to the same old message again, for as long as the tab lived.
 */

const base: ThreadScrollState = {
  pendingInitialScroll: true,
  anchorMessageId: null,
  anchorIsLoaded: false,
  followNewest: true,
};

describe('opening a chat from a deep link', () => {
  const anchored: ThreadScrollState = { ...base, anchorMessageId: 'old-message', anchorIsLoaded: true };

  it('goes to the message somebody was sent to', () => {
    expect(decideThreadScroll(anchored)).toMatchObject({ kind: 'anchor', messageId: 'old-message' });
  });

  it('spends the anchor in the same breath', () => {
    // The whole fix. Without this the anchor is not used once, it is
    // permanent.
    expect(decideThreadScroll(anchored).consumeAnchor).toBe(true);
  });

  it('counts as reading history, so an arriving message does not yank the view', () => {
    expect(decideThreadScroll(anchored)).toMatchObject({ followNewest: false });
  });
});

describe('the same chat, after the anchor has been spent', () => {
  it('follows a new message to the bottom when the operator is at the live end', () => {
    // This is the render that used to do nothing at all - the forward
    // arriving underneath a view pinned a day up the thread.
    const action = decideThreadScroll({ ...base, pendingInitialScroll: false, followNewest: true });
    expect(action.kind).toBe('newest');
  });

  it('still leaves somebody alone who has deliberately scrolled up', () => {
    // Not a regression to fix: reading history is an explicit act and an
    // incoming message must never interrupt it. It is only a problem when
    // a stale anchor put them there without asking.
    const action = decideThreadScroll({ ...base, pendingInitialScroll: false, followNewest: false });
    expect(action.kind).toBe('stay');
  });

  it('re-opening the chat goes to the newest message, not back to the old one', () => {
    // With the anchor gone from the URL there is nothing to re-anchor to.
    const action = decideThreadScroll({ ...base, anchorMessageId: null });
    expect(action.kind).toBe('newest');
  });
});

describe('an anchor that cannot be honoured', () => {
  const missing: ThreadScrollState = { ...base, anchorMessageId: 'not-in-this-chat', anchorIsLoaded: false };

  it('falls through to the newest message rather than stranding somebody at the top', () => {
    expect(decideThreadScroll(missing).kind).toBe('newest');
  });

  it('drops the anchor rather than retrying it forever', () => {
    // An id this chat does not contain will not start containing one -
    // and keeping it means every re-entry pays for the lookup and risks
    // matching something in a DIFFERENT chat later.
    expect(decideThreadScroll(missing).consumeAnchor).toBe(true);
  });
});

describe('an ordinary chat with no deep link', () => {
  it('opens at the newest message', () => {
    expect(decideThreadScroll(base)).toMatchObject({ kind: 'newest', followNewest: true });
  });

  it('has no anchor to spend, so it asks for no URL change', () => {
    // Rewriting the URL on every render of every chat would be a needless
    // history entry storm.
    expect(decideThreadScroll(base).consumeAnchor).toBe(false);
    expect(decideThreadScroll({ ...base, pendingInitialScroll: false, followNewest: false }).consumeAnchor).toBe(false);
  });
});
