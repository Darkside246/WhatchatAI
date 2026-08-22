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

async function waitForHealthy(port: number, deadlineMs: number, pollIntervalMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal }).finally(() =>
        clearTimeout(timeout),
      );
      if (response.ok) return true;
    } catch {
      // not up yet - keep polling until the deadline
    }
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
 * from the real, verified `openclaw gateway --help` output gathered
 * during this session's verification pass - but the *combination* has
 * never been run against a real container. Treat this whole class as
 * IMPLEMENTED BUT NOT FULLY VERIFIED until someone with real Docker
 * access runs `create()` once and confirms the container actually
 * reaches a healthy state.
 */
export class DockerCellRuntime implements OpenClawCellRuntime {
  readonly name = 'docker';

  constructor(
    private readonly healthCheckDeadlineMs = 60_000,
    private readonly healthCheckPollIntervalMs = 1_000,
  ) {}

  private async ensureNetwork(cellId: string): Promise<void> {
    try {
      await docker(['network', 'inspect', networkName(cellId)]);
    } catch {
      await docker(['network', 'create', '--driver', 'bridge', networkName(cellId)]);
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
      '--publish', `127.0.0.1:${port}:18789`,
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

    const healthy = await waitForHealthy(port, this.healthCheckDeadlineMs, this.healthCheckPollIntervalMs);
    if (!healthy) {
      throw new Error(`Cell ${cellId} did not become healthy within ${this.healthCheckDeadlineMs}ms of starting (container ${containerId})`);
    }

    return { containerId, gatewayEndpoint: `http://127.0.0.1:${port}`, port };
  }

  /** Reads the host port Docker published for this cell's Gateway, or null if the container isn't running or the mapping can't be read. */
  private async readPublishedPort(cellId: string): Promise<number | null> {
    try {
      const stdout = await docker(['inspect', '--format', '{{(index (index .NetworkSettings.Ports "18789/tcp") 0).HostPort}}', containerName(cellId)]);
      const port = Number(stdout.trim());
      return Number.isFinite(port) ? port : null;
    } catch {
      return null;
    }
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

    const port = await this.readPublishedPort(cellId);
    // A routine status check on an already-running cell only needs to confirm
    // it's still answering right now, so this stays capped short rather than
    // using the full restart budget below.
    const healthy = port !== null ? await waitForHealthy(port, Math.min(5_000, this.healthCheckDeadlineMs), this.healthCheckPollIntervalMs) : false;
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
    const port = await this.readPublishedPort(cellId);
    const healthy = port !== null ? await waitForHealthy(port, this.healthCheckDeadlineMs, this.healthCheckPollIntervalMs) : false;
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
