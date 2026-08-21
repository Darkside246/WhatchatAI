import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { OpenClawFleetCellRepository } from '../src/repositories/openclawFleetCellRepository.js';
import { OpenClawSecurityAdvisoryRepository } from '../src/repositories/openclawSecurityAdvisoryRepository.js';
import { classifyAdvisoryForVersion, runSecurityWatcher } from '../src/services/openclawSecurityWatcherService.js';
import { OpenClawFleetService } from '../src/services/openclawFleetService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * runSecurityWatcher polls the real GitHub Security Advisories API for
 * openclaw/openclaw - this sandbox's own egress policy blocks direct
 * calls to api.github.com (confirmed via curl during this session's
 * research pass), so every test here mocks `fetch` directly rather than
 * making a live call. A real deployment reaches GitHub's public API
 * normally; this is the same "not fully verified against a live call"
 * honesty already applied to openclawFleetService's execFile mocking.
 */
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

describe('classifyAdvisoryForVersion', () => {
  it('classifies CRITICAL/HIGH severity as CRITICAL', () => {
    expect(classifyAdvisoryForVersion({ ghsa_id: 'GHSA-1', severity: 'critical' })).toBe('CRITICAL');
    expect(classifyAdvisoryForVersion({ ghsa_id: 'GHSA-2', severity: 'high' })).toBe('CRITICAL');
  });

  it('classifies MODERATE/LOW/missing severity as WARNING, never SAFE', () => {
    expect(classifyAdvisoryForVersion({ ghsa_id: 'GHSA-3', severity: 'moderate' })).toBe('WARNING');
    expect(classifyAdvisoryForVersion({ ghsa_id: 'GHSA-4', severity: 'low' })).toBe('WARNING');
    expect(classifyAdvisoryForVersion({ ghsa_id: 'GHSA-5' })).toBe('WARNING');
    expect(classifyAdvisoryForVersion({ ghsa_id: 'GHSA-6', severity: 'nonsense' })).toBe('WARNING');
  });
});

describe('runSecurityWatcher (real Postgres, mocked fetch)', () => {
  let businessId: string;
  const fleetCellRepo = new OpenClawFleetCellRepository(pool);
  const advisoryRepo = new OpenClawSecurityAdvisoryRepository(pool);
  const execFileMock = vi.fn(async () => ({ stdout: '', stderr: '' }));
  const fleetService = new OpenClawFleetService(fleetCellRepo);
  // quarantineCell shells out via execFile internally - stub it out on the
  // instance so this suite tests only the watcher's own decision logic,
  // not Fleet CLI invocation (that's openclawFleetService.test.ts's job).
  const quarantineSpy = vi.spyOn(fleetService, 'quarantineCell').mockResolvedValue(undefined);

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register(
      { email: 'watcher-owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' },
    );
    businessId = owner.business.id;
    await fleetCellRepo.create({
      businessId,
      fleetCellId: 'wc-watchertest',
      deploymentVersion: '2026.7.1-2',
      imageDigest: 'ghcr.io/openclaw/openclaw@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac',
    });
    fetchMock.mockReset();
    quarantineSpy.mockClear();
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it('records advisories and does NOT quarantine when nothing is CRITICAL', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ ghsa_id: 'GHSA-aaaa', summary: 'A moderate issue', severity: 'moderate', html_url: 'https://x/1' }]),
    );

    const result = await runSecurityWatcher(fleetCellRepo, advisoryRepo, fleetService);

    expect(result.status).toBe('OK');
    expect(result.versionsChecked).toBe(1);
    expect(result.advisoriesSeen).toBe(1);
    expect(result.cellsQuarantined).toBe(0);
    expect(quarantineSpy).not.toHaveBeenCalled();

    const stored = await advisoryRepo.listByVersion('2026.7.1-2');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.riskClassification).toBe('WARNING');

    const cell = await fleetCellRepo.findByBusinessId(businessId);
    expect(cell?.securityStatus).toBe('SAFE');
  });

  it('quarantines every cell on the affected version when an advisory is CRITICAL', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ ghsa_id: 'GHSA-bbbb', summary: 'A critical issue', severity: 'critical', html_url: 'https://x/2' }]),
    );

    const result = await runSecurityWatcher(fleetCellRepo, advisoryRepo, fleetService);

    expect(result.cellsQuarantined).toBe(1);
    expect(quarantineSpy).toHaveBeenCalledWith(businessId, expect.stringContaining('2026.7.1-2'));

    const stored = await advisoryRepo.listByVersion('2026.7.1-2');
    expect(stored[0]?.riskClassification).toBe('CRITICAL');
  });

  it('ignores withdrawn advisories entirely', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { ghsa_id: 'GHSA-cccc', summary: 'Withdrawn', severity: 'critical', withdrawn_at: '2026-01-01T00:00:00Z', html_url: 'https://x/3' },
      ]),
    );

    const result = await runSecurityWatcher(fleetCellRepo, advisoryRepo, fleetService);

    expect(result.cellsQuarantined).toBe(0);
    expect(await advisoryRepo.listByVersion('2026.7.1-2')).toHaveLength(0);
  });

  it('follows pagination via the Link header', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([{ ghsa_id: 'GHSA-page1', severity: 'low', html_url: 'https://x/4' }], {
          link: '<https://api.github.com/repos/openclaw/openclaw/security-advisories?per_page=100&page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ ghsa_id: 'GHSA-page2', severity: 'low', html_url: 'https://x/5' }]));

    const result = await runSecurityWatcher(fleetCellRepo, advisoryRepo, fleetService);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.advisoriesSeen).toBe(2);
  });

  it('fails closed: a fetch failure records a FAILED run, rethrows, and never quarantines or touches existing state', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network unreachable'));

    await expect(runSecurityWatcher(fleetCellRepo, advisoryRepo, fleetService)).rejects.toThrow('network unreachable');
    expect(quarantineSpy).not.toHaveBeenCalled();

    const cell = await fleetCellRepo.findByBusinessId(businessId);
    expect(cell?.securityStatus).toBe('SAFE');

    const runs = await advisoryRepo.listRecentRuns(1);
    expect(runs[0]?.status).toBe('FAILED');
    expect(runs[0]?.errorMessage).toContain('network unreachable');
  });

  it('never re-quarantines a cell that is already SECURITY_QUARANTINED', async () => {
    await fleetCellRepo.quarantine(businessId, 'manual test setup');
    fetchMock.mockResolvedValueOnce(jsonResponse([{ ghsa_id: 'GHSA-dddd', severity: 'critical', html_url: 'https://x/6' }]));

    const result = await runSecurityWatcher(fleetCellRepo, advisoryRepo, fleetService);

    expect(result.cellsQuarantined).toBe(0);
    expect(quarantineSpy).not.toHaveBeenCalled();
  });

  it('no-ops cleanly (no fetch at all) when no tenant has a Fleet cell deployed', async () => {
    await createTestBusiness('No Fleet Business');
    await fleetCellRepo.remove(businessId);

    const result = await runSecurityWatcher(fleetCellRepo, advisoryRepo, fleetService);

    expect(result.status).toBe('OK');
    expect(result.versionsChecked).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
