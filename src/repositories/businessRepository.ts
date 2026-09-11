import type { Queryable } from './types.js';

export type BusinessTimeSource = 'AUTOMATIC' | 'MANUAL';

export interface BusinessRecord {
  id: string;
  name: string;
  timezone: string;
  timeSource: BusinessTimeSource;
  manualOverrideTargetUtc: Date | null;
  manualOverrideSetAt: Date | null;
  /** Set the moment account deletion is requested (accountDeletionService.ts) - null means no deletion is pending. */
  deletionRequestedAt: Date | null;
  scheduledPurgeAt: Date | null;
  /** Hex color (e.g. "#0a84ff"), or null to fall back to the app's default accent. */
  brandColor: string | null;
  /** A data: URI (validated + size-capped in workspaceService.ts), or null for no logo set. */
  logoDataUrl: string | null;
  /** Emergency "Stop All Agents" kill switch - true blocks every AI tool call above the READ risk tier, enforced server-side in agentGuard.ts's guardToolInvocation (the one gate every tool call passes through), never just a frontend-hidden button. */
  aiActionsPaused: boolean;
  /** When aiActionsPaused was last turned on - null once cleared. Display-only ("paused since..."), not itself load-bearing for enforcement. */
  aiActionsPausedAt: Date | null;
  /** Personalisation Budget (directive §27): 1=Minimal, 2=Low, 3=Natural (default), 4=Frequent, 5=Very frequent - maps to a real cooldown in identityEngine.ts's shouldUseName(), never a per-agent setting. Only consulted while nameUsageEnabled is true. */
  nameUsageLevel: number;
  /** Master on/off for name usage (default true). When false, shouldUseName() never uses the name on its own initiative - the only exception is a customer explicitly asking to be addressed by name in their own message, which still bypasses this for that one reply. */
  nameUsageEnabled: boolean;
  /** Cross-conversation "customer memory" (customer_memory table, Section 20) on/off - same "kill switch that still lets replies through" shape as aiActionsPaused. Enforced in conversationStateWriter.ts's applyCustomerMemoryUpdate. */
  customerMemoryEnabled: boolean;
  /** Relationship-Confidence Engine (Phase 3): off by default. When a chat matches 2+ Lists with different enabled agent assignments, enables a real, deterministic keyword-count suggestion (relationshipConfidenceService.ts) for THIS message's routing only - never writes whatsapp_chats.active_list_id itself, which stays exclusively human-set. */
  relationshipConfidenceEnabled: boolean;
  /** Operator Mode's "ai off until X"/"ai off for N" command - when set, "ai status" reports it and the scheduled resume job (operator-ai-resume) knows when to bulk-resume. Null for "never paused this way" or an indefinite "ai off" with no timed resume. */
  aiOperatorPausedUntil: string | null;
  /**
   * Whether WhatsApp Channel activity may raise notifications. Off by
   * default: channels are broadcast feeds, not conversations - nobody is
   * waiting on a reply, so letting them notify would bury the things that
   * genuinely need a person. See migration 1018.
   */
  channelNotificationsEnabled: boolean;
  /** Last time this business's own member (not a developer) ran the generic AI test-connection check - backs the 15-minute rate limit on that route. Null until ever tested. */
  aiConnectionTestedAt: Date | null;
  /** A real, first-class home for these three (previously only Motto existed, buried as free text inside the "Business Profile" KB document). The raw text always stays here regardless of missionStatementAiVisible - see workspaceService.ts's setMissionStatement. */
  motto: string | null;
  vision: string | null;
  mission: string | null;
  /** One combined switch for all three - whether they're currently fed to the AI via an auto-managed knowledge-base document. Toggling this off only removes that KB document; it never erases motto/vision/mission themselves. */
  missionStatementAiVisible: boolean;
  /** Which of the 3 built-in invoice/quote/receipt templates (invoiceTemplates.ts) this business uses, plus any block-level color overrides on top of it - see migration 988. Raw JSONB, validated on write (workspaceService.ts's setInvoiceCustomization), not on read. */
  invoiceCustomization: unknown;
  /** Real contact details (migration 989) - shown in the invoice/quote/receipt header alongside motto (the existing "slogan"). Null until a business fills them in; never fabricated. */
  address: string | null;
  phone: string | null;
  /** Admin-developer-granted exemption from subscription/trial/entitlement gating (migration 1002) - default false, zero behavior change for every existing business. Distinct from being on a generous plan: a business with this true bypasses EntitlementService entirely, regardless of what subscriptions/product_trials say. */
  tierUnrestricted: boolean;
}

