import { pool } from '../db/pool.js';
import { OpenClawCellRepository } from '../repositories/openclawCellRepository.js';
import {
  OpenClawSecurityAdvisoryRepository,
  type AdvisoryRiskClassification,
  type AdvisorySeverity,
} from '../repositories/openclawSecurityAdvisoryRepository.js';
import { OpenClawCellService, openclawCellService } from './openclawCellService.js';

const ADVISORIES_ENDPOINT = 'https://api.github.com/repos/openclaw/openclaw/security-advisories';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10; // safety cap - real advisory volume for this repo is in the low hundreds, never open-ended

interface GithubSecurityAdvisory {
  ghsa_id: string;
  summary?: string;
  severity?: string;
  html_url?: string;
  published_at?: string | null;
  withdrawn_at?: string | null;
}

function normalizeSeverity(raw: string | undefined): AdvisorySeverity {
  const upper = (raw ?? '').toUpperCase();
  if (upper === 'LOW' || upper === 'MODERATE' || upper === 'HIGH' || upper === 'CRITICAL') return upper;
  return 'UNKNOWN';
}

/**
 * Classifies one advisory for one deployed version. Deliberately
 * severity-only, with no "confirmed patched" path at all in this slice -
 * two real constraints rule that out rather than it being an oversight:
 *
 * 1. GitHub's advisory `patched_versions`/`vulnerable_version_range`
 *    fields are range strings whose exact comparison semantics can't be
 *    verified against a live response from this environment (this
 *    sandbox's egress policy blocks direct calls to api.github.com - see
 *    runSecurityWatcher's own comment).
 * 2. Even with a correct range parser, OpenClaw's own calendar-plus-
 *    rebuild-revision versioning (`2026.7.1`, `2026.7.1-1`, `2026.7.1-2`)
 *    does not follow semver precedence for the `-N` suffix - semver
 *    treats `2026.7.1-2` as a *pre-release* of `2026.7.1` (i.e. older),
 *    when it is actually the same-or-newer rebuild. A naive semver range
 *    check against a lower-bound range (`>= 2026.7.1`) would then
 *    incorrectly report our own newer rebuild as "not in range" - i.e.
 *    falsely SAFE. That failure direction is exactly what a fail-closed
 *    security control must never produce.
 *
 * So: every disclosed, non-withdrawn advisory for a version we run is
 * WARNING or CRITICAL by severity alone, never auto-cleared to SAFE.
 * SAFE remains a valid classification value in the schema for a future
 * slice (an operator-confirmed override, or a verified range parser once
 * the real API response shape and OpenClaw's own version-ordering intent
 * are both confirmed) - it is just never reached by this function today.
 */
export function classifyAdvisoryForVersion(advisory: GithubSecurityAdvisory): AdvisoryRiskClassification {
  const severity = normalizeSeverity(advisory.severity);
  return severity === 'CRITICAL' || severity === 'HIGH' ? 'CRITICAL' : 'WARNING';
}

async function fetchAdvisoriesPage(url: string): Promise<{ advisories: GithubSecurityAdvisory[]; nextUrl: string | null }> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  const token = process.env.OPENCLAW_SECURITY_WATCHER_GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`GitHub security-advisories request failed: HTTP ${response.status}`);
    }
    const advisories = (await response.json()) as GithubSecurityAdvisory[];
    const linkHeader = response.headers.get('link');
    const nextMatch = linkHeader ? /<([^>]+)>;\s*rel="next"/.exec(linkHeader) : null;
    return { advisories, nextUrl: nextMatch?.[1] ?? null };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllAdvisories(): Promise<GithubSecurityAdvisory[]> {
  const all: GithubSecurityAdvisory[] = [];
  let url: string | null = `${ADVISORIES_ENDPOINT}?per_page=100`;
  let pages = 0;
  while (url && pages < MAX_PAGES) {
    const { advisories, nextUrl } = await fetchAdvisoriesPage(url);
    all.push(...advisories);
    url = nextUrl;
    pages += 1;
  }
  return all;
}

export interface SecurityWatcherRunResult {
  status: 'OK' | 'FAILED';
  versionsChecked: number;
  advisoriesSeen: number;
  cellsQuarantined: number;
  errorMessage: string | null;
}

