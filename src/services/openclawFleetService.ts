import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pool } from '../db/pool.js';
import {
  OpenClawFleetCellRepository,
  type OpenClawFleetCellRecord,
  type FleetCellState,
} from '../repositories/openclawFleetCellRepository.js';
import { generateCallbackToken, hashCallbackToken } from './openclawCallbackTokenService.js';

const execFileAsync = promisify(execFile);

/**
 * OpenClaw's own documented tenant-ID grammar (docs/cli/fleet.md,
 * verified directly against the openclaw/openclaw repo): 1-40 lowercase
 * letters/digits/internal hyphens, must start and end with a letter or
 * digit. Anything that doesn't match this is never passed to the CLI -
 * this is the one thing standing between a business's own ID and shell
 * argument injection into a real `openclaw` process.
 */
const TENANT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * The pinned OpenClaw image for every Fleet cell this platform creates.
 *
 * Obtained directly from the real GHCR registry API on 2026-08-21 (token
 * exchange + manifest HEAD against ghcr.io/v2/openclaw/openclaw) - never
 * invented, per the standing instruction that a digest must come from the
 * actual registry during implementation. `2026.7.1-2` was the newest
 * published, non-beta, non-architecture-specific stable tag at that time;
 * the openclaw/openclaw repository's own HEAD was already on `2026.8.1`,
 * but only `2026.8.1-beta.1`/`-beta.2` had been pushed to the registry -
 * a beta build is not what "pin a production version" means here, so
 * `2026.7.1-2` was used instead. Re-verify against the registry (not this
 * constant) before ever bumping this - see fleet.md's "Pinning by digest"
 * section for the `--image ref@sha256:<digest>` syntax this relies on.
 */
export const OPENCLAW_PINNED_VERSION = '2026.7.1-2';
export const OPENCLAW_PINNED_IMAGE =
  'ghcr.io/openclaw/openclaw@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac';

/** `fleet create`'s own health gate is documented as "up to about a minute" - this leaves real margin. */
const FLEET_CREATE_TIMEOUT_MS = 120_000;
const FLEET_UPGRADE_TIMEOUT_MS = 120_000;
const FLEET_CLI_TIMEOUT_MS = 30_000;

export function validateFleetTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(`"${tenantId}" is not a valid OpenClaw Fleet tenant ID (must match ${TENANT_ID_PATTERN.source})`);
  }
}

/**
 * Derives a stable, deterministic Fleet tenant ID from a business's own
 * UUID - never from user-controlled free text (a business name, a slug a
 * tenant could pick), so there is nothing here for a tenant to craft into
 * a CLI-argument-injection or path-traversal attempt. Always re-validated
 * against OpenClaw's own grammar before use regardless.
 */
export function fleetCellIdForBusiness(businessId: string): string {
  const id = `wc-${businessId.replace(/-/g, '').toLowerCase()}`.slice(0, 40);
  validateFleetTenantId(id);
  return id;
}

function describeExecError(error: unknown): string {
  const err = error as { stderr?: string; message?: string; code?: string | number };
  const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
  const message = stderr.length > 0 ? stderr : (err.message ?? String(error));
  return message.slice(0, 500);
}

async function runFleetCli(args: string[], timeoutMs = FLEET_CLI_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('openclaw', ['fleet', ...args], { timeout: timeoutMs });
  return stdout;
}

/**
 * Parses `--json` output defensively - Fleet is documented as
 * experimental with output shapes that "can change between releases
 * without a deprecation window," so every field read from it is
 * optional. Deliberately never echoes the raw stdout back into a thrown
 * error: a `fleet create` result is secret-bearing (it carries the
 * generated Gateway token) per fleet.md, so no code path here should risk
 * putting that into a log or error message.
 */
function parseFleetJson<T>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error('Fleet CLI returned output that was not valid JSON (command may have printed a warning before the JSON body)');
  }
}

interface FleetCreateJson {
  tenant?: string;
  containerName?: string;
  port?: number;
  gatewayToken?: string;
  url?: string;
}

interface FleetStatusJson {
  tenant?: string;
  state?: string;
  port?: number;
  image?: string;
  health?: 'ok' | 'failed' | 'skipped' | string;
}

/** Maps Fleet's own free-form container state + healthz result onto our fixed cell_state enum, conservatively. */
function mapStatusToCellState(status: FleetStatusJson): FleetCellState {
  const state = (status.state ?? '').toLowerCase();
  if (state === 'running' && status.health === 'ok') return 'RUNNING';
  if (state === 'running') return 'UNHEALTHY';
  if (state === 'exited' || state === 'stopped' || state === 'created') return 'STOPPED';
  return 'UNHEALTHY';
}

