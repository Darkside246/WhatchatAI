import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import path from 'node:path';
import type { OpenClawCellRuntime, CellCreateResult, CellStatus } from './openclawCellRuntime.js';

const execFileAsync = promisify(execFile);

const DOCKER_TIMEOUT_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** Root host directory for per-cell state - mirrors the existing WHATSAPP_SESSION_DIR/MEDIA_STORAGE_DIR env-var convention already used in this codebase. */
function stateRootDir(): string {
  return process.env.OPENCLAW_CELL_STATE_DIR ?? path.join(process.cwd(), 'data', 'openclaw-cells');
}

function containerName(cellId: string): string {
  return `openclaw-cell-${cellId}`;
}

function networkName(cellId: string): string {
  return `openclaw-cell-net-${cellId}`;
}

function describeExecError(error: unknown): string {
  const err = error as { stderr?: string; message?: string };
  const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
  const message = stderr.length > 0 ? stderr : (err.message ?? String(error));
  return message.slice(0, 500);
}

async function docker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, { timeout: timeoutMs });
  return stdout;
}

/** A free host port, found by asking the OS for an ephemeral one and releasing it immediately - the same class of TOCTOU race Fleet's own automatic port allocation has, not a new one introduced here. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine an ephemeral port')));
      }
    });
    server.on('error', reject);
  });
}

/**
 * Health checking runs *inside* the container's own network namespace via
 * `docker exec`, not as a host-side request against the published port.
 * Confirmed by real evidence (2026-08-22): a cell's `--internal` network
 * blocks host-side reachability of `--publish`ed ports entirely (Docker
 * excludes internal networks from the NAT/forwarding plumbing publishing
 * depends on), even though the Gateway process itself boots cleanly and
 * answers `/healthz` fine from inside its own namespace. `docker exec`
 * never crosses that network boundary at all, so it's unaffected by it.
 */
async function execHealthCheck(cellId: string): Promise<boolean> {
  try {
    const stdout = await docker(
      ['exec', containerName(cellId), 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '5', 'http://127.0.0.1:18789/healthz'],
      HEALTH_CHECK_TIMEOUT_MS + 2_000,
    );
    return stdout.trim() === '200';
  } catch {
    return false;
  }
}

