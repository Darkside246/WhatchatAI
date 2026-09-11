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
  | 'agent_deleted'
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
  | 'writing_twin_share_enabled'
  | 'writing_twin_share_disabled'
  | 'writing_twin_agent_access_changed'
  | 'writing_twin_profile_computed'
  | 'writing_twin_context_served'
  | 'contact_privacy_updated'
  | 'crm_contact_memory_erased'
  | 'handover_auto_reverted'
  | 'account_deletion_requested'
  | 'account_deletion_cancelled'
  | 'phone_number_changed'
  | 'ai_output_leak_blocked'
  | 'ai_output_leak_check_unavailable'
  /** A generated reply addressed a team member instead of the customer; the direct address was removed before sending (teamAddressGuard.ts). */
  | 'ai_output_team_address_removed'
  | 'message_risk_flagged'
  | 'plan_updated'
  | 'plan_entitlement_updated'
  | 'vertical_assigned'
  | 'platform_setting_updated'
  | 'subscription_plan_manually_changed'
  | 'bi_settings_enabled'
  | 'bi_settings_disabled'
  | 'bi_insight_approved'
  | 'bi_insight_rejected'
  | 'bi_insight_held'
  | 'bi_security_alert_detected'
  | 'list_created'
  | 'list_deleted'
  | 'list_agent_assigned'
  | 'list_agent_unassigned'
  | 'list_membership_changed'
  | 'list_active_list_set'
  | 'list_routed'
  | 'list_scoped_memory_erased'
  | 'governance_flag_raised'
  | 'governance_flag_reviewed'
  | 'governance_flag_dismissed'
  | 'relationship_confidence_enabled'
  | 'relationship_confidence_disabled'
  | 'relationship_suggestion_computed'
  | 'relationship_suggestion_overridden'
  | 'developer_promoted'
  | 'developer_demoted'
  | 'auth_rate_limited'
  | 'signup_recaptcha_failed'
  | 'oversight_finding_raised'
  | 'oversight_finding_status_changed'
  | 'oversight_monitoring_degraded'
  | 'developer_tier_changed'
  | 'business_tier_unrestricted_granted'
  | 'business_tier_unrestricted_revoked';

export type SecuritySeverity = 'info' | 'warning' | 'critical';

export interface SecurityAuditLogRecord {
  id: string;
  /** Null for a genuinely platform-wide event (e.g. a developer changing a plan that applies across every subscribed business) - see migration 974. */
  businessId: string | null;
  whatsappAccountId: string | null;
  eventType: SecurityEventType;
  severity: SecuritySeverity;
  reason: string | null;
  rawMetadata: Record<string, unknown>;
  createdAt: string;
}

interface SecurityAuditLogRow {
  id: string;
  business_id: string | null;
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
  /** Null only for a genuinely platform-wide event with no single owning business - see migration 974. Every ordinary business action must still pass a real businessId. */
  businessId: string | null;
  whatsappAccountId?: string | null;
  eventType: SecurityEventType;
  severity?: SecuritySeverity;
  reason?: string | null;
  rawMetadata?: Record<string, unknown>;
}

/** Real, SQL-applied filters for the developer security-events view. */
export interface SecurityEventFilters {
  severity?: string | undefined;
  eventType?: string | undefined;
  businessId?: string | undefined;
  /** 'newest' (default) or 'oldest' - whitelisted, never interpolated. */
  sort?: 'newest' | 'oldest' | undefined;
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

  /** Section 48 (Autonomous Morning Briefing): real, already-recorded events of one type since a point in time - e.g. every message_risk_flagged event, never a fabricated "important discoveries" list. */
  async listByTypeSince(businessId: string, eventType: SecurityEventType, sinceIso: string, limit = 50): Promise<SecurityAuditLogRecord[]> {
    const { rows } = await this.db.query<SecurityAuditLogRow>(
      'SELECT * FROM security_audit_logs WHERE business_id = $1 AND event_type = $2 AND created_at >= $3 ORDER BY created_at DESC LIMIT $4',
      [businessId, eventType, sinceIso, limit],
    );
    return rows.map(toRecord);
  }

