import { pool } from '../../db/pool.js';
import type { Queryable } from '../../repositories/types.js';
import { SecurityAuditLogRepository, type SecurityEventType } from '../../repositories/securityAuditLogRepository.js';
import { evaluateHeuristicShield } from './heuristicShield.js';
import { evaluateAiSentinel } from './aiSentinel.js';

export interface SentinelInput {
  businessId: string;
  whatsappAccountId: string;
  senderJid: string;
  textContent: string | null;
  mimetype: string | null;
  fileName: string | null;
}

export interface SentinelVerdict {
  allowed: boolean;
  eventType: SecurityEventType;
  reason: string | null;
}

/**
 * Tiered Security Sentinel: Stage 1 (local heuristics + Redis rate limit, <5ms)
 * gates everything; only messages that pass Stage 1 and carry text reach
 * Stage 2 (Gemini Flash prompt-injection/jailbreak/social-engineering check,
 * <400ms target). Every verdict is written to security_audit_logs -
 * rawMetadata never carries message text, contact names, or phone numbers,
 * only structural diagnostics (see SecurityAuditLogRepository).
 */
export async function runSentinel(input: SentinelInput, db: Queryable = pool): Promise<SentinelVerdict> {
  const auditLog = new SecurityAuditLogRepository(db);
  const { businessId, whatsappAccountId } = input;

  const heuristic = await evaluateHeuristicShield({
    senderJid: input.senderJid,
    textContent: input.textContent,
    mimetype: input.mimetype,
    fileName: input.fileName,
  });

  if (!heuristic.safe) {
    await auditLog.record({
      businessId,
      whatsappAccountId,
      eventType: 'sentinel_heuristic_block',
      severity: 'warning',
      reason: heuristic.reason,
      rawMetadata: { stage: 'heuristic' },
    });
    return { allowed: false, eventType: 'sentinel_heuristic_block', reason: heuristic.reason };
  }

  if (!input.textContent) {
    await auditLog.record({
      businessId,
      whatsappAccountId,
      eventType: 'sentinel_pass',
      severity: 'info',
      reason: 'Heuristic shield only - no text content for the AI stage',
      rawMetadata: { stage: 'heuristic' },
    });
    return { allowed: true, eventType: 'sentinel_pass', reason: null };
  }

  const ai = await evaluateAiSentinel(input.textContent);

  if (ai.status === 'unsafe') {
    await auditLog.record({
      businessId,
      whatsappAccountId,
      eventType: 'sentinel_ai_block',
      severity: 'critical',
      reason: ai.reason,
      rawMetadata: { stage: 'ai' },
    });
    return { allowed: false, eventType: 'sentinel_ai_block', reason: ai.reason };
  }

  if (ai.status === 'unavailable') {
    // Fails OPEN at Stage 2 only: a missing/failed AI check is honestly logged,
    // never turned into a fabricated safe verdict. Stage 1 remains the enforced gate.
    await auditLog.record({
      businessId,
      whatsappAccountId,
      eventType: 'sentinel_ai_unavailable',
      severity: 'warning',
      reason: ai.reason,
      rawMetadata: { stage: 'ai' },
    });
    return { allowed: true, eventType: 'sentinel_ai_unavailable', reason: ai.reason };
  }

  await auditLog.record({
    businessId,
    whatsappAccountId,
    eventType: 'sentinel_pass',
    severity: 'info',
    reason: ai.reason,
    rawMetadata: { stage: 'ai' },
  });
  return { allowed: true, eventType: 'sentinel_pass', reason: ai.reason };
}
