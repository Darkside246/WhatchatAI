import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { CreateFollowUpReminderExecutor, AUTONOMOUS_CREATE_REMINDER_ACTION_TYPE } from '../src/services/platform/createFollowUpReminderExecutor.js';
import { NotificationRepository } from '../src/repositories/notificationRepository.js';
import { createTestBusiness, createTestUser } from './helpers.js';
import type { ActionRequest } from '../src/domain/platform/contracts.js';

function fakeAction(businessId: string, payload: Record<string, unknown>): ActionRequest {
  return {
    id: 'action-1',
    tenantId: businessId,
    type: AUTONOMOUS_CREATE_REMINDER_ACTION_TYPE,
    payload,
    requestedBy: { kind: 'AGENT', id: 'autonomous-ops-sweep' },
    riskLevel: 'LOW',
    approval: { required: false, status: 'NOT_REQUIRED' },
    status: 'READY',
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Section 41-42 Phase 1's one real LOW-risk unsupervised action - proves
 * it does exactly one thing (a real, staff-visible internal notification,
 * no external communication) and does it honestly (real payload fields,
 * an honest fallback title, never a fabricated one).
 */
describe('CreateFollowUpReminderExecutor (real Postgres)', () => {
  const executor = new CreateFollowUpReminderExecutor();
  const notifications = new NotificationRepository(pool);
  let businessId: string;
  let userId: string;

  beforeEach(async () => {
    businessId = await createTestBusiness();
    userId = await createTestUser(businessId);
  });

  it('creates a real, staff-visible notification for every active team member', async () => {
    const action = fakeAction(businessId, { title: 'Reply to Jane Doe', summary: 'This conversation is waiting on a human reply.', targetType: 'chat', targetId: randomUUID() });
    const result = await executor.execute(action, { tenantId: businessId, actorId: 'autonomous-ops-sweep' });

    expect(result.status).toBe('SUCCEEDED');
    const list = await notifications.listForUser(businessId, userId, 10);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: 'ASSIGNMENT', title: 'Reply to Jane Doe', body: 'This conversation is waiting on a human reply.' });
  });

  it('falls back to an honest generic title rather than a blank one when payload.title is missing', async () => {
    const action = fakeAction(businessId, {});
    const result = await executor.execute(action, { tenantId: businessId, actorId: 'autonomous-ops-sweep' });
    expect(result.status).toBe('SUCCEEDED');
    const list = await notifications.listForUser(businessId, userId, 10);
    expect(list[0]?.title).toBe('Follow-up needed');
    expect(list[0]?.body).toBeNull();
  });

  it('fails honestly (never throws unhandled) if notifyBusiness itself fails', async () => {
    const action = fakeAction('not-a-real-uuid', { title: 'x' });
    const result = await executor.execute(action, { tenantId: 'not-a-real-uuid', actorId: 'autonomous-ops-sweep' });
    expect(result.status).toBe('FAILED');
    expect(result.error).toBeTruthy();
  });
});
