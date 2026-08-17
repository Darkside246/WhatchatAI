import { pool } from '../db/pool.js';
import {
  NotificationRepository,
  type NotificationRecord,
  type NotificationType,
  type NotificationSeverity,
} from '../repositories/notificationRepository.js';
import { BusinessMembershipRepository } from '../repositories/businessMembershipRepository.js';
import { publishRealtimeEvent } from '../realtime/pubsub.js';

const notificationRepository = new NotificationRepository(pool);
const membershipRepository = new BusinessMembershipRepository(pool);

export class NotificationNotFoundError extends Error {}

export interface NotifyInput {
  businessId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body?: string | null;
  targetType?: string | null;
  targetId?: string | null;
}

/** Targets exactly one user - the real case for anything scoped to who did the action. */
export async function notifyUser(userId: string, input: NotifyInput): Promise<NotificationRecord> {
  const notification = await notificationRepository.create({ ...input, userId });
  await publishRealtimeEvent({
    type: 'notification.created',
    businessId: input.businessId,
    userId,
    notificationId: notification.id,
  });
  return notification;
}

/**
 * Fans a business-wide event out to a real, separate row per active
 * member - never a single shared row - so each teammate's read/dismiss
 * state is genuinely their own, not accidentally shared.
 */
export async function notifyBusiness(input: NotifyInput): Promise<NotificationRecord[]> {
  const memberships = await membershipRepository.listForBusiness(input.businessId);
  const activeMembers = memberships.filter((membership) => membership.status === 'active');

  const created: NotificationRecord[] = [];
  for (const membership of activeMembers) {
    created.push(await notifyUser(membership.userId, input));
  }
  return created;
}

export async function listNotifications(businessId: string, userId: string, limit = 50) {
  const [notifications, unreadCount] = await Promise.all([
    notificationRepository.listForUser(businessId, userId, limit),
    notificationRepository.countUnread(businessId, userId),
  ]);
  return { notifications, unreadCount };
}

async function requireOwnNotification(userId: string, notificationId: string): Promise<NotificationRecord> {
  const notification = await notificationRepository.findById(notificationId);
  if (!notification || notification.userId !== userId) throw new NotificationNotFoundError('Notification not found.');
  return notification;
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<NotificationRecord> {
  await requireOwnNotification(userId, notificationId);
  const updated = await notificationRepository.markRead(notificationId);
  if (!updated) throw new NotificationNotFoundError('Notification not found.');
  return updated;
}

export async function markNotificationDismissed(userId: string, notificationId: string): Promise<NotificationRecord> {
  await requireOwnNotification(userId, notificationId);
  const updated = await notificationRepository.markDismissed(notificationId);
  if (!updated) throw new NotificationNotFoundError('Notification not found.');
  return updated;
}

export async function markAllNotificationsRead(businessId: string, userId: string): Promise<number> {
  return notificationRepository.markAllRead(businessId, userId);
}

export function isNotificationNotFoundError(error: unknown): error is NotificationNotFoundError {
  return error instanceof NotificationNotFoundError;
}
