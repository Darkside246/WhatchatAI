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
}

const BUSINESS_COLUMNS =
  'id, name, timezone, time_source, manual_override_target_utc, manual_override_set_at, deletion_requested_at, scheduled_purge_at, brand_color, logo_data_url, ai_actions_paused, ai_actions_paused_at';

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
