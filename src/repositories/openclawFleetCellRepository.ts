import type { Queryable } from './types.js';

export const FLEET_CELL_SECURITY_STATUSES = ['SAFE', 'WARNING', 'CRITICAL', 'SECURITY_QUARANTINED'] as const;
export type FleetCellSecurityStatus = (typeof FLEET_CELL_SECURITY_STATUSES)[number];

export const FLEET_CELL_STATES = [
  'PENDING', 'CREATING', 'RUNNING', 'STOPPED', 'UPGRADING', 'REMOVED', 'UNHEALTHY',
] as const;
export type FleetCellState = (typeof FLEET_CELL_STATES)[number];

export interface OpenClawFleetCellRecord {
  id: string;
  businessId: string;
  fleetCellId: string;
  gatewayEndpoint: string | null;
  deploymentVersion: string;
  imageDigest: string;
  securityStatus: FleetCellSecurityStatus;
  cellState: FleetCellState;
  quarantineReason: string | null;
  quarantinedAt: string | null;
  lastHealthCheckAt: string | null;
  /** Fencing generation - bumped only when the underlying container is genuinely replaced (provision, upgrade), never by start/stop. */
  generation: number;
  createdAt: string;
  updatedAt: string;
}

interface OpenClawFleetCellRow {
  id: string;
  business_id: string;
  fleet_cell_id: string;
  gateway_endpoint: string | null;
  deployment_version: string;
  image_digest: string;
  security_status: FleetCellSecurityStatus;
  cell_state: FleetCellState;
  quarantine_reason: string | null;
  quarantined_at: string | null;
  last_health_check_at: string | null;
  generation: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: OpenClawFleetCellRow): OpenClawFleetCellRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    fleetCellId: row.fleet_cell_id,
    gatewayEndpoint: row.gateway_endpoint,
    deploymentVersion: row.deployment_version,
    imageDigest: row.image_digest,
    securityStatus: row.security_status,
    cellState: row.cell_state,
    quarantineReason: row.quarantine_reason,
    quarantinedAt: row.quarantined_at,
    lastHealthCheckAt: row.last_health_check_at,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateOpenClawFleetCellInput {
  businessId: string;
  fleetCellId: string;
  deploymentVersion: string;
  imageDigest: string;
  gatewayEndpoint?: string | null | undefined;
}

