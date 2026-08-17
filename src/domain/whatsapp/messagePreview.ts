import type { MessageType } from './types.js';

const LABELS: Record<Exclude<MessageType, 'text'>, string> = {
  image: 'Photo',
  audio: 'Audio',
  voice_note: 'Voice message',
  video: 'Video',
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  sticker: 'Sticker',
  location: 'Location',
  contact: 'Contact card',
  contacts: 'Contact cards',
  reaction: 'Reaction',
  poll: 'Poll',
  poll_response: 'Poll response',
  button: 'Button message',
  interactive: 'Interactive message',
  system: 'System message',
  call_event: 'Call',
  unknown: 'Message',
};

/**
 * A real, human-readable stand-in for a non-text message's preview - never
 * the raw internal type name (`[unknown]`, `[system]`) verbatim. `unknown`
 * still honestly means "a real message arrived that this app hasn't
 * classified precisely," not a fabricated guess at its content.
 */
export function describeMessageType(messageType: MessageType): string {
  if (messageType === 'text') return 'Message';
  return LABELS[messageType];
}
