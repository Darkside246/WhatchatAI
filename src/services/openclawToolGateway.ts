import { BusinessRepository } from '../repositories/businessRepository.js';
import { OpenClawCellRepository } from '../repositories/openclawCellRepository.js';
import { OpenClawToolExecutionRepository } from '../repositories/openclawToolExecutionRepository.js';
import { LeadRepository, type UpdateLeadInput } from '../repositories/leadRepository.js';
import { entityOwnershipRegistry, type EntityOwnershipRegistry } from './entityOwnershipRegistry.js';
import type { LeadStatus } from '../domain/platform/types.js';
import { pool } from '../db/pool.js';

const LEAD_STATUSES: readonly LeadStatus[] = ['NEW', 'QUALIFIED', 'ENGAGED', 'WON', 'LOST'];
const MAX_TEXT_FIELD_LENGTH = 2000;
const RATE_LIMIT_WINDOW_MINUTES = 5;
const RATE_LIMIT_MAX_CALLS = 20;

interface OpenClawToolPolicyEntry {
  entityType: string;
  allowedFields: string[];
}

/**
 * The OpenClaw-specific tool registry. Deliberately its own table, never
 * shared with `aiToolPolicy.ts` (the registry `agentGuard.ts` reads for
 * the live Gemini function-calling path) - see this slice's
 * CHANGELOG_SECURITY.md entry for why full file-level separation was
 * chosen over reusing that shared registry. A regression test asserts
 * `aiToolPolicy.ts`'s own registered-tool list is unchanged by this file.
 */
const OPENCLAW_TOOL_POLICY: Record<string, OpenClawToolPolicyEntry> = {
  update_lead: { entityType: 'lead', allowedFields: ['status', 'stage', 'notes'] },
};

export function getOpenClawToolPolicy(toolName: string): OpenClawToolPolicyEntry | null {
  return OPENCLAW_TOOL_POLICY[toolName] ?? null;
}

export interface OpenClawToolRequest {
  businessId: string;
  /** The cell the caller claims to be - must match the tenant's registered cell exactly, not merely a valid-looking id. */
  cellId: string;
  /** Fencing token: the container generation the caller believes it's running as. A mismatch means a stale/replaced cell instance. */
  cellGeneration: number;
  /** Identifies which real WhatsApp conversation this request originated from - the sole source of the requesting actor's identity. */
  chatId: string;
  toolName: string;
  entityId: string;
  fields: Record<string, unknown>;
  idempotencyKey: string;
}

export type OpenClawToolOutcome =
  | { outcome: 'APPROVED'; replay: boolean; result: unknown }
  | { outcome: 'DENIED'; reason: string };

function validateFieldValue(field: string, value: unknown): string | null {
  if (field === 'status') {
    if (typeof value !== 'string' || !LEAD_STATUSES.includes(value as LeadStatus)) {
      return `"status" must be one of ${LEAD_STATUSES.join(', ')}`;
    }
    return null;
  }
  if (field === 'stage' || field === 'notes') {
    if (value !== null && typeof value !== 'string') return `"${field}" must be a string or null`;
    if (typeof value === 'string' && value.length > MAX_TEXT_FIELD_LENGTH) {
      return `"${field}" exceeds ${MAX_TEXT_FIELD_LENGTH} characters`;
    }
    return null;
  }
  return `unrecognized field "${field}"`;
}

/** Stable-key JSON stringify so {a:1,b:2} and {b:2,a:1} compare equal - two logically identical requests must never look like a parameter mismatch. */
function stableStringify(value: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(value).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = value[key];
    return acc;
  }, {}));
}

/**
 * The WhatchatAI Tool Gateway for OpenClaw: the one path any OpenClaw
 * cell's tool request must pass through before it becomes a real
 * database mutation. OpenClaw can request an action; this gateway alone
 * decides whether it is authorized - the request never carries any field
 * that could itself grant authority (no "claimed identity," no "as the
 * owner" flag), so a prompt-injected claim inside the conversation has no
 * mechanism to reach an approval.
 *
 * Fully isolated from the existing Gemini/Baileys production path: no
 * import of `agentGuard.ts` or `aiToolPolicy.ts`, no shared mutable
 * state. The existing AI orchestration path is completely unaffected by
 * this file's existence.
 */
export class OpenClawToolGateway {
  constructor(
    private readonly businessRepo: BusinessRepository = new BusinessRepository(pool),
    private readonly cellRepo: OpenClawCellRepository = new OpenClawCellRepository(pool),
    private readonly executionRepo: OpenClawToolExecutionRepository = new OpenClawToolExecutionRepository(pool),
    private readonly leadRepo: LeadRepository = new LeadRepository(pool),
    private readonly ownershipRegistry: EntityOwnershipRegistry = entityOwnershipRegistry,
  ) {}

  private async deny(input: OpenClawToolRequest, entityType: string, reason: string): Promise<OpenClawToolOutcome> {
    await this.executionRepo
      .record({
        businessId: input.businessId,
        cellId: input.cellId,
        toolName: input.toolName,
        entityType,
        entityId: input.entityId,
        idempotencyKey: input.idempotencyKey,
        requestedFields: input.fields,
        outcome: 'DENIED',
        denialReason: reason,
      })
      .catch((error) => console.error('[openclawToolGateway] failed to record DENIED execution:', error));
    return { outcome: 'DENIED', reason };
  }

