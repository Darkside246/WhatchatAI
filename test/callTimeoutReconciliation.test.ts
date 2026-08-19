import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppCallRepository } from '../src/repositories/whatsappCallRepository.js';
import { sweepStaleRingingCalls } from '../src/queue/workers/incomingMessagesWorker.js';
import { subscribeToRealtimeEvents, type RealtimeEvent } from '../src/realtime/pubsub.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('call timeout reconciliation (real Postgres, documented ~60s ring-timeout rule)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('reconciles a call stuck in ringing well past the timeout window to "timeout"', async () => {
    const callRepository = new WhatsAppCallRepository(pool);
    const callId = `STALE-CALL-${Date.now()}`;
    const staleStartedAt = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 minutes ago

    await callRepository.upsertEvent({
      businessId,
      whatsappAccountId: accountId,
      callId,
      remoteJid: '15550004444@s.whatsapp.net',
      remotePhoneNumber: '+15550004444',
      callType: 'voice',
      direction: 'inbound',
      status: 'ringing',
      startedAt: staleStartedAt,
    });

    const events: RealtimeEvent[] = [];
    const unsubscribe = subscribeToRealtimeEvents((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 200));

    await sweepStaleRingingCalls();

    const reconciled = await callRepository.findByCallId(businessId, accountId, callId);
    expect(reconciled?.status).toBe('timeout');
    expect(reconciled?.endedAt).not.toBeNull();
    // Never rang -> never answered -> no fabricated duration.
    expect(reconciled?.durationSeconds).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 200));
    unsubscribe();
    expect(events.some((event) => event.type === 'call.updated')).toBe(true);
  });

  it('leaves a recently-started ringing call alone - it has not actually timed out yet', async () => {
    const callRepository = new WhatsAppCallRepository(pool);
    const callId = `FRESH-CALL-${Date.now()}`;

    await callRepository.upsertEvent({
      businessId,
      whatsappAccountId: accountId,
      callId,
      remoteJid: '15550005555@s.whatsapp.net',
      callType: 'voice',
      direction: 'inbound',
      status: 'ringing',
      startedAt: new Date().toISOString(),
    });

    await sweepStaleRingingCalls();

    const stillRinging = await callRepository.findByCallId(businessId, accountId, callId);
    expect(stillRinging?.status).toBe('ringing');
  });

  it('never touches a call that already reached a real terminal state', async () => {
    const callRepository = new WhatsAppCallRepository(pool);
    const callId = `ENDED-CALL-${Date.now()}`;
    const staleStartedAt = new Date(Date.now() - 5 * 60_000).toISOString();

    await callRepository.upsertEvent({
      businessId,
      whatsappAccountId: accountId,
      callId,
      remoteJid: '15550006666@s.whatsapp.net',
      callType: 'voice',
      direction: 'inbound',
      status: 'ended',
      startedAt: staleStartedAt,
      acceptedAt: staleStartedAt,
      endedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      durationSeconds: 45,
    });

    await sweepStaleRingingCalls();

    const untouched = await callRepository.findByCallId(businessId, accountId, callId);
    expect(untouched?.status).toBe('ended');
    expect(untouched?.durationSeconds).toBe(45);
  });
});
