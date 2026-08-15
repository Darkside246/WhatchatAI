import { describe, expect, it } from 'vitest';
import { mapBaileysMessageStatus } from '../src/domain/whatsapp/messageStatus.js';
import { mapBaileysCallStatus, callTypeFromEvent, isTerminalCallStatus } from '../src/domain/whatsapp/callStatus.js';

describe('mapBaileysMessageStatus', () => {
  it('maps every real proto.WebMessageInfo.Status code', () => {
    expect(mapBaileysMessageStatus(0)).toBe('failed');
    expect(mapBaileysMessageStatus(1)).toBe('pending');
    expect(mapBaileysMessageStatus(2)).toBe('sent');
    expect(mapBaileysMessageStatus(3)).toBe('delivered');
    expect(mapBaileysMessageStatus(4)).toBe('read');
    expect(mapBaileysMessageStatus(5)).toBe('played');
  });

  it('returns null for updates with no real status (e.g. a reaction/edit), never a fabricated one', () => {
    expect(mapBaileysMessageStatus(undefined)).toBeNull();
    expect(mapBaileysMessageStatus(null)).toBeNull();
  });
});

describe('mapBaileysCallStatus', () => {
  it('maps user-meaningful call transitions', () => {
    expect(mapBaileysCallStatus('offer')).toBe('offer');
    expect(mapBaileysCallStatus('ringing')).toBe('ringing');
    expect(mapBaileysCallStatus('preaccept')).toBe('ringing');
    expect(mapBaileysCallStatus('accept')).toBe('accepted');
    expect(mapBaileysCallStatus('reject')).toBe('rejected');
    expect(mapBaileysCallStatus('timeout')).toBe('missed');
    expect(mapBaileysCallStatus('terminate')).toBe('ended');
  });

  it('drops internal WebRTC signaling noise instead of fabricating a status', () => {
    expect(mapBaileysCallStatus('transport')).toBeNull();
    expect(mapBaileysCallStatus('relaylatency')).toBeNull();
  });

  it('derives call type from the real isVideo flag', () => {
    expect(callTypeFromEvent(true)).toBe('video');
    expect(callTypeFromEvent(false)).toBe('voice');
    expect(callTypeFromEvent(undefined)).toBe('voice');
  });

  it('identifies terminal statuses for duration computation', () => {
    expect(isTerminalCallStatus('accepted')).toBe(true);
    expect(isTerminalCallStatus('rejected')).toBe(true);
    expect(isTerminalCallStatus('missed')).toBe(true);
    expect(isTerminalCallStatus('ended')).toBe(true);
    expect(isTerminalCallStatus('offer')).toBe(false);
    expect(isTerminalCallStatus('ringing')).toBe(false);
  });
});
