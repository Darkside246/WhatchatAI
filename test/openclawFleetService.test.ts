import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * openclawFleetService shells out to the real `openclaw` CLI via
 * execFile - this sandbox cannot install that binary or run a real
 * Docker/Podman daemon (the same constraint that has blocked Docker
 * re-verification since Phase 1), so every test here mocks execFile
 * directly rather than pretending to exercise a real Fleet cell.
 *
 * execFileMock carries Node's own util.promisify.custom symbol so that
 * `promisify(execFile)` inside the service resolves to this mock exactly
 * (matching child_process's real custom-promisify behavior, which
 * resolves `{ stdout, stderr }` rather than the generic single-value
 * promisify wrapping) - without this, the service's `const { stdout } =
 * await execFileAsync(...)` destructuring would silently get `undefined`.
 */
const execFileMock = vi.fn(async (..._args: unknown[]) => ({ stdout: '{}', stderr: '' }));
(execFileMock as unknown as { [key: symbol]: unknown })[promisify.custom] = execFileMock;

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const {
  OpenClawFleetService,
  fleetCellIdForBusiness,
  validateFleetTenantId,
  OPENCLAW_PINNED_IMAGE,
  OPENCLAW_PINNED_VERSION,
} = await import('../src/services/openclawFleetService.js');
const { OpenClawFleetCellRepository } = await import('../src/repositories/openclawFleetCellRepository.js');

describe('fleetCellIdForBusiness / validateFleetTenantId', () => {
  it('derives a tenant ID that matches OpenClaw Fleet\'s own grammar from a real UUID', () => {
    const id = fleetCellIdForBusiness('3fa85f64-5717-4562-b3fc-2c963f66afa6');
    expect(id).toBe('wc-3fa85f6457174562b3fc2c963f66afa6');
    expect(() => validateFleetTenantId(id)).not.toThrow();
  });

  it('rejects IDs that violate the documented tenant-ID pattern', () => {
    expect(() => validateFleetTenantId('Has-Upper')).toThrow();
    expect(() => validateFleetTenantId('-leading-hyphen')).toThrow();
    expect(() => validateFleetTenantId('trailing-hyphen-')).toThrow();
    expect(() => validateFleetTenantId('../traversal')).toThrow();
    expect(() => validateFleetTenantId('has spaces')).toThrow();
    expect(() => validateFleetTenantId('')).toThrow();
  });
});

describe('OpenClawFleetService (real Postgres, mocked Fleet CLI)', () => {
  let businessId: string;
  const repo = new OpenClawFleetCellRepository(pool);
  const service = new OpenClawFleetService(repo);

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register(
      { email: 'fleet-owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' },
    );
    businessId = owner.business.id;
    execFileMock.mockReset();
    execFileMock.mockResolvedValue({ stdout: '{}', stderr: '' });
  });

  afterEach(() => {
    execFileMock.mockReset();
  });

  it('provisions a real cell record, invoking the CLI with the pinned digest-only image and never a shell string', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ tenant: fleetCellIdForBusiness(businessId), port: 19104, gatewayToken: 'deadbeef', url: 'http://127.0.0.1:19104' }),
      stderr: '',
    });

    const result = await service.provisionCellForBusiness(businessId);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('openclaw');
    expect(args).toContain('create');
    expect(args).toContain('--image');
    expect(args).toContain(OPENCLAW_PINNED_IMAGE);
    expect(OPENCLAW_PINNED_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(OPENCLAW_PINNED_IMAGE).not.toMatch(/:latest/);

    expect(result.gatewayToken).toBe('deadbeef');
    expect(result.cell.businessId).toBe(businessId);
    expect(result.cell.deploymentVersion).toBe(OPENCLAW_PINNED_VERSION);
    expect(result.cell.cellState).toBe('RUNNING');
    expect(result.cell.gatewayEndpoint).toBe('http://127.0.0.1:19104');

    const persisted = await repo.findByBusinessId(businessId);
    expect(persisted?.cellState).toBe('RUNNING');
    expect(persisted?.securityStatus).toBe('SAFE');
  });

  it('is idempotent: a second provision call never invokes the CLI again', async () => {
    execFileMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ tenant: fleetCellIdForBusiness(businessId), port: 19104, gatewayToken: 'deadbeef' }),
      stderr: '',
    });
    const first = await service.provisionCellForBusiness(businessId);
    execFileMock.mockClear();

    const second = await service.provisionCellForBusiness(businessId);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(second.gatewayToken).toBeNull();
    expect(second.cell.id).toBe(first.cell.id);
  });

  it('surfaces a real CLI failure as a real error rather than a silently-succeeded cell', async () => {
    execFileMock.mockRejectedValueOnce(Object.assign(new Error('spawn openclaw ENOENT'), { stderr: '' }));

    await expect(service.provisionCellForBusiness(businessId)).rejects.toThrow(/openclaw fleet create/);
    expect(await repo.findByBusinessId(businessId)).toBeNull();
  });

  it('checkHealth reflects Fleet\'s own reported state, not an assumption', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: JSON.stringify({ port: 19104, gatewayToken: 'x' }), stderr: '' });
    await service.provisionCellForBusiness(businessId);
    execFileMock.mockClear();

    execFileMock.mockResolvedValueOnce({ stdout: JSON.stringify({ state: 'running', health: 'failed' }), stderr: '' });
    const afterUnhealthy = await service.checkHealth(businessId);
    expect(afterUnhealthy?.cellState).toBe('UNHEALTHY');

    execFileMock.mockResolvedValueOnce({ stdout: JSON.stringify({ state: 'running', health: 'ok' }), stderr: '' });
    const afterHealthy = await service.checkHealth(businessId);
    expect(afterHealthy?.cellState).toBe('RUNNING');
    expect(afterHealthy?.lastHealthCheckAt).not.toBeNull();
  });

  it('quarantineCell stops the real cell via Fleet and marks SECURITY_QUARANTINED, even if the stop itself fails', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: JSON.stringify({ port: 19104, gatewayToken: 'x' }), stderr: '' });
    await service.provisionCellForBusiness(businessId);
    execFileMock.mockClear();

    execFileMock.mockRejectedValueOnce(Object.assign(new Error('container runtime unreachable'), { stderr: '' }));
    await service.quarantineCell(businessId, 'CVE-TEST-0001: critical advisory affecting deployed version');

    const cell = await repo.findByBusinessId(businessId);
    expect(cell?.securityStatus).toBe('SECURITY_QUARANTINED');
    expect(cell?.quarantineReason).toMatch(/CVE-TEST-0001/);
    expect(execFileMock).toHaveBeenCalledWith('openclaw', expect.arrayContaining(['fleet', 'stop']), expect.anything());
  });

  it('refuses to upgrade to a non-digest-pinned or :latest image reference', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: JSON.stringify({ port: 19104, gatewayToken: 'x' }), stderr: '' });
    await service.provisionCellForBusiness(businessId);
    execFileMock.mockClear();

    await expect(
      service.upgradeCell(businessId, 'ghcr.io/openclaw/openclaw:latest', '2026.9.1'),
    ).rejects.toThrow(/digest-pinned/);
    await expect(
      service.upgradeCell(businessId, 'ghcr.io/openclaw/openclaw:2026.9.1', '2026.9.1'),
    ).rejects.toThrow(/digest-pinned/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('removeCellForBusiness is idempotent and no-ops for a business with no cell', async () => {
    const otherBusinessId = await createTestBusiness('No Cell Business');
    await expect(service.removeCellForBusiness(otherBusinessId, { purgeData: false })).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
