import { describe, expect, it } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import {
  WhatsAppMessageIngestionService,
  isConversationalMessage,
  type IngestedWhatsAppMessage,
} from '../src/services/whatsappMessageIngestionService.js';

/**
 * Calls WhatsApp logs in the conversation.
 *
 * Every one of these used to fall through classification to 'unsupported',
 * persist as 'unknown', and render in the middle of a real thread as the
 * literal words "System message" - so an owner could not tell a missed
 * customer call from WhatsApp's internal plumbing. The assertions below are
 * on the wording an operator actually reads, not only on the content type,
 * because the content type was never the part that was wrong to look at.
 */

const CUSTOMER_JID = '15550003333@s.whatsapp.net';

/** Real proto.Message.CallLogMessage.CallOutcome values - see Baileys' own WAProto. */
const CONNECTED = 0;
const MISSED = 1;
const FAILED = 2;
const REJECTED = 3;
const ACCEPTED_ELSEWHERE = 4;
const ONGOING = 5;
const SILENCED_BY_DND = 6;
const SILENCED_UNKNOWN_CALLER = 7;

/** proto.Message.CallLogMessage.CallType. */
const SCHEDULED_CALL = 1;
const VOICE_CHAT = 2;

const ingestion = new WhatsAppMessageIngestionService();

/**
 * Note the three s's in `callLogMesssage` - that is a real typo in WhatsApp's
 * own protobuf. Spelling it correctly here would make every one of these
 * tests pass against a field the wire never sends.
 */
function ingestCall(
  id: string,
  log: Record<string, unknown>,
  fromMe = false,
): IngestedWhatsAppMessage {
  const [ingested] = ingestion.ingestUpsert({
    messages: [
      {
        key: { id, remoteJid: CUSTOMER_JID, fromMe },
        message: { callLogMesssage: log },
        messageTimestamp: 1_700_000_000,
      } as unknown as WAMessage,
    ],
    type: 'notify',
  });
  if (!ingested) throw new Error('nothing was ingested');
  return ingested;
}

describe('WhatsApp call log messages', () => {
  it('classifies a missed inbound voice call as a call, not an unsupported message', () => {
    const ingested = ingestCall('call-missed', { callOutcome: MISSED, isVideo: false });

    expect(ingested.contentType).toBe('call_event');
    expect(ingested.textPreview).toBe('Missed voice call');
    expect(ingested.structuredPayload).toEqual({
      kind: 'call',
      outcome: 'missed',
      isVideo: false,
      durationSecs: null,
      isVoiceChat: false,
      scheduled: false,
    });
  });

  it('never tells the owner they missed a call they placed themselves', () => {
    const outbound = ingestCall('call-out', { callOutcome: MISSED, isVideo: false }, true);
    const inbound = ingestCall('call-in', { callOutcome: MISSED, isVideo: false }, false);

    expect(outbound.fullText).toBe('Voice call - no answer');
    expect(inbound.fullText).toBe('Missed voice call');
  });

  it('distinguishes a missed video call from a missed voice call', () => {
    expect(ingestCall('call-video', { callOutcome: MISSED, isVideo: true }).fullText).toBe('Missed video call');
  });

  it('reports the duration of a call that connected', () => {
    expect(ingestCall('call-2m', { callOutcome: CONNECTED, durationSecs: 134 }).fullText).toBe('Voice call - 2m 14s');
    expect(ingestCall('call-45s', { callOutcome: CONNECTED, durationSecs: 45 }).fullText).toBe('Voice call - 45s');
    expect(ingestCall('call-1h', { callOutcome: CONNECTED, durationSecs: 3_900 }).fullText).toBe('Voice call - 1h 5m');
    expect(ingestCall('call-exact', { callOutcome: CONNECTED, durationSecs: 120 }).fullText).toBe('Voice call - 2m');
  });

  it('treats a zero duration as no duration rather than an instant call', () => {
    const ingested = ingestCall('call-zero', { callOutcome: CONNECTED, durationSecs: 0 });

    expect(ingested.fullText).toBe('Voice call');
    expect(ingested.structuredPayload).toMatchObject({ durationSecs: null });
  });

  it('words every outcome WhatsApp can send', () => {
    expect(ingestCall('c-fail', { callOutcome: FAILED }).fullText).toBe('Voice call failed');
    expect(ingestCall('c-rej', { callOutcome: REJECTED }).fullText).toBe('Voice call you declined');
    expect(ingestCall('c-rej-out', { callOutcome: REJECTED }, true).fullText).toBe('Voice call declined');
    expect(ingestCall('c-else', { callOutcome: ACCEPTED_ELSEWHERE }).fullText).toBe('Voice call answered on another device');
    expect(ingestCall('c-on', { callOutcome: ONGOING }).fullText).toBe('Voice call in progress');
    expect(ingestCall('c-dnd', { callOutcome: SILENCED_BY_DND }).fullText).toBe('Voice call silenced - Do Not Disturb');
    expect(ingestCall('c-unk-caller', { callOutcome: SILENCED_UNKNOWN_CALLER }).fullText).toBe(
      'Voice call silenced - unknown caller',
    );
  });

  it('says only what it knows when WhatsApp sends no outcome at all', () => {
    const ingested = ingestCall('call-no-outcome', { isVideo: true });

    expect(ingested.fullText).toBe('Video call');
    expect(ingested.structuredPayload).toMatchObject({ outcome: 'unknown' });
  });

  it('names a group voice chat and a scheduled call as what they are', () => {
    expect(ingestCall('c-chat', { callType: VOICE_CHAT, callOutcome: MISSED }).fullText).toBe('Missed voice chat');
    expect(ingestCall('c-sched', { callType: SCHEDULED_CALL, callOutcome: MISSED }).fullText).toBe(
      'Missed scheduled voice call',
    );
    expect(ingestCall('c-sched-ok', { callType: SCHEDULED_CALL, callOutcome: CONNECTED, durationSecs: 60 }).fullText).toBe(
      'Scheduled voice call - 1m',
    );
  });

  it('counts as a conversation turn - a customer who rang is reaching out', () => {
    // The opposite of WhatsApp's plumbing, which is dropped before it is ever
    // persisted. A missed call is the customer asking to be called back, and
    // an agent that cannot see it cannot act on it.
    expect(isConversationalMessage(ingestCall('call-conv', { callOutcome: MISSED }))).toBe(true);
  });
});
