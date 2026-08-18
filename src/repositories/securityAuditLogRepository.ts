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
  | 'campaign_created'
  | 'campaign_approved'
  | 'campaign_sent'
  | 'campaign_cancelled'
  | 'funnel_created'
  | 'funnel_activated'
  | 'funnel_deactivated'
  | 'funnel_enrolled'
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
  | 'goose_tested';

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
}