/**
 * Polls GitHub Security Advisories for the openclaw/openclaw repository
 * and evaluates each disclosed, non-withdrawn advisory against every
 * OpenClaw version this platform actually has deployed
 * (`listDistinctDeployedVersions`, not every version that ever existed).
 * A CRITICAL classification quarantines every cell running that version
 * via the DockerCellRuntime (`OpenClawCellService.quarantineCell` - this
 * actually stops the cell, not just a DB flag).
 *
 * NOT verified against a live call to api.github.com from this
 * environment: this sandbox's own egress policy blocks that host for
 * direct HTTP clients (confirmed via curl returning 403/connect_rejected
 * during this engagement's research pass) - a real deployment reaches
 * GitHub's public API normally. Every code path here is covered by tests
 * with `fetch` mocked, not a live call.
 *
 * Fails closed: a fetch/parse failure here never changes any existing
 * cell's security_status or advisory classification - it is recorded as
 * a FAILED run and rethrown so BullMQ's own retry/backoff applies, never
 * silently treated as "nothing to report" and never escalated into
 * quarantining every cell over what might be a transient GitHub outage.
 */
export async function runSecurityWatcher(
  cellRepo: OpenClawCellRepository = new OpenClawCellRepository(pool),
  advisoryRepo: OpenClawSecurityAdvisoryRepository = new OpenClawSecurityAdvisoryRepository(pool),
  cellService: OpenClawCellService = openclawCellService,
): Promise<SecurityWatcherRunResult> {
  const runId = await advisoryRepo.startRun();
  let versionsChecked = 0;
  let advisoriesSeen = 0;
  let cellsQuarantined = 0;

  try {
    const deployedVersions = await cellRepo.listDistinctDeployedVersions();
    if (deployedVersions.length === 0) {
      await advisoryRepo.finishRun(runId, { status: 'OK', versionsChecked: 0, advisoriesSeen: 0, cellsQuarantined: 0 });
      return { status: 'OK', versionsChecked: 0, advisoriesSeen: 0, cellsQuarantined: 0, errorMessage: null };
    }

    const advisories = (await fetchAllAdvisories()).filter((advisory) => !advisory.withdrawn_at);
    advisoriesSeen = advisories.length;

    for (const { deploymentVersion } of deployedVersions) {
      versionsChecked += 1;
      let versionHasCritical = false;

      for (const advisory of advisories) {
        const riskClassification = classifyAdvisoryForVersion(advisory);
        await advisoryRepo.upsertAdvisory({
          ghsaId: advisory.ghsa_id,
          deploymentVersion,
          severity: normalizeSeverity(advisory.severity),
          summary: advisory.summary ?? '(no summary provided)',
          advisoryUrl: advisory.html_url ?? `https://github.com/openclaw/openclaw/security/advisories/${advisory.ghsa_id}`,
          publishedAt: advisory.published_at ?? null,
          riskClassification,
        });
        if (riskClassification === 'CRITICAL') versionHasCritical = true;
      }

      if (versionHasCritical) {
        const businessIds = await cellRepo.listBusinessIdsByDeploymentVersion(deploymentVersion);
        for (const businessId of businessIds) {
          const cell = await cellRepo.findByBusinessId(businessId);
          if (cell && cell.securityStatus !== 'SECURITY_QUARANTINED') {
            await cellService.quarantineCell(
              businessId,
              `Security Watcher: deployed version ${deploymentVersion} has a CRITICAL-classified advisory - quarantined automatically, never silently upgraded.`,
            );
            cellsQuarantined += 1;
          }
        }
      }
    }

    await advisoryRepo.finishRun(runId, { status: 'OK', versionsChecked, advisoriesSeen, cellsQuarantined });
    return { status: 'OK', versionsChecked, advisoriesSeen, cellsQuarantined, errorMessage: null };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await advisoryRepo
      .finishRun(runId, { status: 'FAILED', versionsChecked, advisoriesSeen, cellsQuarantined, errorMessage })
      .catch((finishError) => console.error('[openclawSecurityWatcherService] failed to record FAILED run:', finishError));
    throw error;
  }
}
