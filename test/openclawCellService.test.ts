import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';
import {
  OpenClawCellService,
  cellIdForBusiness,
  validateCellId,
  OPENCLAW_PINNED_IMAGE,
  OPENCLAW_PINNED_VERSION,
} from '../src/services/openclawCellService.js';
import { OpenClawCellRepository } from '../src/repositories/openclawCellRepository.js';
import { hashCallbackToken } from '../src/services/openclawCallbackTokenService.js';
import type { OpenClawCellRuntime, CellCreateResult, CellStatus } from '../src/services/openclawCellRuntime.js';

/**
 * `OpenClawCellService` no longer calls a CLI directly (see the class's
 * own doc comment for why: real-environment verification found
 * `openclaw fleet` doesn't exist in the stable, pinned OpenClaw release).
 * It now delegates all container lifecycle work to an injected
 * `OpenClawCellRuntime`, so these tests exercise the service's real
 * DB-facing orchestration logic against a fake runtime - the runtime's
 * own implementation (`DockerCellRuntime`) has its own dedicated test
 * file (`dockerCellRuntime.test.ts`) covering the real `docker` CLI
 * invocation shape.
 */
function createFakeRuntime(): OpenClawCellRuntime & {
  create: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  upgrade: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  return {
    name: 'fake',
    create: vi.fn<(cellId: string, image: string, env: Record<string, string>) => Promise<CellCreateResult>>(),
    status: vi.fn<(cellId: string) => Promise<CellStatus>>(),
    stop: vi.fn<(cellId: string) => Promise<void>>(),
    start: vi.fn<(cellId: string) => Promise<void>>(),
    upgrade: vi.fn<(cellId: string, image: string) => Promise<CellCreateResult>>(),
    remove: vi.fn<(cellId: string, options: { purgeData: boolean }) => Promise<void>>(),
  };
}

describe('cellIdForBusiness / validateCellId', () => {
  it('derives a cell ID that matches OpenClaw\'s own container-naming grammar from a real UUID', () => {
    const id = cellIdForBusiness('3fa85f64-5717-4562-b3fc-2c963f66afa6');
    expect(id).toBe('wc-3fa85f6457174562b3fc2c963f66afa6');
    expect(() => validateCellId(id)).not.toThrow();
  });

  it('rejects IDs that violate the documented pattern', () => {
    expect(() => validateCellId('Has-Upper')).toThrow();
    expect(() => validateCellId('-leading-hyphen')).toThrow();
    expect(() => validateCellId('trailing-hyphen-')).toThrow();
    expect(() => validateCellId('../traversal')).toThrow();
    expect(() => validateCellId('has spaces')).toThrow();
    expect(() => validateCellId('')).toThrow();
  });
});