export interface FleetCellProvisionResult {
  cell: OpenClawFleetCellRecord;
  /**
   * The Gateway token Fleet generated for this cell, returned exactly
   * once - matching Fleet's own "shown once" create behavior. Never
   * persisted by this service (the mapping table intentionally has no
   * token column - see the migration's comment); the caller is
   * responsible for real encrypted secret storage before this token is
   * needed again. Null on an idempotent no-op (the cell already existed).
   */
  gatewayToken: string | null;
  /**
   * The credential this cell must present (as a Bearer token) when
   * calling into WhatchatAI's own Tool Gateway adapter - the opposite
   * direction from `gatewayToken` above. Returned exactly once, same as
   * Fleet's own token; only its SHA-256 hash is ever persisted (see
   * `openclawCallbackTokenService.ts`). Null on an idempotent no-op.
   */
  callbackToken: string | null;
}

/**
 * Fleet lifecycle wiring for the finalized one-cell-per-tenant OpenClaw
 * architecture. Every operation shells out to the real `openclaw fleet`
 * CLI via execFile (argument array, never a shell string) - this service
 * never manually creates, inspects, or removes a container directly, per
 * the standing instruction that Fleet is the only supported lifecycle
 * mechanism.
 *
 * NOT verified against a real Fleet/Docker daemon in this environment:
 * this sandbox cannot pull container images (a constraint hit repeatedly
 * since Phase 1 of this engagement) or install/run the `openclaw` binary,
 * so every CLI-invoking method here is covered by tests that mock
 * execFile, not by a real `fleet create` run. Treat this as
 * IMPLEMENTED BUT NOT FULLY VERIFIED until it is exercised against a real
 * Docker/Podman host with the real `openclaw` CLI installed.
 */
export class OpenClawFleetService {
  constructor(private readonly repo: OpenClawFleetCellRepository = new OpenClawFleetCellRepository(pool)) {}

  /** Idempotent: an existing cell is returned as-is rather than attempting a second `fleet create`. */
  async provisionCellForBusiness(businessId: string): Promise<FleetCellProvisionResult> {
    const existing = await this.repo.findByBusinessId(businessId);
    if (existing) return { cell: existing, gatewayToken: null, callbackToken: null };

    const fleetCellId = fleetCellIdForBusiness(businessId);
    // Generated before the CLI call so it can be injected into the cell's
    // own environment at creation time - the cell needs this value to
    // ever call the Tool Gateway adapter back, so it must be minted
    // before the container exists, not after.
    const callbackToken = generateCallbackToken();

    let stdout: string;
    try {
      stdout = await runFleetCli(
        ['create', fleetCellId, '--image', OPENCLAW_PINNED_IMAGE, '--env', `OPENCLAW_CALLBACK_TOKEN=${callbackToken}`, '--json'],
        FLEET_CREATE_TIMEOUT_MS,
      );
    } catch (error) {
      throw new Error(`openclaw fleet create ${fleetCellId} failed: ${describeExecError(error)}`);
    }

    const parsed = parseFleetJson<FleetCreateJson>(stdout);
    const gatewayEndpoint = parsed.url ?? (parsed.port ? `http://127.0.0.1:${parsed.port}` : null);

    const cell = await this.repo.create({
      businessId,
      fleetCellId,
      deploymentVersion: OPENCLAW_PINNED_VERSION,
      imageDigest: OPENCLAW_PINNED_IMAGE,
      gatewayEndpoint,
    });
    await this.repo.updateCellState(businessId, 'RUNNING');
    await this.repo.setCallbackTokenHash(businessId, hashCallbackToken(callbackToken));

    return { cell: { ...cell, cellState: 'RUNNING' }, gatewayToken: parsed.gatewayToken ?? null, callbackToken };
  }

  /** Real liveness check via `fleet status --json`, never assumed - updates the persisted cell_state from what Fleet actually reports. */
  async checkHealth(businessId: string): Promise<OpenClawFleetCellRecord | null> {
    const existing = await this.repo.findByBusinessId(businessId);
    if (!existing) return null;

    let stdout: string;
    try {
      stdout = await runFleetCli(['status', existing.fleetCellId, '--json']);
    } catch (error) {
      await this.repo.recordHealthCheck(businessId, 'UNHEALTHY');
      throw new Error(`openclaw fleet status ${existing.fleetCellId} failed: ${describeExecError(error)}`);
    }

    const status = parseFleetJson<FleetStatusJson>(stdout);
    const cellState = mapStatusToCellState(status);
    await this.repo.recordHealthCheck(businessId, cellState);
    return this.repo.findByBusinessId(businessId);
  }