interface BusinessRow {
  id: string;
  name: string;
  timezone: string;
  time_source: BusinessTimeSource;
  manual_override_target_utc: Date | null;
  manual_override_set_at: Date | null;
  deletion_requested_at: Date | null;
  scheduled_purge_at: Date | null;
  brand_color: string | null;
  logo_data_url: string | null;
  ai_actions_paused: boolean;
  ai_actions_paused_at: Date | null;
  name_usage_level: number;
  name_usage_enabled: boolean;
  customer_memory_enabled: boolean;
  relationship_confidence_enabled: boolean;
  ai_operator_paused_until: string | null;
  channel_notifications_enabled: boolean | null;
  ai_connection_tested_at: Date | null;
  motto: string | null;
  vision: string | null;
  mission: string | null;
  mission_statement_ai_visible: boolean;
  invoice_customization: unknown;
  address: string | null;
  phone: string | null;
  tier_unrestricted: boolean;
}

const BUSINESS_COLUMNS =
  'id, name, timezone, time_source, manual_override_target_utc, manual_override_set_at, deletion_requested_at, scheduled_purge_at, brand_color, logo_data_url, ai_actions_paused, ai_actions_paused_at, name_usage_level, name_usage_enabled, customer_memory_enabled, relationship_confidence_enabled, ai_operator_paused_until, channel_notifications_enabled, ai_connection_tested_at, motto, vision, mission, mission_statement_ai_visible, invoice_customization, address, phone, tier_unrestricted';

function toRecord(row: BusinessRow): BusinessRecord {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    timeSource: row.time_source,
    manualOverrideTargetUtc: row.manual_override_target_utc,
    manualOverrideSetAt: row.manual_override_set_at,
    deletionRequestedAt: row.deletion_requested_at,
    scheduledPurgeAt: row.scheduled_purge_at,
    brandColor: row.brand_color,
    logoDataUrl: row.logo_data_url,
    aiActionsPaused: row.ai_actions_paused,
    aiActionsPausedAt: row.ai_actions_paused_at,
    nameUsageLevel: row.name_usage_level,
    nameUsageEnabled: row.name_usage_enabled,
    customerMemoryEnabled: row.customer_memory_enabled,
    relationshipConfidenceEnabled: row.relationship_confidence_enabled,
    aiOperatorPausedUntil: row.ai_operator_paused_until,
    channelNotificationsEnabled: row.channel_notifications_enabled ?? false,
    aiConnectionTestedAt: row.ai_connection_tested_at,
    motto: row.motto,
    vision: row.vision,
    mission: row.mission,
    missionStatementAiVisible: row.mission_statement_ai_visible,
    invoiceCustomization: row.invoice_customization,
    address: row.address,
    phone: row.phone,
    tierUnrestricted: row.tier_unrestricted,
  };
}

/**
 * Bootstrap tenant repository. AURA's Authentication + Multi-Tenant phase
 * has not been built yet, so this ensures exactly one real business row exists
 * for single-tenant operation until that phase replaces it with real signup.
 */
export class BusinessRepository {
  constructor(private readonly db: Queryable) {}

  async ensureDefault(name = 'Default Business'): Promise<BusinessRecord> {
    const { rows } = await this.db.query<BusinessRow>(`SELECT ${BUSINESS_COLUMNS} FROM businesses ORDER BY created_at LIMIT 1`);
    if (rows[0]) return toRecord(rows[0]);

    const { rows: inserted } = await this.db.query<BusinessRow>(
      `INSERT INTO businesses (name) VALUES ($1) RETURNING ${BUSINESS_COLUMNS}`,
      [name],
    );
    const row = inserted[0];
    if (!row) throw new Error('businesses insert returned no row');
    return toRecord(row);
  }