export class OpenClawFleetCellRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateOpenClawFleetCellInput): Promise<OpenClawFleetCellRecord> {
    const { rows } = await this.db.query<OpenClawFleetCellRow>(
      `INSERT INTO openclaw_fleet_cells
         (business_id, fleet_cell_id, deployment_version, image_digest, gateway_endpoint, cell_state)
       VALUES ($1, $2, $3, $4, $5, 'CREATING')
       RETURNING *`,
      [input.businessId, input.fleetCellId, input.deploymentVersion, input.imageDigest, input.gatewayEndpoint ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('openclaw_fleet_cells insert returned no row');
    return toRecord(row);
  }

  async findByBusinessId(businessId: string): Promise<OpenClawFleetCellRecord | null> {
    const { rows } = await this.db.query<OpenClawFleetCellRow>(
      'SELECT * FROM openclaw_fleet_cells WHERE business_id = $1',
      [businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * The adapter endpoint's only lookup path: a hash never round-trips
   * back to the raw callback token, so this is the sole way a cell's
   * bearer credential resolves to a tenant/cell identity. Never exposed
   * via `OpenClawFleetCellRecord` itself - callers only ever compare a
   * hash to find a row, never read one back off a record.
   */
  async findByCallbackTokenHash(callbackTokenHash: string): Promise<OpenClawFleetCellRecord | null> {
    const { rows } = await this.db.query<OpenClawFleetCellRow>(
      'SELECT * FROM openclaw_fleet_cells WHERE callback_token_hash = $1',
      [callbackTokenHash],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setCallbackTokenHash(businessId: string, callbackTokenHash: string): Promise<void> {
    await this.db.query(
      'UPDATE openclaw_fleet_cells SET callback_token_hash = $2, updated_at = now() WHERE business_id = $1',
      [businessId, callbackTokenHash],
    );
  }

  async findByFleetCellId(fleetCellId: string): Promise<OpenClawFleetCellRecord | null> {
    const { rows } = await this.db.query<OpenClawFleetCellRow>(
      'SELECT * FROM openclaw_fleet_cells WHERE fleet_cell_id = $1',
      [fleetCellId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listAll(): Promise<OpenClawFleetCellRecord[]> {
    const { rows } = await this.db.query<OpenClawFleetCellRow>('SELECT * FROM openclaw_fleet_cells ORDER BY created_at');
    return rows.map(toRecord);
  }

  /**
   * Every deployed version, deduplicated - the shape the Security Watcher
   * needs to check advisories once per distinct deployed version rather
   * than once per tenant.
   */
  async listDistinctDeployedVersions(): Promise<Array<{ deploymentVersion: string; imageDigest: string }>> {
    const { rows } = await this.db.query<{ deployment_version: string; image_digest: string }>(
      'SELECT DISTINCT deployment_version, image_digest FROM openclaw_fleet_cells',
    );
    return rows.map((row) => ({ deploymentVersion: row.deployment_version, imageDigest: row.image_digest }));
  }

  /** Every business currently deployed on a given version - the Security Watcher's own quarantine fan-out target. */
  async listBusinessIdsByDeploymentVersion(deploymentVersion: string): Promise<string[]> {
    const { rows } = await this.db.query<{ business_id: string }>(
      'SELECT business_id FROM openclaw_fleet_cells WHERE deployment_version = $1',
      [deploymentVersion],
    );
    return rows.map((row) => row.business_id);
  }

  async updateCellState(businessId: string, cellState: FleetCellState): Promise<void> {
    await this.db.query(
      'UPDATE openclaw_fleet_cells SET cell_state = $2, updated_at = now() WHERE business_id = $1',
      [businessId, cellState],
    );
  }

  async recordHealthCheck(businessId: string, cellState: FleetCellState): Promise<void> {
    await this.db.query(
      'UPDATE openclaw_fleet_cells SET cell_state = $2, last_health_check_at = now(), updated_at = now() WHERE business_id = $1',
      [businessId, cellState],
    );
  }

  /** An upgrade genuinely recreates the container - bumps generation so any in-flight fenced tool request from the prior generation is rejected. */
  async recordUpgrade(businessId: string, deploymentVersion: string, imageDigest: string): Promise<void> {
    await this.db.query(
      `UPDATE openclaw_fleet_cells
       SET deployment_version = $2, image_digest = $3, cell_state = 'RUNNING', generation = generation + 1, updated_at = now()
       WHERE business_id = $1`,
      [businessId, deploymentVersion, imageDigest],
    );
  }

  /**
   * Places a cell into SECURITY_QUARANTINED. Distinct from cell_state:
   * security_status reflects the Security Watcher's own judgement and is
   * never cleared by an ordinary health check - only an explicit
   * `clearQuarantine` after real remediation (upgrade + review).
   */
  async quarantine(businessId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE openclaw_fleet_cells
       SET security_status = 'SECURITY_QUARANTINED', quarantine_reason = $2, quarantined_at = now(), updated_at = now()
       WHERE business_id = $1`,
      [businessId, reason],
    );
  }

  async setSecurityStatus(businessId: string, status: FleetCellSecurityStatus): Promise<void> {
    await this.db.query(
      'UPDATE openclaw_fleet_cells SET security_status = $2, updated_at = now() WHERE business_id = $1',
      [businessId, status],
    );
  }

  async clearQuarantine(businessId: string): Promise<void> {
    await this.db.query(
      `UPDATE openclaw_fleet_cells
       SET security_status = 'SAFE', quarantine_reason = NULL, quarantined_at = NULL, updated_at = now()
       WHERE business_id = $1`,
      [businessId],
    );
  }

  async remove(businessId: string): Promise<void> {
    await this.db.query('DELETE FROM openclaw_fleet_cells WHERE business_id = $1', [businessId]);
  }
}