describe('OpenClawCellService (real Postgres, fake OpenClawCellRuntime)', () => {
  let businessId: string;
  const repo = new OpenClawCellRepository(pool);
  let runtime: ReturnType<typeof createFakeRuntime>;
  let service: OpenClawCellService;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register(
      { email: 'cell-owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' },
    );
    businessId = owner.business.id;
    runtime = createFakeRuntime();
    service = new OpenClawCellService(repo, runtime);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('provisions a real cell record, calling the runtime with the pinned digest-only image and never a moving tag', async () => {
    runtime.create.mockResolvedValueOnce({ containerId: 'abc123', gatewayEndpoint: 'http://127.0.0.1:19104', port: 19104 });

    const result = await service.provisionCellForBusiness(businessId);

    expect(runtime.create).toHaveBeenCalledTimes(1);
    const [cellId, image, env] = runtime.create.mock.calls[0] as [string, string, Record<string, string>];
    expect(cellId).toBe(cellIdForBusiness(businessId));
    expect(image).toBe(OPENCLAW_PINNED_IMAGE);
    expect(OPENCLAW_PINNED_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(OPENCLAW_PINNED_IMAGE).not.toMatch(/:latest/);

    // A real, random Gateway token AND callback token are minted and
    // passed into the container's own environment.
    expect(env.OPENCLAW_GATEWAY_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(env.OPENCLAW_CALLBACK_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(result.gatewayToken).toBe(env.OPENCLAW_GATEWAY_TOKEN);
    expect(result.callbackToken).toBe(env.OPENCLAW_CALLBACK_TOKEN);

    expect(result.cell.businessId).toBe(businessId);
    expect(result.cell.deploymentVersion).toBe(OPENCLAW_PINNED_VERSION);
    expect(result.cell.cellState).toBe('RUNNING');
    expect(result.cell.gatewayEndpoint).toBe('http://127.0.0.1:19104');

    const persisted = await repo.findByBusinessId(businessId);
    expect(persisted?.cellState).toBe('RUNNING');
    expect(persisted?.securityStatus).toBe('SAFE');
    expect(await repo.findByCallbackTokenHash(hashCallbackToken(result.callbackToken as string))).not.toBeNull();

    // The Gateway token is persisted encrypted (Phase 2) as well as
    // returned once - it round-trips back to the exact same plaintext via
    // the one narrow, explicit accessor, and never appears on the
    // ordinary record shape at all (not even encrypted).
    expect(await repo.getGatewayToken(businessId)).toBe(result.gatewayToken);
    expect(await repo.hasGatewayToken(businessId)).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain(result.gatewayToken as string);
  });

  it('is idempotent: a second provision call never invokes the runtime again', async () => {
    runtime.create.mockResolvedValueOnce({ containerId: 'abc123', gatewayEndpoint: 'http://127.0.0.1:19104', port: 19104 });
    const first = await service.provisionCellForBusiness(businessId);
    runtime.create.mockClear();

    const second = await service.provisionCellForBusiness(businessId);

    expect(runtime.create).not.toHaveBeenCalled();
    expect(second.gatewayToken).toBeNull();
    expect(second.callbackToken).toBeNull();
    expect(second.cell.id).toBe(first.cell.id);
  });

  it('surfaces a real runtime failure as a real error rather than a silently-succeeded cell', async () => {
    runtime.create.mockRejectedValueOnce(new Error('docker run failed: no such image'));

    await expect(service.provisionCellForBusiness(businessId)).rejects.toThrow(/no such image/);
    expect(await repo.findByBusinessId(businessId)).toBeNull();
  });

  it('checkHealth reflects the runtime\'s own reported state, not an assumption', async () => {
    runtime.create.mockResolvedValueOnce({ containerId: 'abc123', gatewayEndpoint: 'http://127.0.0.1:19104', port: 19104 });
    await service.provisionCellForBusiness(businessId);

    runtime.status.mockResolvedValueOnce({ state: 'running', healthy: false });
    const afterUnhealthy = await service.checkHealth(businessId);
    expect(afterUnhealthy?.cellState).toBe('UNHEALTHY');

    runtime.status.mockResolvedValueOnce({ state: 'running', healthy: true });
    const afterHealthy = await service.checkHealth(businessId);
    expect(afterHealthy?.cellState).toBe('RUNNING');
    expect(afterHealthy?.lastHealthCheckAt).not.toBeNull();
  });

  it('quarantineCell stops the real cell via the runtime and marks SECURITY_QUARANTINED, even if the stop itself fails', async () => {
    runtime.create.mockResolvedValueOnce({ containerId: 'abc123', gatewayEndpoint: 'http://127.0.0.1:19104', port: 19104 });
    await service.provisionCellForBusiness(businessId);

    runtime.stop.mockRejectedValueOnce(new Error('container runtime unreachable'));
    await service.quarantineCell(businessId, 'CVE-TEST-0001: critical advisory affecting deployed version');

    const cell = await repo.findByBusinessId(businessId);
    expect(cell?.securityStatus).toBe('SECURITY_QUARANTINED');
    expect(cell?.quarantineReason).toMatch(/CVE-TEST-0001/);
    expect(runtime.stop).toHaveBeenCalledWith(cellIdForBusiness(businessId));
  });

  it('refuses to upgrade to a non-digest-pinned or :latest image reference, never even calling the runtime', async () => {
    runtime.create.mockResolvedValueOnce({ containerId: 'abc123', gatewayEndpoint: 'http://127.0.0.1:19104', port: 19104 });
    await service.provisionCellForBusiness(businessId);

    await expect(
      service.upgradeCell(businessId, 'ghcr.io/openclaw/openclaw:latest', '2026.9.1'),
    ).rejects.toThrow(/digest-pinned/);
    await expect(
      service.upgradeCell(businessId, 'ghcr.io/openclaw/openclaw:2026.9.1', '2026.9.1'),
    ).rejects.toThrow(/digest-pinned/);
    expect(runtime.upgrade).not.toHaveBeenCalled();
  });

  it('removeCellForBusiness is idempotent and no-ops for a business with no cell', async () => {
    const otherBusinessId = await createTestBusiness('No Cell Business');
    await expect(service.removeCellForBusiness(otherBusinessId, { purgeData: false })).resolves.toBeUndefined();
    expect(runtime.remove).not.toHaveBeenCalled();
  });
});

/**
 * Gateway token encrypted-at-rest guarantees, tested directly against the
 * repository - same discipline `integrationSettings.test.ts` uses for
 * `business_email_settings`/`business_goose_settings`: the property that
 * matters is a real, raw column value that never contains the plaintext.
 */
describe('OpenClawCellRepository - Gateway token encryption at rest', () => {
  let businessId: string;
  const repo = new OpenClawCellRepository(pool);
  const cellId = 'wc-encryptiontest';

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Gateway Token Tenant');
    await repo.create({
      businessId,
      cellId,
      deploymentVersion: '2026.7.1-2',
      imageDigest: 'ghcr.io/openclaw/openclaw@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac',
    });
  });

  it('stores the Gateway token encrypted, never as plaintext in the column', async () => {
    await repo.setGatewayToken(businessId, 'a-real-looking-gateway-token-value');

    const { rows } = await pool.query<{ gateway_token_encrypted: string | null }>(
      'SELECT gateway_token_encrypted FROM openclaw_cells WHERE business_id = $1',
      [businessId],
    );
    const stored = rows[0]?.gateway_token_encrypted ?? '';

    expect(stored).not.toContain('a-real-looking-gateway-token-value');
    expect(stored.length).toBeGreaterThan(0);
    expect(await repo.getGatewayToken(businessId)).toBe('a-real-looking-gateway-token-value');
  });

  it('hasGatewayToken reports presence without ever decrypting', async () => {
    expect(await repo.hasGatewayToken(businessId)).toBe(false);
    await repo.setGatewayToken(businessId, 'another-token');
    expect(await repo.hasGatewayToken(businessId)).toBe(true);
  });

  it('getGatewayToken returns null when nothing has been stored', async () => {
    expect(await repo.getGatewayToken(businessId)).toBeNull();
  });

  it('the ordinary record shape (findByBusinessId/listAll) never carries the token, encrypted or not', async () => {
    await repo.setGatewayToken(businessId, 'should-never-appear-here');

    const record = await repo.findByBusinessId(businessId);
    expect(JSON.stringify(record)).not.toContain('should-never-appear-here');
    expect(record).not.toHaveProperty('gatewayToken');
    expect(record).not.toHaveProperty('gatewayTokenEncrypted');

    const all = await repo.listAll();
    expect(JSON.stringify(all)).not.toContain('should-never-appear-here');
  });
});
