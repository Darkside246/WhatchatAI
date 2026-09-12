import type { WhatsAppJidKind } from './jid.js';
import type { ChatType } from './types.js';

export function chatTypeFromJidKind(jidKind: WhatsAppJidKind): ChatType {
  switch (jidKind) {
    case 'individual':
    case 'lid':
      return 'individual';
    case 'group':
      return 'group';
    case 'broadcast':
      return 'broadcast';
    case 'newsletter':
      return 'newsletter';
    default:
      return 'other';
  }
}

/**
 * Whether this "chat" is a broadcast feed rather than a conversation.
 *
 * A WhatsApp Channel (newsletter JID) is read-only by nature: only its
 * owner can post to it, so nothing the AI or an operator writes can ever
 * reach it. That makes it the wrong shape for two things it was previously
 * being fed into - the AI reply path, and the human-handoff queue. There is
 * no reply to generate and no human action available, so a channel must
 * never enter either.
 *
 * Lives here, in a module with no imports beyond types, so the worker and
 * its tests can share it without a test importing the worker - which starts
 * a real BullMQ consumer the moment it is loaded.
 */
export function isBroadcastFeed(chat: { chatType: string }): boolean {
  return chat.chatType === 'newsletter';
}