  /**
   * Real, DB-backed rate-limit primitive for the AI Security Governor -
   * same convention as loginAttemptRepository.countRecentFailures (count
   * real rows in a rolling window), not a new Redis counter. Matches on
   * the toolName recorded in rawMetadata by guardToolInvocation.
   */
  /** The platform-wide events listRecent can never see (it's always scoped to one businessId) - a developer-facing view of plan/entitlement config changes. */
  async listPlatformEvents(limit = 100): Promise<SecurityAuditLogRecord[]> {
    const { rows } = await this.db.query<SecurityAuditLogRow>(
      'SELECT * FROM security_audit_logs WHERE business_id IS NULL ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(toRecord);
  }

  /**
   * The real detail behind the Developer Control Plane's "Security events
   * (24h)" stat pill - every event across every business in the window,
   * not just the null-business platform events listPlatformEvents covers.
   * Bare pool, one join for the business name (matching
   * governanceFlagRepository.listOpenAcrossPlatform's own precedent for a
   * developer-facing cross-tenant view) - structural fields only, never
   * raw message content (this table's own established convention).
   */
  async listRecentAcrossPlatform(
    hours: number,
    limit = 200,
    filters: SecurityEventFilters = {},
  ): Promise<Array<SecurityAuditLogRecord & { businessName: string | null }>> {
    // Filters are applied in SQL, not after the fact in JS: a severity or
    // type filter has to search the whole window, otherwise it would only
    // ever filter within the most recent `limit` rows and silently hide
    // older matches - which is exactly the shape of bug that makes an audit
    // view untrustworthy.
    const conditions: string[] = ["sal.created_at > NOW() - ($1 || ' hours')::interval"];
    const params: unknown[] = [hours];

    if (filters.severity) {
      params.push(filters.severity);
      conditions.push(`sal.severity = $${params.length}`);
    }
    if (filters.eventType) {
      params.push(filters.eventType);
      conditions.push(`sal.event_type = $${params.length}`);
    }
    if (filters.businessId) {
      params.push(filters.businessId);
      conditions.push(`sal.business_id = $${params.length}`);
    }

    // Whitelisted, never interpolated from caller input - the only two
    // orderings that make sense for a chronological audit view.
    const direction = filters.sort === 'oldest' ? 'ASC' : 'DESC';
    params.push(limit);

    const { rows } = await this.db.query<SecurityAuditLogRow & { business_name: string | null }>(
      `SELECT sal.*, b.name AS business_name
       FROM security_audit_logs sal
       LEFT JOIN businesses b ON b.id = sal.business_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY sal.created_at ${direction}
       LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({ ...toRecord(row), businessName: row.business_name }));
  }

  /** The distinct event types and severities actually present in the window, so a filter UI offers only values that will really match something. */
  async listRecentFacetsAcrossPlatform(hours: number): Promise<{ eventTypes: string[]; severities: string[] }> {
    const { rows } = await this.db.query<{ event_type: string; severity: string }>(
      `SELECT DISTINCT event_type, severity FROM security_audit_logs
        WHERE created_at > NOW() - ($1 || ' hours')::interval`,
      [hours],
    );
    return {
      eventTypes: [...new Set(rows.map((row) => row.event_type))].sort(),
      severities: [...new Set(rows.map((row) => row.severity))].sort(),
    };
  }

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

  /**
   * AI Governance & Oversight (v1): per-(business, agent) count of one
   * event type since a point in time - powers governanceSweepService.ts's
   * high_tool_denial_rate rule (event_type='ai_tool_denied'). agentId is a
   * plain string inside raw_metadata (see agentGuard.ts's guardToolInvocation),
   * so ->> (text extraction) is correct - no ::uuid cast needed since this
   * is a GROUP BY, not a join. Bare-pool, platform-wide in one pass - the
   * sweep scans every business at once rather than looping per business,
   * matching listPlatformEvents's own precedent.
   */
  async countGroupedByAgentSince(eventType: SecurityEventType, sinceIso: string): Promise<{ businessId: string; agentId: string; count: number }[]> {
    const { rows } = await this.db.query<{ business_id: string; agent_id: string; count: string }>(
      `SELECT business_id, raw_metadata ->> 'agentId' AS agent_id, count(*)::int AS count
       FROM security_audit_logs
       WHERE event_type = $1
         AND business_id IS NOT NULL
         AND raw_metadata ->> 'agentId' IS NOT NULL
         AND created_at >= $2
       GROUP BY business_id, raw_metadata ->> 'agentId'`,
      [eventType, sinceIso],
    );
    return rows.map((row) => ({ businessId: row.business_id, agentId: row.agent_id, count: Number(row.count) }));
  }

  /**
   * AI Governance & Oversight (v1): per-business count across one or more
   * event types since a point in time - powers high_sentinel_block_rate
   * (sentinel_heuristic_block + sentinel_ai_block) and high_output_leak_rate
   * (ai_output_leak_blocked). Business-scoped only, never per-agent -
   * neither sentinel.ts nor the outbound leak guard record an agentId in
   * rawMetadata today. Bare-pool, platform-wide in one pass, same
   * reasoning as countGroupedByAgentSince above.
   */
  async countGroupedByBusinessSince(eventTypes: SecurityEventType[], sinceIso: string): Promise<{ businessId: string; count: number }[]> {
    const { rows } = await this.db.query<{ business_id: string; count: string }>(
      `SELECT business_id, count(*)::int AS count
       FROM security_audit_logs
       WHERE event_type = ANY($1::text[])
         AND business_id IS NOT NULL
         AND created_at >= $2
       GROUP BY business_id`,
      [eventTypes, sinceIso],
    );
    return rows.map((row) => ({ businessId: row.business_id, count: Number(row.count) }));
  }

  /**
   * AURA AI Oversight & Reliability Agent: a plain platform-wide total
   * across one or more event types since a point in time - unlike
   * countGroupedByBusinessSince, this does NOT filter out
   * business_id IS NULL rows, because the two signals this was built for
   * (auth_rate_limited, signup_recaptcha_failed) are recorded with a null
   * business_id by construction (they fire before any business/user is
   * known - see src/server/index.ts's authLimiter and
   * productAccountRoutes.ts's recaptcha check). Bare-pool, platform-wide.
   */
  async countSince(eventTypes: SecurityEventType[], sinceIso: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM security_audit_logs WHERE event_type = ANY($1::text[]) AND created_at >= $2`,
      [eventTypes, sinceIso],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
