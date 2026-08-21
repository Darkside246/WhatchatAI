import type { Queryable } from './types.js';

export const ADVISORY_SEVERITIES = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL', 'UNKNOWN'] as const;
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number];

export const ADVISORY_RISK_CLASSIFICATIONS = ['SAFE', 'WARNING', 'CRITICAL'] as const;
export type AdvisoryRiskClassification = (typeof ADVISORY_RISK_CLASSIFICATIONS)[number];

export interface UpsertAdvisoryInput {
  ghsaId: string;
  deploymentVersion: string;
  severity: AdvisorySeverity;
  summary: string;
  advisoryUrl: string;
  publishedAt: string | null;
  riskClassification: AdvisoryRiskClassification;
}

export interface WatcherRunRecord {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'OK' | 'FAILED';
  versionsChecked: number;
  advisoriesSeen: number;
  cellsQuarantined: number;
  errorMessage: string | null;
}

interface WatcherRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'OK' | 'FAILED';
  versions_checked: number;
  advisories_seen: number;
  cells_quarantined: number;
  error_message: string | null;
}

function toRunRecord(row: WatcherRunRow): WatcherRunRecord {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    versionsChecked: row.versions_checked,
    advisoriesSeen: row.advisories_seen,
    cellsQuarantined: row.cells_quarantined,
    errorMessage: row.error_message,
  };
}

export class OpenClawSecurityAdvisoryRepository {
  constructor(private readonly db: Queryable) {}

  /** Real upsert: a re-run of the same (ghsa_id, version) pair updates the classification and last_checked_at rather than duplicating. */
  async upsertAdvisory(input: UpsertAdvisoryInput): Promise<void> {
    await this.db.query(
      `INSERT INTO openclaw_security_advisories
         (ghsa_id, deployment_version, severity, summary, advisory_url, published_at, risk_classification)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (ghsa_id, deployment_version) DO UPDATE SET
         severity = EXCLUDED.severity,
         summary = EXCLUDED.summary,
         advisory_url = EXCLUDED.advisory_url,
         published_at = EXCLUDED.published_at,
         risk_classification = EXCLUDED.risk_classification,
         last_checked_at = now()`,
      [
        input.ghsaId,
        input.deploymentVersion,
        input.severity,
        input.summary,
        input.advisoryUrl,
        input.publishedAt,
        input.riskClassification,
      ],
    );
  }

  async listByVersion(deploymentVersion: string): Promise<UpsertAdvisoryInput[]> {
    const { rows } = await this.db.query<{
      ghsa_id: string;
      deployment_version: string;
      severity: AdvisorySeverity;
      summary: string;
      advisory_url: string;
      published_at: string | null;
      risk_classification: AdvisoryRiskClassification;
    }>('SELECT * FROM openclaw_security_advisories WHERE deployment_version = $1', [deploymentVersion]);
    return rows.map((row) => ({
      ghsaId: row.ghsa_id,
      deploymentVersion: row.deployment_version,
      severity: row.severity,
      summary: row.summary,
      advisoryUrl: row.advisory_url,
      publishedAt: row.published_at,
      riskClassification: row.risk_classification,
    }));
  }

  async startRun(): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO openclaw_security_watcher_runs (status) VALUES ('OK') RETURNING id`,
    );
    const row = rows[0];
    if (!row) throw new Error('openclaw_security_watcher_runs insert returned no row');
    return row.id;
  }

  async finishRun(
    id: string,
    result: { status: 'OK' | 'FAILED'; versionsChecked: number; advisoriesSeen: number; cellsQuarantined: number; errorMessage?: string | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE openclaw_security_watcher_runs
       SET status = $2, versions_checked = $3, advisories_seen = $4, cells_quarantined = $5, error_message = $6, finished_at = now()
       WHERE id = $1`,
      [id, result.status, result.versionsChecked, result.advisoriesSeen, result.cellsQuarantined, result.errorMessage ?? null],
    );
  }

  async listRecentRuns(limit = 20): Promise<WatcherRunRecord[]> {
    const { rows } = await this.db.query<WatcherRunRow>(
      'SELECT * FROM openclaw_security_watcher_runs ORDER BY started_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(toRunRecord);
  }
}
