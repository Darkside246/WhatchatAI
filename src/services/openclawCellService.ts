import { pool } from '../db/pool.js';
import { OpenClawCellRepository, type OpenClawCellRecord } from '../repositories/openclawCellRepository.js';
import { generateCallbackToken, hashCallbackToken } from './openclawCallbackTokenService.js';
import { DockerCellRuntime } from './dockerCellRuntime.js';
import type { OpenClawCellRuntime } from './openclawCellRuntime.js';

/**
 * OpenClaw's own documented tenant-ID grammar, taken from the same real
 * source (`docs/cli/fleet.md`) the rest of this pinned-version/naming
 * scheme came from - kept even though we no longer call `fleet` directly
 * (see this file's own class doc comment): 1-40 lowercase letters/
 * digits/internal hyphens, must start and end with a letter or digit.
 * Still the right validation for a Docker container/network name
 * component, which is exactly what `cellId` becomes now.
 */
const CELL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * The pinned OpenClaw image for every cell this platform creates.
 *
 * Obtained directly from the real GHCR registry API on 2026-08-21 (token
 * exchange + manifest HEAD against ghcr.io/v2/openclaw/openclaw) - never
 * invented. `2026.7.1-2` is the newest published, non-beta stable tag -
 * independently reconfirmed on 2026-08-22 via `npm view openclaw`
 * against the real npm registry (`latest: 2026.7.1-2`, `beta:
 * 2026.8.1-beta.2`), and via a real `docker pull` + `docker inspect`
 * against this exact digest on a real machine. Re-verify against the
 * registry (not this constant) before ever bumping this.
 */
export const OPENCLAW_PINNED_VERSION = '2026.7.1-2';
export const OPENCLAW_PINNED_IMAGE =
  'ghcr.io/openclaw/openclaw@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac';

export function validateCellId(cellId: string): void {
  if (!CELL_ID_PATTERN.test(cellId)) {
    throw new Error(`"${cellId}" is not a valid OpenClaw cell ID (must match ${CELL_ID_PATTERN.source})`);
  }
}

/**
 * Derives a stable, deterministic cell ID from a business's own UUID -
 * never from user-controlled free text, so there is nothing here for a
 * tenant to craft into a container/network-naming or path-traversal
 * attempt. Always re-validated against the pattern above regardless.
 */
export function cellIdForBusiness(businessId: string): string {
  const id = `wc-${businessId.replace(/-/g, '').toLowerCase()}`.slice(0, 40);
  validateCellId(id);
  return id;
}

export interface CellProvisionResult {
  cell: OpenClawCellRecord;
  /**
   * The Gateway token this service generated for the cell (previously
   * Fleet's own job). Persisted encrypted via `OpenClawCellRepository
   * .setGatewayToken` (AES-256-GCM envelope, same mechanism as every
   * other tenant secret in this codebase) - but still returned here in
   * plaintext exactly once, at the moment of provisioning, the same
   * "shown once" pattern the callback token already used. No route or
   * record read after this point ever exposes it again; retrieving it
   * later requires the explicit, narrow `repo.getGatewayToken` call.
   */
  gatewayToken: string | null;
  /** The credential this cell must present when calling into AURA's own Tool Gateway adapter - see openclawCallbackTokenService.ts. Null on an idempotent no-op. */
  callbackToken: string | null;
}

/**
 * Real per-tenant OpenClaw cell lifecycle, backed by `OpenClawCellRuntime`
 * (defaulting to `DockerCellRuntime`). Renamed from `OpenClawFleetService`
 * - real-environment verification on 2026-08-22 found `openclaw fleet`
 * does not exist in the stable, pinned OpenClaw release: `openclaw fleet
 * --help` on a real installed `openclaw@2026.7.1-2` returned "Unknown
 * command: openclaw fleet," and the CLI's real top-level command list
 * (`agent, agents, approvals, audit, channels, config, configure, cron,
 * daemon, dashboard, doctor, gateway, health, mcp, nodes, sandbox,
 * security, status`) confirms it. Fleet is real, but unreleased -
 * `docs/cli/fleet.md` was read from the openclaw/openclaw repo's `main`
 * branch, which was already ahead on the still-beta `2026.8.1` line.
 * Keeping the old name/architecture would have meant pretending a CLI
 * wrapper works when the command it wraps doesn't exist - see
 * `openclawCellRuntime.ts`'s own doc comment for the resulting design.
 *
 * This class itself is now runtime-agnostic: it owns the DB-facing
 * responsibilities (idempotent provisioning, digest-pin enforcement on
 * upgrade, quarantine, callback-token issuance) and delegates the actual
 * container lifecycle to whichever `OpenClawCellRuntime` it's given.
 */
