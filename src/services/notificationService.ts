import { pool } from '../db/pool.js';
import {
  NotificationRepository,
  type NotificationRecord,
  type NotificationType,
  type NotificationSeverity,
} from '../repositories/notificationRepository.js';
import { BusinessMembershipRepository } from '../repositories/businessMembershipRepository.js';
import { BusinessRepository } from '../repositories/businessRepository.js';
import { publishRealtimeEvent } from '../realtime/pubsub.js';

const notificationRepository = new NotificationRepository(pool);
const membershipRepository = new BusinessMembershipRepository(pool);
const businessRepository = new BusinessRepository(pool);

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
  /**
   * Channels are broadcast feeds, not conversations: nobody is waiting on a
   * reply and there is nothing to action, so by default they never raise a
   * notification - letting them would bury the things that genuinely need a
   * person under a feed nobody asked to be interrupted by. A business that
   * does want them turns it on in Settings (migration 1018).
   *
   * Enforced here, at the one place notifications are actually created,
   * rather than at each call site - so a future caller cannot forget it.
   */
  if (input.targetType === 'channel') {
    const business = await businessRepository.findById(input.businessId);
    if (!business?.channelNotificationsEnabled) return [];
  }

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
  const notification = await notificationRepository.findByIdForUser(notificationId, userId);
  if (!notification) throw new NotificationNotFoundError('Notification not found.');
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

/** Clears the whole visible inbox (see NotificationRepository.dismissAllForUser) - every row stays in Postgres as real history, just no longer listed. */
export async function markAllNotificationsRead(businessId: string, userId: string): Promise<number> {
  return notificationRepository.dismissAllForUser(businessId, userId);
}

/**
 * Clears this user's outstanding notifications about one conversation,
 * called when they actually open it. Opening the conversation is reading
 * the notification - keeping a red dot on a chat the operator is looking at
 * right now is just noise they have to clear by hand.
 *
 * Returns how many were cleared so the caller can skip the realtime nudge
 * when there was nothing to clear (the common case, on every chat open).
 */
export async function dismissNotificationsForChat(
  businessId: string,
  userId: string,
  chatId: string,
): Promise<number> {
  return notificationRepository.dismissForTarget(businessId, userId, 'chat', chatId);
}

export function isNotificationNotFoundError(error: unknown): error is NotificationNotFoundError {
  return error instanceof NotificationNotFoundError;
}
