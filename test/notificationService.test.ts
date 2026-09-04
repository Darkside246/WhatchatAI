import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { createMember } from '../src/services/workspaceMemberService.js';
import {
  notifyUser,
  notifyBusiness,
  listNotifications,
  markNotificationRead,
  markNotificationDismissed,
  markAllNotificationsRead,
  isNotificationNotFoundError,
} from '../src/services/notificationService.js';
import { NotificationRepository } from '../src/repositories/notificationRepository.js';
import { resetDatabase, createTestBusiness } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

describe('notificationService (real, per-user, never a shared broadcast row)', () => {
  let businessId: string;
  let ownerId: string;
  let agentId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    ownerId = owner.user.id;
    const created = await createMember(businessId, ownerId, { email: 'agent@example.com', displayName: 'Agent', role: 'AGENT' });
    agentId = created.member.userId;
  });

  it('notifyUser creates a real row that shows up in that user\'s list with an accurate unread count', async () => {
    await notifyUser(ownerId, { businessId, type: 'NEW_LEAD', severity: 'info', title: 'New lead created' });

    const { notifications, unreadCount } = await listNotifications(businessId, ownerId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toBe('New lead created');
    expect(unreadCount).toBe(1);
  });

  it('notifyBusiness fans out one real row per active member - never a single shared row', async () => {
    await notifyBusiness({ businessId, type: 'HUMAN_HANDOFF', severity: 'critical', title: 'A conversation needs a human' });

    const ownerInbox = await listNotifications(businessId, ownerId);
    const agentInbox = await listNotifications(businessId, agentId);
    expect(ownerInbox.notifications).toHaveLength(1);
    expect(agentInbox.notifications).toHaveLength(1);
    expect(ownerInbox.notifications[0]?.id).not.toBe(agentInbox.notifications[0]?.id);

    // Reading one member's copy must never affect the other's - proves these are real separate rows.
    await markNotificationRead(ownerId, ownerInbox.notifications[0]!.id);
    const agentInboxAfter = await listNotifications(businessId, agentId);
    expect(agentInboxAfter.unreadCount).toBe(1);
  });

  it('marking read is idempotent and only the owning user can do it', async () => {
    const notification = await notifyUser(ownerId, { businessId, type: 'SYSTEM', severity: 'info', title: 'Test' });

    const first = await markNotificationRead(ownerId, notification.id);
    expect(first.readAt).not.toBeNull();
    const second = await markNotificationRead(ownerId, notification.id);
    expect(second.readAt).toBe(first.readAt);

    await expect(markNotificationRead(agentId, notification.id)).rejects.toThrow();
    try {
      await markNotificationRead(agentId, notification.id);
    } catch (error) {
      expect(isNotificationNotFoundError(error)).toBe(true);
    }
  });

  it('dismissing removes a notification from the active list without touching another user\'s copy', async () => {
    await notifyBusiness({ businessId, type: 'NEW_LEAD', severity: 'info', title: 'Test' });
    const ownerInbox = await listNotifications(businessId, ownerId);
    await markNotificationDismissed(ownerId, ownerInbox.notifications[0]!.id);

    const ownerAfter = await listNotifications(businessId, ownerId);
    expect(ownerAfter.notifications).toHaveLength(0);
    const agentAfter = await listNotifications(businessId, agentId);
    expect(agentAfter.notifications).toHaveLength(1);
  });

  it('markAllNotificationsRead clears the whole visible inbox (not just the unread count) for exactly that business+user', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    await notifyUser(ownerId, { businessId, type: 'NEW_LEAD', severity: 'info', title: 'A' });
    const alreadyRead = await notifyUser(ownerId, { businessId, type: 'NEW_LEAD', severity: 'info', title: 'B' });
    await markNotificationRead(ownerId, alreadyRead.id); // an already-read row must be cleared too, not just unread ones

    const updatedCount = await markAllNotificationsRead(businessId, ownerId);
    expect(updatedCount).toBe(2);

    const inbox = await listNotifications(businessId, ownerId);
    expect(inbox.unreadCount).toBe(0);
    expect(inbox.notifications).toHaveLength(0); // gone from the visible list, not merely marked read

    // Sanity: a different business id for the same user id finds nothing (real tenant scoping in the query).
    const otherInbox = await listNotifications(otherBusinessId, ownerId);
    expect(otherInbox.notifications).toHaveLength(0);
  });

  it('markAllNotificationsRead does not delete the underlying rows - they remain real history, just no longer listed', async () => {
    const notification = await notifyUser(ownerId, { businessId, type: 'NEW_LEAD', severity: 'info', title: 'Kept as history' });

    await markAllNotificationsRead(businessId, ownerId);

    const { rows } = await pool.query('SELECT read_at, dismissed_at FROM notifications WHERE id = $1', [notification.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].read_at).not.toBeNull();
    expect(rows[0].dismissed_at).not.toBeNull();
  });

  describe('NotificationRepository.existsForBusinessSince (Section 34-40\'s once-per-month dedup)', () => {
    it('is false when no notification of that type has ever fired for this business', async () => {
      const repo = new NotificationRepository(pool);
      const sinceIso = new Date(Date.now() - 60_000).toISOString();
      expect(await repo.existsForBusinessSince(businessId, 'AI_BUDGET_EXCEEDED', sinceIso)).toBe(false);
    });

    it('is true once a real notification of that type exists since the window start, across any member\'s row', async () => {
      const repo = new NotificationRepository(pool);
      await notifyBusiness({ businessId, type: 'AI_BUDGET_EXCEEDED', severity: 'warning', title: 'Budget exhausted' });

      const sinceIso = new Date(Date.now() - 60_000).toISOString();
      expect(await repo.existsForBusinessSince(businessId, 'AI_BUDGET_EXCEEDED', sinceIso)).toBe(true);
      // Checked as ownerId's own inbox above via notifyBusiness's fan-out; existsForBusinessSince doesn't need a userId at all.
      expect(await repo.existsForBusinessSince(businessId, 'AI_TOKENS_ADDED', sinceIso)).toBe(false);
    });

    it('ignores a notification from before the window start', async () => {
      const repo = new NotificationRepository(pool);
      await notifyBusiness({ businessId, type: 'AI_BUDGET_EXCEEDED', severity: 'warning', title: 'Old budget notice' });
      await pool.query(`UPDATE notifications SET created_at = now() - interval '45 days' WHERE business_id = $1`, [businessId]);

      const sinceIso = new Date(Date.now() - 60_000).toISOString();
      expect(await repo.existsForBusinessSince(businessId, 'AI_BUDGET_EXCEEDED', sinceIso)).toBe(false);
    });

    it('never leaks another business\'s notification (tenant isolation)', async () => {
      const { NotificationRepository } = await import('../src/repositories/notificationRepository.js');
      const otherBusinessId = await createTestBusiness('Other Business');
      await notifyBusiness({ businessId: otherBusinessId, type: 'AI_BUDGET_EXCEEDED', severity: 'warning', title: 'Other business budget notice' });

      const repo = new NotificationRepository(pool);
      const sinceIso = new Date(Date.now() - 60_000).toISOString();
      expect(await repo.existsForBusinessSince(businessId, 'AI_BUDGET_EXCEEDED', sinceIso)).toBe(false);
    });
  });
});