export class OpenClawCellService {
  constructor(
    private readonly repo: OpenClawCellRepository = new OpenClawCellRepository(pool),
    private readonly runtime: OpenClawCellRuntime = new DockerCellRuntime(),
  ) {}

  /** Idempotent: an existing cell is returned as-is rather than attempting a second create. */
  async provisionCellForBusiness(businessId: string): Promise<CellProvisionResult> {
    const existing = await this.repo.findByBusinessId(businessId);
    if (existing) return { cell: existing, gatewayToken: null, callbackToken: null };

    const cellId = cellIdForBusiness(businessId);
    const gatewayToken = generateCallbackToken(); // same generation shape, different credential - see CellProvisionResult's doc comment
    const callbackToken = generateCallbackToken();

    const result = await this.runtime.create(cellId, OPENCLAW_PINNED_IMAGE, {
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      OPENCLAW_CALLBACK_TOKEN: callbackToken,
    });

    const cell = await this.repo.create({
      businessId,
      cellId,
      deploymentVersion: OPENCLAW_PINNED_VERSION,
      imageDigest: OPENCLAW_PINNED_IMAGE,
      gatewayEndpoint: result.gatewayEndpoint,
    });
    await this.repo.updateCellState(businessId, 'RUNNING');
    await this.repo.setCallbackTokenHash(businessId, hashCallbackToken(callbackToken));
    await this.repo.setGatewayToken(businessId, gatewayToken);

    return { cell: { ...cell, cellState: 'RUNNING' }, gatewayToken, callbackToken };
  }

  /** Real liveness check via the runtime, never assumed - updates the persisted cell_state from what was actually observed. */
  async checkHealth(businessId: string): Promise<OpenClawCellRecord | null> {
    const existing = await this.repo.findByBusinessId(businessId);
    if (!existing) return null;

    const status = await this.runtime.status(existing.cellId);
    const cellState = status.state === 'running' ? (status.healthy ? 'RUNNING' : 'UNHEALTHY') : status.state === 'stopped' ? 'STOPPED' : 'UNHEALTHY';
    await this.repo.recordHealthCheck(businessId, cellState);
    return this.repo.findByBusinessId(businessId);
  }

  async stopCell(businessId: string): Promise<void> {
    const existing = await this.repo.findByBusinessId(businessId);
    if (!existing) return;
    if (existing.cellState === 'STOPPED') return; // idempotent

    await this.runtime.stop(existing.cellId);
    await this.repo.updateCellState(businessId, 'STOPPED');
  }

  async startCell(businessId: string): Promise<void> {
    const existing = await this.repo.findByBusinessId(businessId);
    if (!existing) return;
    if (existing.cellState === 'RUNNING') return; // idempotent

    await this.runtime.start(existing.cellId);
    await this.repo.updateCellState(businessId, 'RUNNING');
  }

  /**
   * Moves a cell to a new pinned image. Deliberately requires an explicit
   * digest-pinned reference from the caller - never applies
   * `OPENCLAW_PINNED_IMAGE` implicitly, so an upgrade is always a
   * conscious decision (Review -> Test -> Security regression -> Approve
   * -> this call -> Health verification), never something that happens
   * because a constant changed.
   */
  async upgradeCell(businessId: string, imageRef: string, deploymentVersion: string): Promise<void> {
    if (imageRef.includes(':latest') || !imageRef.includes('@sha256:')) {
      throw new Error(`Refusing to upgrade to "${imageRef}": OpenClaw cells must be upgraded to a digest-pinned reference, never a moving tag.`);
    }
    const existing = await this.repo.findByBusinessId(businessId);
    if (!existing) throw new Error(`No cell registered for business ${businessId}`);

    await this.runtime.upgrade(existing.cellId, imageRef);
    await this.repo.recordUpgrade(businessId, deploymentVersion, imageRef);
  }

  /**
   * The Security Watcher's enforcement action for a CRITICAL finding.
   * Actually stops the cell (not just a DB flag) so "quarantined cells
   * must not process new AI requests" is true even before the Tool
   * Gateway itself checks security_status - defense in depth, not a
   * substitute for that gateway check.
   */
  async quarantineCell(businessId: string, reason: string): Promise<void> {
    const existing = await this.repo.findByBusinessId(businessId);
    if (!existing) return;

    if (existing.cellState !== 'STOPPED') {
      try {
        await this.runtime.stop(existing.cellId);
        await this.repo.updateCellState(businessId, 'STOPPED');
      } catch (error) {
        // A quarantine decision must still be recorded even if the
        // runtime itself is unreachable right now - fail closed on the
        // security status, but don't lose the quarantine intent because
        // a stop command happened to fail.
        console.error(`[openclawCellService] stop during quarantine of ${existing.cellId} failed:`, error);
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

    await this.runtime.remove(existing.cellId, options);
    await this.repo.remove(businessId);
  }
}

export const openclawCellService = new OpenClawCellService();
