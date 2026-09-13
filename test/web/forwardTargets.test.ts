import { describe, expect, it } from 'vitest';
import { forwardTargets } from '../../src/web/src/lib/forwardTargets.js';
import type { WorkspaceChatSummary } from '../../src/web/src/lib/api.js';

function chat(overrides: Partial<WorkspaceChatSummary> & { id: string }): WorkspaceChatSummary {
  return {
    displayName: overrides.id,
    phoneNumber: null,
    chatType: 'individual',
    unreadCount: 0,
    lastMessageAt: null,
    pinned: false,
    archived: false,
    ...overrides,
  } as WorkspaceChatSummary;
}

/** A conversation that carried a message at a given minute past the hour. */
function at(id: string, minute: number, rest: Partial<WorkspaceChatSummary> = {}): WorkspaceChatSummary {
  return chat({ id, lastMessageAt: `2026-09-13T12:${String(minute).padStart(2, '0')}:00.000Z`, ...rest });
}

const DEFAULTS = { excludeChatId: 'source', query: '', showAll: false };

describe('who a message can be forwarded to', () => {
  it('puts the most recently active conversation first', () => {
    const { visible } = forwardTargets([at('older', 1), at('newest', 9), at('middle', 5)], DEFAULTS);
    expect(visible.map((c) => c.id)).toEqual(['newest', 'middle', 'older']);
  });

  it('sorts a conversation that never carried a message last, not first', () => {
    const { visible } = forwardTargets([chat({ id: 'never' }), at('recent', 5)], DEFAULTS);
    expect(visible.map((c) => c.id)).toEqual(['recent', 'never']);
  });

  it('never offers to forward a message back into the conversation it is already in', () => {
    const { visible } = forwardTargets([at('source', 9), at('other', 1)], DEFAULTS);
    expect(visible.map((c) => c.id)).toEqual(['other']);
  });

  it('never offers a channel, which only its owner can post to', () => {
    const { visible } = forwardTargets([at('feed', 9, { chatType: 'newsletter' }), at('person', 1)], DEFAULTS);
    expect(visible.map((c) => c.id)).toEqual(['person']);
  });
});

describe('the recent shortlist', () => {
  const many = Array.from({ length: 25 }, (_, index) => at(`chat-${index}`, index));

  it('shows only the recent few, and says how many it is holding back', () => {
    const { visible, hiddenCount, matching } = forwardTargets(many, DEFAULTS);
    expect(visible).toHaveLength(10);
    expect(matching).toHaveLength(25);
    expect(hiddenCount).toBe(15);
  });

  it('holds back the oldest, never the newest', () => {
    const { visible } = forwardTargets(many, DEFAULTS);
    expect(visible[0]!.id).toBe('chat-24');
    expect(visible.map((c) => c.id)).not.toContain('chat-0');
  });

  it('shows everything once somebody asks for it, with nothing left hidden', () => {
    const { visible, hiddenCount } = forwardTargets(many, { ...DEFAULTS, showAll: true });
    expect(visible).toHaveLength(25);
    expect(hiddenCount).toBe(0);
  });

  it('does not shortlist a list that already fits', () => {
    const { visible, hiddenCount } = forwardTargets([at('a', 1), at('b', 2)], DEFAULTS);
    expect(visible).toHaveLength(2);
    expect(hiddenCount).toBe(0);
  });
});

describe('searching', () => {
  const people = [
    at('ruth', 9, { displayName: 'Ruth Alkins', phoneNumber: '+1 (246) 555-1234' }),
    at('gobble', 5, { displayName: 'Gobble' }),
    at('ta', 1, { displayName: 'Ta', phoneNumber: '+1 246 232 5431' }),
  ];

  it('finds somebody by name, whatever the case', () => {
    const { visible } = forwardTargets(people, { ...DEFAULTS, query: 'ruth' });
    expect(visible.map((c) => c.id)).toEqual(['ruth']);
  });

  it('finds somebody by number typed without the punctuation they are stored with', () => {
    const { visible } = forwardTargets(people, { ...DEFAULTS, query: '2465551234' });
    expect(visible.map((c) => c.id)).toEqual(['ruth']);
  });

  it('does not match every contact just because the query has no digits in it', () => {
    // A digits-only comparison of "" is a substring of every phone number,
    // which would quietly return the whole address book for any name search.
    const { visible } = forwardTargets(people, { ...DEFAULTS, query: 'zzz' });
    expect(visible).toEqual([]);
  });

  it('shows every match rather than the recent few of them', () => {
    const many = Array.from({ length: 25 }, (_, index) => at(`chat-${index}`, index, { displayName: `Ruth ${index}` }));
    const { visible, hiddenCount } = forwardTargets(many, { ...DEFAULTS, query: 'ruth' });
    expect(visible).toHaveLength(25);
    expect(hiddenCount).toBe(0);
  });

  it('reports that it is searching, so the empty state can say the right thing', () => {
    expect(forwardTargets(people, { ...DEFAULTS, query: 'ruth' }).searching).toBe(true);
    expect(forwardTargets(people, DEFAULTS).searching).toBe(false);
    // Whitespace is not a search - it would otherwise switch the dialog into
    // "nothing matches that" the moment somebody hit the space bar.
    expect(forwardTargets(people, { ...DEFAULTS, query: '   ' }).searching).toBe(false);
  });

  it('still excludes the source conversation and channels while searching', () => {
    const { visible } = forwardTargets(
      [at('source', 9, { displayName: 'Ruth A' }), at('feed', 8, { displayName: 'Ruth B', chatType: 'newsletter' }), at('ok', 1, { displayName: 'Ruth C' })],
      { ...DEFAULTS, query: 'ruth' },
    );
    expect(visible.map((c) => c.id)).toEqual(['ok']);
  });
});