  async stopCell(businessId: string): Promise<void> {
    const existing = await this.repo.findByBusinessId(businessId);
    if (!existing) return;
    if (existing.cellState === 'STOPPED') return; // idempotent

    try {
      await runFleetCli(['stop', existing.fleetCellId]);
    } catch (error) {
      throw new Error(`openclaw fleet stop ${existing.fleetCellId} failed: ${describeExecError(error)}`);
    }
    await this.repo.updateCellState(businessId, 'STOPPED');
  }

  async startCell(businessId: string): Promise<void> {
    const existing = await this.repo.findByBusinessId(businessId);
    if (!existing) return;
    if (existing.cellState === 'RUNNING') return; // idempotent

    try {
      await runFleetCli(['start', existing.fleetCellId]);
    } catch (error) {
      throw new Error(`openclaw fleet start ${existing.fleetCellId} failed: ${describeExecError(error)}`);
    }
    await this.repo.updateCellState(businessId, 'RUNNING');
  }

  /**
   * Moves a cell to a new pinned image. Deliberately requires an explicit
   * digest-pinned reference from the caller - this method never applies
   * `OPENCLAW_PINNED_IMAGE` implicitly, so an upgrade is always a
   * conscious decision (Review -> Test -> Security regression -> Approve
   * -> this call -> Health verification), never something that happens
   * because a constant changed.
   */
  async upgradeCell(businessId: string, imageRef: string, deploymentVersion: string): Promise<void> {
    if (imageRef.includes(':latest') || !imageRef.includes('@sha256:')) {
      throw new Error(`Refusing to upgrade to "${imageRef}": OpenClaw Fleet cells must be upgraded to a digest-pinned reference, never a moving tag.`);
    }
    const existing = await this.repo.findByBusinessId(businessId);
    if (!existing) throw new Error(`No Fleet cell registered for business ${businessId}`);

    try {
      await runFleetCli(['upgrade', existing.fleetCellId, '--image', imageRef], FLEET_UPGRADE_TIMEOUT_MS);
    } catch (error) {
      throw new Error(`openclaw fleet upgrade ${existing.fleetCellId} failed: ${describeExecError(error)}`);
    }
    await this.repo.recordUpgrade(businessId, deploymentVersion, imageRef);
  }

  /**
   * The Security Watcher's enforcement action for a CRITICAL finding.
   * Actually stops the cell via Fleet (not just a DB flag) so
   * "quarantined cells must not process new AI requests" is true even
   * before the Tool Gateway itself checks security_status - defense in
   * depth, not a substitute for that gateway check once it exists.
   */
  async quarantineCell(businessId: string, reason: string): Promise<void> {
    const existing = await this.repo.findByBusinessId(businessId);
    if (!existing) return;

    if (existing.cellState !== 'STOPPED') {
      try {
        await runFleetCli(['stop', existing.fleetCellId]);
        await this.repo.updateCellState(businessId, 'STOPPED');
      } catch (error) {
        // A quarantine decision must still be recorded even if Fleet/Docker
        // itself is unreachable right now - fail closed on the security
        // status, but don't lose the quarantine intent because a stop
        // command happened to fail.
        console.error(`[openclawFleetService] fleet stop during quarantine of ${existing.fleetCellId} failed: ${describeExecError(error)}`);
      }
    }
    await this.repo.quarantine(businessId, reason);
  }

  /**
   * Clears the quarantine flag only - deliberately does NOT restart the
   * cell. Restarting is a separate, explicit `startCell` call an operator
   * makes after real remediation, matching the non-auto-upgrade review
   * flow this directive requires.
   */
  async clearQuarantine(businessId: string): Promise<void> {
    await this.repo.clearQuarantine(businessId);
  }

  async removeCellForBusiness(businessId: string, options: { purgeData: boolean }): Promise<void> {
    const existing = await this.repo.findByBusinessId(businessId);
    if (!existing) return; // idempotent

    const args = ['rm', existing.fleetCellId, '--force'];
    if (options.purgeData) args.push('--purge-data');

    try {
      await runFleetCli(args);
    } catch (error) {
      throw new Error(`openclaw fleet rm ${existing.fleetCellId} failed: ${describeExecError(error)}`);
    }
    await this.repo.remove(businessId);
  }
}

export const openclawFleetService = new OpenClawFleetService();
