import type { ActionRequest } from '../../domain/platform/contracts.js';
import type { ActionExecutionContext, ActionExecutor } from './actionBusService.js';
import { notifyBusiness } from '../notificationService.js';

export const AUTONOMOUS_CREATE_REMINDER_ACTION_TYPE = 'autonomous.create_reminder';

/**
 * Section 41-42 Phase 1's one real, genuinely LOW-risk unsupervised
 * action - the only new executor this phase adds. No external
 * communication, no money, fully reversible (a notification can be
 * dismissed) - a real internal task/reminder surfaced to every active
 * team member via the existing notification system (notifyBusiness),
 * reusing the 'ASSIGNMENT' type it already defines rather than adding a
 * new one for a single new caller.
 */
export class CreateFollowUpReminderExecutor implements ActionExecutor {
  readonly actionType = AUTONOMOUS_CREATE_REMINDER_ACTION_TYPE;

  async execute(action: ActionRequest, context: ActionExecutionContext): Promise<{ status: 'SUCCEEDED' | 'FAILED'; result?: unknown; error?: string }> {
    const payload = action.payload as { title?: unknown; summary?: unknown; targetType?: unknown; targetId?: unknown };
    const title = typeof payload.title === 'string' && payload.title.length > 0 ? payload.title : 'Follow-up needed';
    const summary = typeof payload.summary === 'string' ? payload.summary : null;
    const targetType = typeof payload.targetType === 'string' ? payload.targetType : null;
    const targetId = typeof payload.targetId === 'string' ? payload.targetId : null;

    try {
      const notifyInput: Parameters<typeof notifyBusiness>[0] = { businessId: context.tenantId, type: 'ASSIGNMENT', severity: 'info', title };
      if (summary !== null) notifyInput.body = summary;
      if (targetType !== null) notifyInput.targetType = targetType;
      if (targetId !== null) notifyInput.targetId = targetId;
      const created = await notifyBusiness(notifyInput);
      return { status: 'SUCCEEDED', result: { notified: created.length, title } };
    } catch (error) {
      return { status: 'FAILED', error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export const createFollowUpReminderExecutor = new CreateFollowUpReminderExecutor();
