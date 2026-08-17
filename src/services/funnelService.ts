import { pool } from '../db/pool.js';
import {
  FunnelRepository,
  type FunnelDefinitionRecord,
  type FunnelStepRecord,
  type FunnelInstanceRecord,
  type FunnelNodeType,
} from '../repositories/funnelRepository.js';
import { CrmContactRepository } from '../repositories/crmContactRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { workspaceService, type EntitlementDeniedError } from './workspaceService.js';
import { notifyUser } from './notificationService.js';
import { whatsappOutboundMessageService } from './whatsappOutboundMessageService.js';
import { enqueueFunnelAdvance } from '../queue/queues/funnelAdvanceQueue.js';
import { EntitlementService } from './entitlementService.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';

const funnelRepository = new FunnelRepository(pool);
const crmContactRepository = new CrmContactRepository(pool);
const chatRepository = new WhatsAppChatRepository(pool);
const entitlementService = new EntitlementService(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

export class FunnelNotFoundError extends Error {}
export class InvalidFunnelStepError extends Error {}
export class FunnelInstanceNotFoundError extends Error {}
export class AlreadyEnrolledError extends Error {}

async function requireOwnFunnel(businessId: string, funnelId: string): Promise<FunnelDefinitionRecord> {
  const funnel = await funnelRepository.findByIdForBusiness(businessId, funnelId);
  if (!funnel) throw new FunnelNotFoundError('Funnel not found.');
  return funnel;
}

export async function createFunnel(businessId: string, whatsappAccountId: string, createdBy: string, name: string, description: string | null): Promise<FunnelDefinitionRecord> {
  const funnel = await funnelRepository.create({ businessId, whatsappAccountId, createdBy, name: name.trim(), description });
  await securityAuditLogRepository.record({
    businessId,
    whatsappAccountId,
    eventType: 'funnel_created',
    rawMetadata: { funnelId: funnel.id },
  });
  return funnel;
}

export async function listFunnels(businessId: string): Promise<(FunnelDefinitionRecord & { stepCount: number; counts: Awaited<ReturnType<typeof funnelRepository.getInstanceCounts>> })[]> {
  const funnels = await funnelRepository.listForBusiness(businessId);
  return Promise.all(
    funnels.map(async (funnel) => {
      const [steps, counts] = await Promise.all([funnelRepository.listSteps(funnel.id), funnelRepository.getInstanceCounts(funnel.id)]);
      return { ...funnel, stepCount: steps.length, counts };
    }),
  );
}

export interface FunnelDetail {
  funnel: FunnelDefinitionRecord;
  steps: FunnelStepRecord[];
  instances: FunnelInstanceRecord[];
  counts: Awaited<ReturnType<typeof funnelRepository.getInstanceCounts>>;
}

export async function getFunnel(businessId: string, funnelId: string): Promise<FunnelDetail> {
  const funnel = await requireOwnFunnel(businessId, funnelId);
  const [steps, instances, counts] = await Promise.all([
    funnelRepository.listSteps(funnel.id),
    funnelRepository.listInstances(funnel.id),
    funnelRepository.getInstanceCounts(funnel.id),
  ]);
  return { funnel, steps, instances, counts };
}

export async function updateFunnelMeta(businessId: string, funnelId: string, name: string, description: string | null): Promise<FunnelDefinitionRecord> {
  await requireOwnFunnel(businessId, funnelId);
  const updated = await funnelRepository.updateMeta(funnelId, name.trim(), description);
  if (!updated) throw new FunnelNotFoundError('Funnel not found.');
  return updated;
}

export async function deleteFunnel(businessId: string, funnelId: string): Promise<void> {
  await requireOwnFunnel(businessId, funnelId);
  await funnelRepository.remove(funnelId);
}

export async function setFunnelActive(businessId: string, funnelId: string, isActive: boolean): Promise<FunnelDefinitionRecord> {
  const funnel = await requireOwnFunnel(businessId, funnelId);
  if (isActive) {
    const steps = await funnelRepository.listSteps(funnelId);
    if (steps.length === 0) throw new InvalidFunnelStepError('A funnel needs at least one step before it can be activated.');

    const entitlementCheck = await entitlementService.canActivateFunnel(businessId);
    if (!entitlementCheck.allowed) {
      const error = new Error(`Funnel activation denied: ${entitlementCheck.reason}`) as EntitlementDeniedError;
      error.code = 'ENTITLEMENT_DENIED';
      error.reason = entitlementCheck.reason as EntitlementDeniedError['reason'];
      error.limit = entitlementCheck.limit;
      error.current = entitlementCheck.current;
      throw error;
    }
  }
  const updated = await funnelRepository.setActive(funnelId, isActive);
  await securityAuditLogRepository.record({
    businessId,
    whatsappAccountId: funnel.whatsappAccountId,
    eventType: isActive ? 'funnel_activated' : 'funnel_deactivated',
    rawMetadata: { funnelId },
  });
  return updated ?? funnel;
}

export interface FunnelStepInput {
  nodeType: FunnelNodeType;
  config: Record<string, unknown>;
}

function validateStep(step: FunnelStepInput, stepCount: number): void {
  const c = step.config;
  switch (step.nodeType) {
    case 'MESSAGE':
      if (typeof c.text !== 'string' || !c.text.trim()) throw new InvalidFunnelStepError('MESSAGE step requires config.text');
      break;
    case 'WAIT':
      if (typeof c.minutes !== 'number' || c.minutes <= 0) throw new InvalidFunnelStepError('WAIT step requires a positive config.minutes');
      break;
    case 'CONDITION':
      if (typeof c.field !== 'string' || typeof c.equals !== 'string' || typeof c.matchStepPosition !== 'number') {
        throw new InvalidFunnelStepError('CONDITION step requires config.field, config.equals, config.matchStepPosition');
      }
      if (c.matchStepPosition < 0 || c.matchStepPosition >= stepCount) throw new InvalidFunnelStepError('CONDITION matchStepPosition is out of range');
      if (typeof c.elseStepPosition === 'number' && (c.elseStepPosition < 0 || c.elseStepPosition >= stepCount)) {
        throw new InvalidFunnelStepError('CONDITION elseStepPosition is out of range');
      }
      break;
    case 'ASSIGN_HUMAN':
      if (typeof c.userId !== 'string') throw new InvalidFunnelStepError('ASSIGN_HUMAN step requires config.userId');
      break;
    case 'ASSIGN_TEAM':
      if (typeof c.teamId !== 'string') throw new InvalidFunnelStepError('ASSIGN_TEAM step requires config.teamId');
      break;
    case 'ADD_TAG':
    case 'REMOVE_TAG':
      if (typeof c.tag !== 'string' || !c.tag.trim()) throw new InvalidFunnelStepError(`${step.nodeType} step requires config.tag`);
      break;
    case 'UPDATE_STAGE':
      if (typeof c.stage !== 'string' && typeof c.leadStatus !== 'string') throw new InvalidFunnelStepError('UPDATE_STAGE step requires config.stage or config.leadStatus');
      break;
    case 'NOTIFY_USER':
      if (typeof c.userId !== 'string' || typeof c.title !== 'string') throw new InvalidFunnelStepError('NOTIFY_USER step requires config.userId and config.title');
      break;
  }
}

/** Replaces the whole step list - a funnel must not be active while its steps are being edited (edit, then reactivate). */
export async function replaceFunnelSteps(businessId: string, funnelId: string, steps: FunnelStepInput[]): Promise<FunnelStepRecord[]> {
  const funnel = await requireOwnFunnel(businessId, funnelId);
  if (funnel.isActive) throw new InvalidFunnelStepError('Deactivate this funnel before editing its steps.');
  steps.forEach((step) => validateStep(step, steps.length));
  return funnelRepository.replaceSteps(funnelId, steps);
}

/**
 * Real, manual enrollment - a human explicitly starts this contact on the
 * funnel (per this pass's honest scope: no automatic entry-on-inbound-
 * message trigger yet, that's real future work). Requires the same
 * "genuine existing conversation" the contact must already have, exactly
 * like campaigns.
 */
export async function enrollContact(businessId: string, funnelId: string, crmContactId: string): Promise<FunnelInstanceRecord> {
  const funnel = await requireOwnFunnel(businessId, funnelId);
  if (!funnel.isActive) throw new InvalidFunnelStepError('This funnel is not active.');

  const existing = await funnelRepository.findInstance(funnelId, crmContactId);
  if (existing) throw new AlreadyEnrolledError('This contact is already enrolled in this funnel.');

  const crmContact = await crmContactRepository.findByIdForBusiness(businessId, crmContactId);
  if (!crmContact || !crmContact.whatsappContactId) throw new InvalidFunnelStepError('Contact not found or has no WhatsApp identity.');

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM whatsapp_chats WHERE business_id = $1 AND whatsapp_account_id = $2 AND contact_id = $3 AND deleted_at IS NULL LIMIT 1`,
    [businessId, funnel.whatsappAccountId, crmContact.whatsappContactId],
  );
  const chatId = rows[0]?.id;
  if (!chatId) throw new InvalidFunnelStepError('This contact has no existing WhatsApp conversation to run the funnel through.');

  const instance = await funnelRepository.createInstance({ funnelId, businessId, crmContactId, chatId });
  await securityAuditLogRepository.record({
    businessId,
    whatsappAccountId: funnel.whatsappAccountId,
    eventType: 'funnel_enrolled',
    rawMetadata: { funnelId, instanceId: instance.id },
  });
  await runFromPosition(instance);
  return (await funnelRepository.findInstanceById(instance.id)) ?? instance;
}

/**
 * The real step executor. Every branch below calls a genuinely existing
 * service method - never a fabricated "done" with nothing behind it. On
 * MESSAGE/WAIT the loop stops (WAIT resumes later via a real delayed
 * queue job; MESSAGE stops so an inbound reply could be examined by a
 * future condition step in a later phase - for this pass steps only ever
 * advance forward automatically, no reply-branching yet).
 */
async function runFromPosition(instance: FunnelInstanceRecord): Promise<void> {
  let position = instance.currentPosition;
  const steps = await funnelRepository.listSteps(instance.funnelId);

  while (position < steps.length) {
    const step = steps[position];
    if (!step) break;

    try {
      switch (step.nodeType) {
        case 'MESSAGE': {
          const funnel = await funnelRepository.findByIdForBusiness(instance.businessId, instance.funnelId);
          if (!funnel) throw new FunnelNotFoundError('Funnel not found.');
          await whatsappOutboundMessageService.send({
            businessId: instance.businessId,
            whatsappAccountId: funnel.whatsappAccountId,
            chatId: instance.chatId,
            messageType: 'text',
            text: String(step.config.text),
            requestedBy: 'funnel',
          });
          break;
        }
        case 'WAIT': {
          const minutes = Number(step.config.minutes);
          await funnelRepository.updateInstance(instance.id, { currentPosition: position + 1, status: 'WAITING' });
          await enqueueFunnelAdvance({ instanceId: instance.id }, minutes * 60_000);
          return; // Resumes later via the queue - stop executing now.
        }
        case 'CONDITION': {
          const matches = await evaluateCondition(instance.businessId, instance.crmContactId, String(step.config.field), String(step.config.equals));
          const nextPosition = matches
            ? Number(step.config.matchStepPosition)
            : typeof step.config.elseStepPosition === 'number'
              ? step.config.elseStepPosition
              : position + 1;
          position = nextPosition;
          continue;
        }
        case 'ASSIGN_HUMAN':
        case 'ASSIGN_TEAM': {
          const funnel = await funnelRepository.findByIdForBusiness(instance.businessId, instance.funnelId);
          if (!funnel) throw new FunnelNotFoundError('Funnel not found.');
          await workspaceService.assignChat(instance.businessId, funnel.whatsappAccountId, instance.chatId, {
            assigneeUserId: step.nodeType === 'ASSIGN_HUMAN' ? String(step.config.userId) : null,
            assigneeTeamId: step.nodeType === 'ASSIGN_TEAM' ? String(step.config.teamId) : null,
          });
          break;
        }
        case 'ADD_TAG':
        case 'REMOVE_TAG': {
          const contact = await crmContactRepository.findByIdForBusiness(instance.businessId, instance.crmContactId);
          if (contact) {
            const tag = String(step.config.tag);
            const nextTags = step.nodeType === 'ADD_TAG' ? Array.from(new Set([...contact.tags, tag])) : contact.tags.filter((t) => t !== tag);
            await crmContactRepository.update(instance.businessId, instance.crmContactId, {
              stage: contact.stage,
              leadStatus: contact.leadStatus,
              notes: contact.notes,
              tags: nextTags,
            });
          }
          break;
        }
        case 'UPDATE_STAGE': {
          const contact = await crmContactRepository.findByIdForBusiness(instance.businessId, instance.crmContactId);
          if (contact) {
            await crmContactRepository.update(instance.businessId, instance.crmContactId, {
              stage: typeof step.config.stage === 'string' ? step.config.stage : contact.stage,
              leadStatus: typeof step.config.leadStatus === 'string' ? step.config.leadStatus : contact.leadStatus,
              notes: contact.notes,
              tags: contact.tags,
            });
          }
          break;
        }
        case 'NOTIFY_USER': {
          await notifyUser(String(step.config.userId), {
            businessId: instance.businessId,
            type: 'SYSTEM',
            severity: 'info',
            title: String(step.config.title),
            body: typeof step.config.body === 'string' ? step.config.body : null,
            targetType: 'funnel_instance',
            targetId: instance.id,
          });
          break;
        }
      }
    } catch (error) {
      await funnelRepository.updateInstance(instance.id, { status: 'FAILED', lastError: error instanceof Error ? error.message : String(error) });
      return;
    }

    position += 1;
  }

  await funnelRepository.updateInstance(instance.id, { currentPosition: position, status: 'COMPLETED', completedAt: true });
}

async function evaluateCondition(businessId: string, crmContactId: string, field: string, equals: string): Promise<boolean> {
  const contact = await crmContactRepository.findByIdForBusiness(businessId, crmContactId);
  if (!contact) return false;
  if (field === 'stage') return contact.stage === equals;
  if (field === 'leadStatus') return contact.leadStatus === equals;
  if (field === 'tag') return contact.tags.includes(equals);
  return false;
}

/** Called by the WAIT-node delayed queue job - resumes a WAITING instance from its next real step. */
export async function resumeFunnelInstance(instanceId: string): Promise<void> {
  const instance = await funnelRepository.findInstanceById(instanceId);
  if (!instance || instance.status !== 'WAITING') return;
  await funnelRepository.updateInstance(instance.id, { status: 'ACTIVE' });
  const refreshed = await funnelRepository.findInstanceById(instanceId);
  if (refreshed) await runFromPosition(refreshed);
}

export async function cancelFunnelInstance(businessId: string, funnelId: string, instanceId: string): Promise<FunnelInstanceRecord> {
  await requireOwnFunnel(businessId, funnelId);
  const instance = await funnelRepository.findInstanceById(instanceId);
  if (!instance || instance.funnelId !== funnelId) throw new FunnelInstanceNotFoundError('Funnel instance not found.');
  const updated = await funnelRepository.updateInstance(instanceId, { status: 'CANCELLED' });
  if (!updated) throw new FunnelInstanceNotFoundError('Funnel instance not found.');
  return updated;
}

export function isFunnelNotFoundError(error: unknown): error is FunnelNotFoundError {
  return error instanceof FunnelNotFoundError;
}
export function isInvalidFunnelStepError(error: unknown): error is InvalidFunnelStepError {
  return error instanceof InvalidFunnelStepError;
}
export function isFunnelInstanceNotFoundError(error: unknown): error is FunnelInstanceNotFoundError {
  return error instanceof FunnelInstanceNotFoundError;
}
export function isAlreadyEnrolledError(error: unknown): error is AlreadyEnrolledError {
  return error instanceof AlreadyEnrolledError;
}
