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
