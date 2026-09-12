import { describe, expect, it } from 'vitest';
import { latestInboundMessage } from '../src/services/aiReplyService.js';
import type { WhatsAppMessageRecord } from '../src/repositories/whatsappMessageRepository.js';

/**
 * conversationHistory arrives newest-first (WhatsAppMessageRepository.listByChat
 * orders by timestamp DESC). Every fixture here is built in that order, because
 * the bug this covers was reading it as though it were chronological.
 */
function message(id: string, fromMe: boolean, textContent: string): WhatsAppMessageRecord {
  return {
    id,
    fromMe,
    textContent,
    direction: fromMe ? 'outbound' : 'inbound',
  } as unknown as WhatsAppMessageRecord;
}

describe('the customer message a turn is about', () => {
  /**
   * What the "Messages for you" board anchors to, and what the inbound risk
   * classification screens. Reading the newest-first list as chronological
   * picked the oldest message in the window instead - up to fifty messages
   * and potentially days away from the one the operator clicked on.
   */
  it('is the newest one they sent, not the oldest still in the window', () => {
    const history = [
      message('m5', true, 'well you would got to search it in the search bar'),
      message('m4', false, 'I guess'),
      message('m3', true, 'what that mean'),
      message('m2', false, 'can you remind him about it tomorrow at 1'),
      message('m1', false, 'good morning'),
    ];

    expect(latestInboundMessage(history)?.id).toBe('m4');
  });

  it('skips past our own replies to reach it', () => {
    const history = [message('out2', true, 'sent'), message('out1', true, 'also sent'), message('in1', false, 'asked')];
    expect(latestInboundMessage(history)?.id).toBe('in1');
  });

  /**
   * Null rather than a guess: the board entry is then recorded with no
   * anchor and opens the conversation normally, which is honest. Pointing
   * at one of our own messages would be worse than pointing at nothing.
   */
  it('is nothing at all when the customer has not said anything', () => {
    expect(latestInboundMessage([message('out1', true, 'hello?')])).toBeNull();
    expect(latestInboundMessage([])).toBeNull();
  });
});
