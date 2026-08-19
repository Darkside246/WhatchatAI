import { beforeEach, describe, expect, it } from 'vitest';
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

  it('markAllNotificationsRead clears unread count for exactly that business+user, not other businesses', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    await notifyUser(ownerId, { businessId, type: 'NEW_LEAD', severity: 'info', title: 'A' });
    await notifyUser(ownerId, { businessId, type: 'NEW_LEAD', severity: 'info', title: 'B' });

    const updatedCount = await markAllNotificationsRead(businessId, ownerId);
    expect(updatedCount).toBe(2);

    const inbox = await listNotifications(businessId, ownerId);
    expect(inbox.unreadCount).toBe(0);

    // Sanity: a different business id for the same user id finds nothing (real tenant scoping in the query).
    const otherInbox = await listNotifications(otherBusinessId, ownerId);
    expect(otherInbox.notifications).toHaveLength(0);
  });
});