async function waitForHealthy(cellId: string, deadlineMs: number, pollIntervalMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await execHealthCheck(cellId)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

/**
 * Real per-tenant OpenClaw isolation built directly on Docker, since
 * `openclaw fleet` (which was going to automate exactly this) does not
 * exist in any released stable OpenClaw version - see
 * `openclawCellRuntime.ts`'s own doc comment and this session's
 * CHANGELOG_SECURITY.md entry for the full verification trail.
 *
 * Replicates the real, sourced hardening profile documented for Fleet's
 * own (unreleased) cells - `--cap-drop=ALL`, `--security-opt
 * no-new-privileges`, `--init`, `--pids-limit 512`, `--memory 2g`,
 * `--cpus 2`, read-only rootfs with a `/tmp` tmpfs, one dedicated bridge
 * network per cell, and loopback-only host port publishing - since those
 * values were independently sourced from real OpenClaw documentation
 * (`docs/cli/fleet.md`), not invented for this implementation.
 *
 * The container's own command line
 * (`node dist/index.js gateway --bind lan --port 18789`) is likewise
 * taken directly from that same real source. The additional flags this
 * implementation appends (`--auth token`, `--allow-unconfigured`) come
 * from the real, verified `openclaw gateway --help` output.
 *
 * Real-runtime verified (2026-08-22, see CHANGELOG_SECURITY.md for the
 * full raw evidence trail): auth enforcement, hardening profile, resource
 * limits, restart lifecycle, general-internet egress blocking, and
 * cross-cell network isolation are all confirmed against a live
 * container. Two design iterations came out of that verification, not
 * assumed correct on the first attempt: the restart health-check budget
 * had to be widened to match `create()`'s, and health checking itself
 * had to move from a host-side request against the published port to
 * `docker exec`-based checking, once real evidence showed `--internal`
 * blocks host reachability of published ports entirely (see
 * `execHealthCheck` below).
 */
export class DockerCellRuntime implements OpenClawCellRuntime {
  readonly name = 'docker';

  constructor(
    private readonly healthCheckDeadlineMs = 60_000,
    private readonly healthCheckPollIntervalMs = 1_000,
  ) {}

  /**
   * `--internal` is Docker's own primitive for "no default route to the
   * outside world" - the daemon never wires up outbound NAT/masquerade
   * for this network, so a container attached only to it cannot reach
   * the general internet at all. This is the actual fix for the
   * "minimal outbound access" requirement from the original hardening
   * list, which the first Docker implementation never wired up. Real
   * cross-network isolation (that one cell's network truly cannot reach
   * another cell's) is a well-documented property of separate
   * user-defined Docker bridge networks, but - like everything else in
   * this file - is only a real property once confirmed against a real
   * daemon, not assumed from documentation alone.
   */
  private async ensureNetwork(cellId: string): Promise<void> {
    try {
      await docker(['network', 'inspect', networkName(cellId)]);
    } catch {
      await docker(['network', 'create', '--driver', 'bridge', '--internal', networkName(cellId)]);
    }
  }

  private buildRunArgs(cellId: string, image: string, env: Record<string, string>, port: number): string[] {
    const stateDir = path.join(stateRootDir(), cellId);
    const args = [
      'run',
      '-d',
      '--name', containerName(cellId),
      '--label', `whatchatai.openclaw.cell=${cellId}`,
      '--user', '1000:1000',
      '--read-only',
      '--tmpfs', '/tmp',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--init',
      '--pids-limit', '512',
      '--memory', '2g',
      '--cpus', '2',
      '--network', networkName(cellId),
      // Loopback-only, and NOT currently reachable from the host at all -
      // Docker's `--internal` flag excludes this network from the
      // NAT/forwarding plumbing `--publish` depends on (real, confirmed
      // finding, not a theoretical concern). Kept deliberately anyway,
      // reserved for a possible future authenticated host<->cell Gateway
      // transport, not because anything uses it today - health checking
      // does not depend on it (see `execHealthCheck` below). Treat
      // `gatewayEndpoint`/`port` on `CellCreateResult` as transport
      // metadata describing where that future path would go, not as a
      // live, currently-reachable endpoint.
      '--publish', `127.0.0.1:${port}:18789`,
      // The one exception to the network's own `--internal` blackhole:
      // this lets the cell resolve/reach the Docker host machine (where
      // WhatchatAI's own Tool Gateway/adapter listens), via a name Docker
      // resolves locally rather than a real DNS lookup - it costs nothing
      // in outbound reachability elsewhere. NOTE: this currently makes
      // the whole host reachable on whatever ports the host has open, not
      // narrowed to the Tool Gateway's own port specifically - a real,
      // tracked remaining gap, not silently treated as fully closed.
      '--add-host', 'host.docker.internal:host-gateway',
      '--mount', `type=bind,source=${stateDir},target=/home/node/.openclaw`,
      '--restart', 'unless-stopped',
      '-e', 'HOME=/home/node',
      '-e', 'OPENCLAW_STATE_DIR=/home/node/.openclaw',
    ];
    for (const [key, value] of Object.entries(env)) {
      args.push('-e', `${key}=${value}`);
    }
    args.push(image);
    args.push('node', 'dist/index.js', 'gateway', '--bind', 'lan', '--port', '18789', '--auth', 'token', '--allow-unconfigured');
    return args;
  }

  async create(cellId: string, image: string, env: Record<string, string>): Promise<CellCreateResult> {
    await this.ensureNetwork(cellId);
    const port = await findFreePort();

    let containerId: string;
    try {
      const stdout = await docker(this.buildRunArgs(cellId, image, env, port));
      containerId = stdout.trim();
    } catch (error) {
      throw new Error(`docker run for cell ${cellId} failed: ${describeExecError(error)}`);
    }

    const healthy = await waitForHealthy(cellId, this.healthCheckDeadlineMs, this.healthCheckPollIntervalMs);
    if (!healthy) {
      throw new Error(`Cell ${cellId} did not become healthy within ${this.healthCheckDeadlineMs}ms of starting (container ${containerId})`);
    }

    return { containerId, gatewayEndpoint: `http://127.0.0.1:${port}`, port };
  }

  async status(cellId: string): Promise<CellStatus> {
    let running: boolean;
    try {
      const stdout = await docker(['inspect', '--format', '{{.State.Running}}', containerName(cellId)]);
      running = stdout.trim() === 'true';
    } catch {
      return { state: 'unknown', healthy: false };
    }
    if (!running) return { state: 'stopped', healthy: false };

    // A routine status check on an already-running cell only needs to confirm
    // it's still answering right now, so this stays capped short rather than
    // using the full restart budget below.
    const healthy = await waitForHealthy(cellId, Math.min(5_000, this.healthCheckDeadlineMs), this.healthCheckPollIntervalMs);
    return { state: 'running', healthy };
  }

  async stop(cellId: string): Promise<void> {
    try {
      await docker(['stop', containerName(cellId)]);
    } catch (error) {
      throw new Error(`docker stop for cell ${cellId} failed: ${describeExecError(error)}`);
    }
  }

  /**
   * Restarting a stopped cell means it needs the same full boot budget as
   * `create()` - plugin load + channel/sidecar startup genuinely takes
   * several seconds (confirmed against a real container: consistently
   * 5.1-5.8s to `ready`, 3/3 runs). Polling this directly with the same
   * `healthCheckDeadlineMs`/`healthCheckPollIntervalMs` this instance
   * already uses for `create()`, rather than delegating to `status()`'s
   * short routine-check cap, is what actually fixes the mismatch.
   */
  async start(cellId: string): Promise<void> {
    try {
      await docker(['start', containerName(cellId)]);
    } catch (error) {
      throw new Error(`docker start for cell ${cellId} failed: ${describeExecError(error)}`);
    }
    const healthy = await waitForHealthy(cellId, this.healthCheckDeadlineMs, this.healthCheckPollIntervalMs);
    if (!healthy) {
      throw new Error(`Cell ${cellId} did not report healthy within ${this.healthCheckDeadlineMs}ms of restarting`);
    }
  }

  /**
   * Health-gated replace, matching the same contract Fleet's own
   * (unreleased) upgrade documented: stop and remove the old container,
   * create the new one, and only commit to the replacement once it's
   * genuinely healthy - a replacement that never becomes healthy leaves
   * the old container's state directory untouched (state lives on the
   * host bind mount, not in the removed container) so a human can
   * recreate it.
   */
  async upgrade(cellId: string, image: string): Promise<CellCreateResult> {
    let previousEnv: Record<string, string> = {};
    try {
      const stdout = await docker(['inspect', '--format', '{{json .Config.Env}}', containerName(cellId)]);
      const envList = JSON.parse(stdout.trim()) as string[];
      for (const entry of envList) {
        const idx = entry.indexOf('=');
        if (idx > 0) previousEnv[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
    } catch (error) {
      throw new Error(`Could not read existing environment for cell ${cellId} before upgrade: ${describeExecError(error)}`);
    }

    await docker(['stop', containerName(cellId)]).catch(() => undefined);
    await docker(['rm', containerName(cellId)]).catch(() => undefined);

    return this.create(cellId, image, previousEnv);
  }

  async remove(cellId: string, options: { purgeData: boolean }): Promise<void> {
    await docker(['rm', '--force', containerName(cellId)]).catch(() => undefined);
    await docker(['network', 'rm', networkName(cellId)]).catch(() => undefined);
    if (options.purgeData) {
      // Deliberately not implemented here as an `rm -rf` shelled out from
      // this process - deleting a host directory by string-built path is
      // exactly the kind of operation that deserves the same containment
      // checks Fleet's own docs describe (resolve the real path, confirm
      // it's the exact expected tenant leaf, never a symlink) rather than
      // a quick fs.rm call. Left as an explicit gap: purge is a no-op for
      // now, tracked as follow-up work, not silently "done."
      console.warn(`[DockerCellRuntime] purgeData requested for cell ${cellId} but state-directory purge is not yet implemented - state remains on disk`);
    }
  }
}