  async findById(id: string): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(`SELECT ${BUSINESS_COLUMNS} FROM businesses WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async updateName(id: string, name: string): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET name = $2, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, name],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Caller must have already validated `timezone` is a real IANA name (see isValidTimezone). */
  async updateTimezone(id: string, timezone: string): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET timezone = $2, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, timezone],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Enables manual clock override: `targetUtc` is the logical "now" the
   * operator is setting, `setAtUtc` is the real authoritative instant (from
   * TimeService, not client-trusted) it was saved at. TimeService rebases
   * forward from these two values rather than freezing the clock.
   */
  async setManualTimeOverride(id: string, targetUtc: Date, setAtUtc: Date): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses
       SET time_source = 'MANUAL', manual_override_target_utc = $2, manual_override_set_at = $3, updated_at = now()
       WHERE id = $1
       RETURNING ${BUSINESS_COLUMNS}`,
      [id, targetUtc.toISOString(), setAtUtc.toISOString()],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async clearManualTimeOverride(id: string): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses
       SET time_source = 'AUTOMATIC', manual_override_target_utc = NULL, manual_override_set_at = NULL, updated_at = now()
       WHERE id = $1
       RETURNING ${BUSINESS_COLUMNS}`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Caller must have already validated `color` is a "#rrggbb" hex string (see HEX_COLOR_PATTERN) - the DB CHECK constraint is the backstop, not the primary validation. */
  async updateBrandColor(id: string, color: string | null): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET brand_color = $2, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, color],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setAiActionsPaused(id: string, paused: boolean): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses
       SET ai_actions_paused = $2, ai_actions_paused_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
       WHERE id = $1
       RETURNING ${BUSINESS_COLUMNS}`,
      [id, paused],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** `until` null clears it (an indefinite "ai off", or "ai on" clearing the flag entirely). */
  async setAiOperatorPausedUntil(id: string, until: Date | null): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET ai_operator_paused_until = $2, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, until],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Turns WhatsApp Channel notifications on or off for this business. Off by default - see migration 1018. */
  async setChannelNotificationsEnabled(id: string, enabled: boolean): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET channel_notifications_enabled = $2, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, enabled],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Caller must have already validated `level` is an integer 1-5 - the DB CHECK constraint is the backstop, not the primary validation. */
  async setNameUsageLevel(id: string, level: number): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET name_usage_level = $2, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, level],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setNameUsageEnabled(id: string, enabled: boolean): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET name_usage_enabled = $2, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, enabled],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setCustomerMemoryEnabled(id: string, enabled: boolean): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET customer_memory_enabled = $2, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, enabled],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setRelationshipConfidenceEnabled(id: string, enabled: boolean): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET relationship_confidence_enabled = $2, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, enabled],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setTierUnrestricted(id: string, unrestricted: boolean): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET tier_unrestricted = $2, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, unrestricted],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** A single-column read, deliberately not routed through toRecord/BUSINESS_COLUMNS - called on every EntitlementService check (including the per-message AI budget gate from background workers), so this stays as cheap as the check it gates. */
  async isTierUnrestricted(id: string): Promise<boolean> {
    const { rows } = await this.db.query<{ tier_unrestricted: boolean }>('SELECT tier_unrestricted FROM businesses WHERE id = $1', [id]);
    return rows[0]?.tier_unrestricted ?? false;
  }

  async setMissionStatement(id: string, input: { motto: string | null; vision: string | null; mission: string | null; aiVisible: boolean }): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET motto = $2, vision = $3, mission = $4, mission_statement_ai_visible = $5, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, input.motto, input.vision, input.mission, input.aiVisible],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setContactDetails(id: string, input: { address: string | null; phone: string | null }): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET address = $2, phone = $3, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, input.address, input.phone],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setInvoiceCustomization(id: string, customization: unknown): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET invoice_customization = $2, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, JSON.stringify(customization)],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Stamps the moment a business member's own generic AI test-connection check ran - backs that route's 15-minute rate limit. */
  async recordAiConnectionTest(id: string): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET ai_connection_tested_at = now(), updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Caller must have already validated `dataUrl` is a real, size-capped image data: URI. */
  async updateLogo(id: string, dataUrl: string | null): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET logo_data_url = $2, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id, dataUrl],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Clears the abandonment-purge deadline once a trial business has proven
   * a real, successful WhatsApp connection at least once - see
   * whatsappTenantConnection.ts's persistConnectedAccount(). A no-op
   * (still returns the record) if no purge was scheduled, so callers never
   * need to check first.
   */
  async clearScheduledPurge(id: string): Promise<BusinessRecord | null> {
    const { rows } = await this.db.query<BusinessRow>(
      `UPDATE businesses SET scheduled_purge_at = NULL, updated_at = now() WHERE id = $1 RETURNING ${BUSINESS_COLUMNS}`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}

/** Real validation via the runtime's own IANA tz database - rejects anything Node itself would not recognize, rather than trusting free text. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
