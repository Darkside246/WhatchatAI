import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WritingTwinRepository } from '../src/repositories/writingTwinRepository.js';
import { learnCaptureService } from '../src/services/learn/learnCaptureService.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

const repository = new WritingTwinRepository(pool);

describe('LearnCaptureService (v1, owner-only capture of real sends into writing_twin_raw_events)', () => {
  let businessId: string;
  let ownerUserId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Capture Business');
    ownerUserId = await createTestUser(businessId); // createTestUser always inserts role='OWNER'
  });

  describe('captureWhatsAppSend', () => {
    it('captures a real raw event when the sender is the OWNER and learning is enabled', async () => {
      await repository.setLearningEnabled(businessId, ownerUserId, true);

      await learnCaptureService.captureWhatsAppSend({
        businessId,
        senderUserId: ownerUserId,
        text: 'Hey, thanks for reaching out! I will get back to you shortly.',
        outboundMessageId: randomUUID(),
      });

      const events = await repository.listUnprocessedRawEvents(businessId, ownerUserId, 'whatsapp');
      expect(events).toHaveLength(1);
      expect(events[0]?.finalText).toContain('thanks for reaching out');
      expect(events[0]?.provenance).toBe('human_authored');
    });

    it('does not capture when learning is disabled (the default)', async () => {
      await learnCaptureService.captureWhatsAppSend({
        businessId,
        senderUserId: ownerUserId,
        text: 'Some real message text.',
        outboundMessageId: randomUUID(),
      });

      expect(await repository.listUnprocessedRawEvents(businessId, ownerUserId, 'whatsapp')).toEqual([]);
    });

    it('does not capture a non-owner member\'s send, even with learning enabled for the owner', async () => {
      const otherUserId = await createTestUser(businessId);
      await pool.query(`UPDATE business_memberships SET role = 'ADMIN' WHERE business_id = $1 AND user_id = $2`, [businessId, otherUserId]);
      await repository.setLearningEnabled(businessId, ownerUserId, true);

      await learnCaptureService.captureWhatsAppSend({
        businessId,
        senderUserId: otherUserId,
        text: 'An ADMIN sent this, not the owner.',
        outboundMessageId: randomUUID(),
      });

      expect(await repository.listUnprocessedRawEvents(businessId, ownerUserId, 'whatsapp')).toEqual([]);
      expect(await repository.listUnprocessedRawEvents(businessId, otherUserId, 'whatsapp')).toEqual([]);
    });

    it('does not capture a media-only send (no real text)', async () => {
      await repository.setLearningEnabled(businessId, ownerUserId, true);

      await learnCaptureService.captureWhatsAppSend({
        businessId,
        senderUserId: ownerUserId,
        text: '   ',
        outboundMessageId: randomUUID(),
      });

      expect(await repository.listUnprocessedRawEvents(businessId, ownerUserId, 'whatsapp')).toEqual([]);
    });

    it('never throws even if the underlying write fails (an invalid businessId)', async () => {
      await expect(
        learnCaptureService.captureWhatsAppSend({
          businessId: 'not-a-valid-uuid',
          senderUserId: ownerUserId,
          text: 'Some text.',
          outboundMessageId: randomUUID(),
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('captureEmailSend', () => {
    it('captures a real raw event when the author is the OWNER and learning is enabled', async () => {
      await repository.setLearningEnabled(businessId, ownerUserId, true);

      await learnCaptureService.captureEmailSend({
        businessId,
        authorUserId: ownerUserId,
        bodyText: 'Dear customer, thank you for your order.',
        emailMessageId: randomUUID(),
      });

      const events = await repository.listUnprocessedRawEvents(businessId, ownerUserId, 'email');
      expect(events).toHaveLength(1);
    });

    it('does not capture when the author is not the owner', async () => {
      const otherUserId = await createTestUser(businessId);
      await pool.query(`UPDATE business_memberships SET role = 'ADMIN' WHERE business_id = $1 AND user_id = $2`, [businessId, otherUserId]);
      await repository.setLearningEnabled(businessId, ownerUserId, true);

      await learnCaptureService.captureEmailSend({
        businessId,
        authorUserId: otherUserId,
        bodyText: 'Written by someone other than the owner.',
        emailMessageId: randomUUID(),
      });

      expect(await repository.listUnprocessedRawEvents(businessId, otherUserId, 'email')).toEqual([]);
    });
  });
});
