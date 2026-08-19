import type { MessageStatus } from './types.js';

/**
 * proto.WebMessageInfo.Status: ERROR=0, PENDING=1, SERVER_ACK=2,
 * DELIVERY_ACK=3, READ=4, PLAYED=5. Returns null for anything else (a
 * messages.update event can carry unrelated changes, e.g. reactions or
 * edits, with no status field at all) so callers know not to write anything.
 */
export function mapBaileysMessageStatus(status: number | null | undefined): MessageStatus | null {
  switch (status) {
    case 0:
      return 'failed';
    case 1:
      return 'pending';
    case 2:
      return 'sent';
    case 3:
      return 'delivered';
    case 4:
      return 'read';
    case 5:
      return 'played';
    default:
      return null;
  }
}
