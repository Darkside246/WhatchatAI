import type { WACallUpdateType } from '@whiskeysockets/baileys';
import type { CallStatus, CallType } from './types.js';

/**
 * Only user-meaningful call state transitions are ever persisted -
 * 'transport' and 'relaylatency' are internal WebRTC signaling noise with no
 * corresponding value in our schema, so they're intentionally dropped here
 * rather than mapped to a fabricated status.
 */
export function mapBaileysCallStatus(status: WACallUpdateType): CallStatus | null {
  switch (status) {
    case 'offer':
      return 'offer';
    case 'ringing':
    case 'preaccept':
      return 'ringing';
    case 'accept':
      return 'accepted';
    case 'reject':
      return 'rejected';
    case 'timeout':
      return 'missed';
    case 'terminate':
      return 'ended';
    default:
      return null;
  }
}

export function callTypeFromEvent(isVideo: boolean | undefined): CallType {
  return isVideo ? 'video' : 'voice';
}

const TERMINAL_CALL_STATUSES: ReadonlySet<CallStatus> = new Set(['accepted', 'rejected', 'missed', 'ended']);

export function isTerminalCallStatus(status: CallStatus): boolean {
  return TERMINAL_CALL_STATUSES.has(status);
}
