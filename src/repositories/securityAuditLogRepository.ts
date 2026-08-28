import type { Queryable } from './types.js';

export type SecurityEventType =
  | 'sentinel_heuristic_block'
  | 'sentinel_ai_block'
  | 'sentinel_ai_unavailable'
  | 'sentinel_pass'
  | 'lock_setup'
  | 'lock_unlock_success'
  | 'lock_unlock_failure'
  | 'lock_throttled'
  | 'lock_revoked'
  | 'lock_pin_changed'
  | 'campaign_created'
  | 'campaign_approved'
  | 'campaign_sent'
  | 'campaign_cancelled'
  | 'campaign_deleted'
  | 'funnel_created'
  | 'funnel_activated'
  | 'funnel_deactivated'
  | 'funnel_enrolled'
  | 'funnel_deleted'
  | 'team_created'
  | 'chat_assigned'
  | 'member_created'
  | 'member_role_changed'
  | 'agent_updated'
  | 'message_revoke_requested'
  | 'campaign_recalled'
  | 'status_revoke_requested'
  | 'email_drafted'
  | 'email_approved'
  | 'email_sent'
  | 'email_cancelled'
  | 'email_settings_updated'
  | 'email_test_sent'
  | 'goose_settings_updated'
  | 'goose_tested'
  | 'ai_tool_invoked'
  | 'ai_tool_denied'
  | 'ai_prompt_optimization_imported'
  | 'ai_prompt_optimization_approved'
  | 'ai_prompt_optimization_rejected'
  | 'business_document_uploaded'
  | 'business_document_upload_blocked'
  | 'business_document_deleted'
  | 'business_document_parsed'
  | 'business_document_parse_failed'
  | 'writing_twin_learning_enabled'
  | 'writing_twin_learning_disabled'
  | 'writing_twin_backfill_requested'
  | 'writing_twin_deleted'
  | 'writing_twin_profile_reset'
  | 'writing_twin_example_removed'
  | 'contact_privacy_updated'
  | 'handover_auto_reverted';

export type SecuritySeverity = 'info' | 'warning' | 'critical';

export interface SecurityAuditLogRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string | null;
  eventType: SecurityEventType;
  severity: SecuritySeverity;
  reason: string | null;
  rawMetadata: Record<string, unknown>;
  createdAt: string;
}

interface SecurityAuditLogRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string | null;
  event_type: SecurityEventType;
  severity: SecuritySeverity;
  reason: string | null;
  raw_metadata: Record<string, unknown>;
  created_at: string;
}

function toRecord(row: SecurityAuditLogRow): SecurityAuditLogRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    eventType: row.event_type,
    severity: row.severity,
    reason: row.reason,
    rawMetadata: row.raw_metadata,
    createdAt: row.created_at,
  };
}

export interface RecordSecurityEventInput {
  businessId: string;
  whatsappAccountId?: string | null;
  eventType: SecurityEventType;
  severity?: SecuritySeverity;
  reason?: string | null;
  rawMetadata?: Record<string, unknown>;
}

export class SecurityAuditLogRepository {
  constructor(private readonly db: Queryable) {}

  /** Never pass message text, contact names, or phone numbers in rawMetadata - structural/diagnostic context only. */
  async record(input: RecordSecurityEventInput): Promise<SecurityAuditLogRecord> {
    const { rows } = await this.db.query<SecurityAuditLogRow>(
      `INSERT INTO security_audit_logs (business_id, whatsapp_account_id, event_type, severity, reason, raw_metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId ?? null,
        input.eventType,
        input.severity ?? 'info',
        input.reason ?? null,
        JSON.stringify(input.rawMetadata ?? {}),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('security_audit_logs insert returned no row');
    return toRecord(row);
  }

  async listRecent(businessId: string, limit = 50): Promise<SecurityAuditLogRecord[]> {
    const { rows } = await this.db.query<SecurityAuditLogRow>(
      'SELECT * FROM security_audit_logs WHERE business_id = $1 ORDER BY created_at DESC LIMIT $2',
      [businessId, limit],
    );
    return rows.map(toRecord);
  }

  /**
   * Real, DB-backed rate-limit primitive for the AI Security Governor -
   * same convention as loginAttemptRepository.countRecentFailures (count
   * real rows in a rolling window), not a new Redis counter. Matches on
   * the toolName recorded in rawMetadata by guardToolInvocation.
   */
  async countRecentByBusinessAndTool(businessId: string, toolName: string, windowMinutes: number): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM security_audit_logs
       WHERE business_id = $1
         AND event_type = 'ai_tool_invoked'
         AND raw_metadata ->> 'toolName' = $2
         AND created_at > now() - ($3 || ' minutes')::interval`,
      [businessId, toolName, windowMinutes],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