  async invoke(input: OpenClawToolRequest): Promise<OpenClawToolOutcome> {
    const policy = getOpenClawToolPolicy(input.toolName);
    if (!policy) return this.deny(input, 'unknown', `"${input.toolName}" is not a registered OpenClaw tool`);

    // Idempotency first: a retried request with the SAME key and SAME
    // fields replays its original outcome (approved or denied) without
    // re-deciding anything. The same key reused with DIFFERENT fields is
    // a conflict, not a replay - never silently executed against the new
    // fields, and never silently returns the old result either.
    const existing = await this.executionRepo.findByIdempotencyKey(input.businessId, input.toolName, input.idempotencyKey);
    if (existing) {
      if (stableStringify(existing.requestedFields) !== stableStringify(input.fields)) {
        return { outcome: 'DENIED', reason: 'idempotency key already used with different request parameters' };
      }
      if (existing.outcome === 'APPROVED') return { outcome: 'APPROVED', replay: true, result: existing.result };
      return { outcome: 'DENIED', reason: existing.denialReason ?? 'previously denied' };
    }

    const business = await this.businessRepo.findById(input.businessId).catch(() => null);
    if (!business) return this.deny(input, policy.entityType, 'unknown business');

    const cell = await this.cellRepo.findByBusinessId(input.businessId);
    if (!cell || cell.cellId !== input.cellId) {
      return this.deny(input, policy.entityType, 'no matching cell registered for this business');
    }
    if (cell.securityStatus === 'SECURITY_QUARANTINED') {
      return this.deny(input, policy.entityType, 'cell is SECURITY_QUARANTINED - quarantined cells never process new tool requests');
    }
    if (cell.generation !== input.cellGeneration) {
      return this.deny(
        input,
        policy.entityType,
        `stale cell generation (request: ${input.cellGeneration}, current: ${cell.generation}) - fenced out`,
      );
    }

    const rateLimitCount = await this.executionRepo.countRecent(input.businessId, input.toolName, RATE_LIMIT_WINDOW_MINUTES);
    if (rateLimitCount >= RATE_LIMIT_MAX_CALLS) {
      return this.deny(
        input,
        policy.entityType,
        `rate limit exceeded (${rateLimitCount}/${RATE_LIMIT_MAX_CALLS} in ${RATE_LIMIT_WINDOW_MINUTES}m)`,
      );
    }

    const requestedFieldNames = Object.keys(input.fields);
    if (requestedFieldNames.length === 0) return this.deny(input, policy.entityType, 'no fields requested');
    for (const field of requestedFieldNames) {
      if (!policy.allowedFields.includes(field)) {
        return this.deny(input, policy.entityType, `field "${field}" is not writable by "${input.toolName}"`);
      }
      const validationError = validateFieldValue(field, input.fields[field]);
      if (validationError) return this.deny(input, policy.entityType, validationError);
    }

    const ownership = await this.ownershipRegistry.resolve(policy.entityType, input.businessId, input.chatId, input.entityId);
    if (ownership === 'NOT_FOUND') return this.deny(input, policy.entityType, `${policy.entityType} not found for this tenant`);
    if (ownership === 'NOT_AUTHORIZED') {
      return this.deny(input, policy.entityType, `the requesting actor has no authorized relationship to this ${policy.entityType}`);
    }

    const result = await this.execute(input.toolName, input.businessId, input.entityId, input.fields);

    const recorded = await this.executionRepo.record({
      businessId: input.businessId,
      cellId: input.cellId,
      toolName: input.toolName,
      entityType: policy.entityType,
      entityId: input.entityId,
      idempotencyKey: input.idempotencyKey,
      requestedFields: input.fields,
      outcome: 'APPROVED',
      result,
    });

    return { outcome: 'APPROVED', replay: false, result: recorded.result };
  }

  /**
   * The only OpenClaw-invocable mutation that exists today. Deliberately
   * a small explicit switch, not a generic "call a repository method by
   * name" dispatcher - adding a new tool means adding a new case here and
   * a new policy entry above, both reviewable in one diff, never a
   * data-driven path that could be pointed at an unintended method.
   */
  private async execute(toolName: string, businessId: string, leadId: string, fields: Record<string, unknown>): Promise<unknown> {
    if (toolName === 'update_lead') {
      // Re-scoped here as defense in depth, not because the earlier
      // EntityOwnershipRegistry check (invoke(), above) is untrusted - it
      // already proved this lead belongs to businessId. This keeps that
      // boundary enforced at the data-access layer too, so a future tool
      // added to this switch (or any call path that reaches execute()
      // without going through invoke() first) can't silently inherit an
      // unscoped lookup.
      const current = await this.leadRepo.findByIdForBusiness(leadId, businessId);
      if (!current) throw new Error(`lead ${leadId} vanished between ownership check and execution`);

      if (typeof fields.status === 'string') {
        await this.leadRepo.updateStatusForBusiness(businessId, leadId, fields.status as LeadStatus);
      }
      if ('stage' in fields || 'notes' in fields) {
        const input: UpdateLeadInput = {
          stage: 'stage' in fields ? ((fields.stage as string | null) ?? null) : current.stage,
          score: current.score,
          value: current.value,
          nextAction: current.nextAction,
          notes: 'notes' in fields ? ((fields.notes as string | null) ?? null) : current.notes,
        };
        await this.leadRepo.update(businessId, leadId, input);
      }

      return this.leadRepo.findByIdForBusiness(leadId, businessId);
    }
    throw new Error(`"${toolName}" has a policy entry but no execute() handler - refusing rather than silently no-op`);
  }
}

export const openclawToolGateway = new OpenClawToolGateway();
