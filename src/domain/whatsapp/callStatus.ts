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

// 'accepted' means the call is now in progress, not over - it is
// deliberately NOT terminal. Only these four represent a call that has
// actually ended, one way or another.
const TERMINAL_CALL_STATUSES: ReadonlySet<CallStatus> = new Set(['rejected', 'missed', 'timeout', 'ended']);

export function isTerminalCallStatus(status: CallStatus): boolean {
  return TERMINAL_CALL_STATUSES.has(status);
}
