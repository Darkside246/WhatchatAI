import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { chmod, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { OpenClawCellRuntime, CellCreateResult, CellStatus } from './openclawCellRuntime.js';

const execFileAsync = promisify(execFile);

const DOCKER_TIMEOUT_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const RELAY_PORT = 8080;

/**
 * The relay's own image - built from this same repository (see the
 * `relay-runtime` Dockerfile stage), never pulled from an external
 * registry the way `OPENCLAW_PINNED_IMAGE` is. Must be built locally
 * (`docker build --target relay-runtime -t whatchatai-openclaw-relay:local .`)
 * before `create()` can succeed - not automatically built by this code,
 * matching how the cell's own pinned image is expected to already exist
 * rather than being pulled on demand mid-request.
 */
const RELAY_IMAGE = 'whatchatai-openclaw-relay:local';

/** Root host directory for per-cell state - mirrors the existing WHATSAPP_SESSION_DIR/MEDIA_STORAGE_DIR env-var convention already used in this codebase. */
function stateRootDir(): string {
  return process.env.OPENCLAW_CELL_STATE_DIR ?? path.join(process.cwd(), 'data', 'openclaw-cells');
}

/**
 * The relay's two fixed upstream identities - read once at container-create
 * time, never derived from anything cell-supplied. The Gemini upstream is
 * deliberately optional/unset until the Stage 3 real-agent integration
 * actually needs it; a relay with no Gemini upstream configured simply
 * 404s that whole route (see `openclawRelayServer.ts`), which is the
 * correct, safe behavior for right now, not a gap.
 */
function relayMcpUpstreamUrl(): string {
  return process.env.OPENCLAW_RELAY_MCP_UPSTREAM_URL ?? 'http://host.docker.internal:3000/api/openclaw/mcp';
}
function relayGeminiUpstreamHost(): string | undefined {
  return process.env.OPENCLAW_RELAY_GEMINI_UPSTREAM_HOST || undefined;
}

function containerName(cellId: string): string {
  return `openclaw-cell-${cellId}`;
}

function networkName(cellId: string): string {
  return `openclaw-cell-net-${cellId}`;
}

function relayContainerName(cellId: string): string {
  return `openclaw-relay-${cellId}`;
}

/** Not `--internal` - the relay's own, only real route out. The cell itself is never attached to this network; it only ever reaches the relay over the cell's existing `--internal` network. */
function relayEgressNetworkName(cellId: string): string {
  return `openclaw-relay-egress-net-${cellId}`;
}

/**
 * Deliberately independent of `validateCellId()` in `openclawCellService.ts`
 * - the same mirror-rather-than-share pattern already used for
 * `openclawCallbackTokenService.ts` vs `sessionTokenService.ts` in this
 * codebase, so this deletion-path guard doesn't quietly depend on an
 * upstream check ever staying correct. This regex is intentionally
 * stricter than it needs to be for currently-valid cell ids (letters,
 * digits, hyphens only) precisely because it guards a real filesystem
 * deletion.
 */
const SAFE_CELL_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export class CellStatePurgeError extends Error {}

/**
 * Resolves and fully validates the on-disk directory for a cell's state
 * before anything is allowed to delete it. Every check here is required,
 * not defense-in-depth padding - see the `purgeData` containment tests
 * for the adversarial cases each one exists to stop (`../` traversal, an
 * absolute-path or separator-bearing `cellId`, a symlink planted at the
 * target pointing anywhere - inside or outside the state root).
 */
export async function resolveContainedCellStateDir(cellId: string): Promise<string> {
  if (typeof cellId !== 'string' || cellId.length === 0) {
    throw new CellStatePurgeError('cellId must be a non-empty string');
  }
  if (cellId.includes('/') || cellId.includes('\\') || cellId.includes('\0')) {
    throw new CellStatePurgeError(`cellId must not contain path separators or null bytes: ${JSON.stringify(cellId)}`);
  }
  if (path.isAbsolute(cellId)) {
    throw new CellStatePurgeError(`cellId must not be an absolute path: ${JSON.stringify(cellId)}`);
  }
  if (!SAFE_CELL_ID.test(cellId)) {
    throw new CellStatePurgeError(`cellId does not match the expected shape, refusing to derive a deletion path from it: ${JSON.stringify(cellId)}`);
  }

  const root = path.resolve(stateRootDir());
  const target = path.resolve(root, cellId);

  // Containment: the resolved target must be exactly one direct child of
  // the resolved root - never the root itself, never nested, never
  // outside it. path.relative() surfaces any escape as a leading `..` or
  // an absolute path (a different-drive case on Windows).
  const relative = path.relative(root, target);
  const isDirectChild = relative.length > 0 && relative === cellId && !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!isDirectChild) {
    throw new CellStatePurgeError(`resolved cell state path is not a direct child of the state root (root=${root}, target=${target})`);
  }
  if (target === root) {
    throw new CellStatePurgeError('refusing to target the state root itself for deletion');
  }

  return target;
}

/**
 * Deletes exactly one cell's state directory, after `lstat`-based
 * containment checks - never `stat`, which would follow a symlink and
 * defeat the whole point of checking. A symlink planted at the target
 * (pointing anywhere, inside or outside the state root) is rejected
 * outright rather than followed. A target that doesn't exist at all is
 * treated as an idempotent success, not an error - matching this
 * runtime's existing "already absent" semantics elsewhere (`stop`/
 * `start`/`remove` on a missing container).
 */
export async function purgeCellStateDir(cellId: string): Promise<void> {
  const target = await resolveContainedCellStateDir(cellId);

  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // nothing to purge - idempotent
    throw new CellStatePurgeError(`could not inspect cell state path before deletion: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (stats.isSymbolicLink()) {
    throw new CellStatePurgeError(`refusing to delete a symlink at the cell state path (${target}) - real target ownership cannot be trusted`);
  }
  if (!stats.isDirectory()) {
    throw new CellStatePurgeError(`refusing to delete: cell state path (${target}) is not a directory`);
  }

  // Belt-and-suspenders beyond the lstat symlink check: resolve the real
  // path of a directory we've now confirmed is not itself a symlink, and
  // re-confirm it's still contained. Catches a symlink nested one level
  // inside the directory tree that could otherwise redirect a recursive
  // delete outside the state root.
  const real = await realpath(target);
  const root = path.resolve(stateRootDir());
  if (real !== path.resolve(root, cellId)) {
    throw new CellStatePurgeError(`cell state path's real location does not match its expected location (root=${root}, expected=${path.resolve(root, cellId)}, real=${real}) - refusing to delete`);
  }

  await rm(target, { recursive: true });
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
/** curl exists in the real OpenClaw image (real-hardware verified, repeatedly, throughout this whole runtime's history) - this stays the cell's own check. */
function curlHealthCheckArgs(port: number): string[] {
  return ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '5', `http://127.0.0.1:${port}/healthz`];
}

/**
 * The relay's image deliberately ships no `curl` at all (see the
 * `relay-runtime` Dockerfile stage's own comment - minimizing that
 * image's dependency footprint is the actual point, not an oversight).
 * Node's own built-in `fetch` is guaranteed to exist wherever the relay's
 * process itself runs, so the relay's health check uses that instead of
 * adding a dependency purely to satisfy this one check. Real evidence
 * this gap existed: a real `docker exec <relay> curl ...` failed with
 * "executable file not found in $PATH" while the relay's own real HTTP
 * responses (and Docker's own `HEALTHCHECK`, which already used `fetch`)
 * were working correctly the whole time - `create()` was timing out
 * waiting on a relay that was actually fine, purely because of what
 * *checked* it.
 */
function nodeFetchHealthCheckArgs(port: number): string[] {
  return [
    'node', '-e',
    `fetch('http://127.0.0.1:${port}/healthz').then(r=>{process.stdout.write(String(r.status));process.exit(0)}).catch(()=>{process.stdout.write('0');process.exit(0)})`,
  ];
}

async function execHealthCheck(targetContainerName: string, checkArgs: string[]): Promise<boolean> {
  try {
    const stdout = await docker(['exec', targetContainerName, ...checkArgs], HEALTH_CHECK_TIMEOUT_MS + 2_000);
    return stdout.trim() === '200';
  } catch {
    return false;
  }
}

async function waitForHealthy(targetContainerName: string, checkArgs: string[], deadlineMs: number, pollIntervalMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await execHealthCheck(targetContainerName, checkArgs)) return true;
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

  /**
   * Creates (if needed) and locks down the host state directory ourselves,
   * before Docker's bind mount can rely on whatever the daemon's own
   * auto-creation default would produce. Confirmed necessary by a real
   * in-cell security audit (2026-08-22): a fresh cell's
   * `/home/node/.openclaw` bind-mount source came back `mode=777`
   * (`fs.state_dir.perms_world_writable`, CRITICAL) on the test host -
   * likely Docker Desktop/WSL2's NTFS bind-mount translation, though not
   * yet confirmed whether that's specific to that dev environment or also
   * occurs on a native Linux host. Either way, explicit chmod here means
   * correctness never depends on host OS/Docker-daemon defaults.
   */
  private async ensureStateDir(cellId: string): Promise<void> {
    const stateDir = path.join(stateRootDir(), cellId);
    await mkdir(stateDir, { recursive: true });
    await chmod(stateDir, 0o700);
  }

  /**
   * The relay's own dedicated egress network - not `--internal`, real
   * outbound routing, but only ever attached to the relay container. The
   * cell itself never joins this network; it only ever reaches the relay
   * over the cell's own `--internal` network. One network per cell
   * (mirroring the per-cell relay container), not shared across tenants -
   * a compromised relay has no membership anywhere near another cell's
   * relay or network, matching the approved design.
   */
  private async ensureRelayEgressNetwork(cellId: string): Promise<void> {
    try {
      await docker(['network', 'inspect', relayEgressNetworkName(cellId)]);
    } catch {
      await docker(['network', 'create', '--driver', 'bridge', relayEgressNetworkName(cellId)]);
    }
  }

  /**
   * Attached to the cell's own `--internal` network at creation (so the
   * cell can reach it) and connected to the relay's dedicated egress
   * network afterward (`docker run` only accepts one `--network` at
   * creation time; a second attachment needs a separate `docker network
   * connect` call). No published port - nothing outside the cell's own
   * network needs to reach the relay. Lighter resource limits than the
   * cell itself: this is a thin, single-purpose forwarder, not a full
   * OpenClaw runtime.
   */
  private buildRelayRunArgs(cellId: string): string[] {
    const args = [
      'run',
      '-d',
      '--name', relayContainerName(cellId),
      '--label', `whatchatai.openclaw.relay=${cellId}`,
      '--user', '1000:1000',
      '--read-only',
      '--tmpfs', '/tmp',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--init',
      '--pids-limit', '64',
      '--memory', '256m',
      '--cpus', '0.5',
      '--network', networkName(cellId),
      '-e', `RELAY_PORT=${RELAY_PORT}`,
      '-e', `RELAY_MCP_UPSTREAM_URL=${relayMcpUpstreamUrl()}`,
    ];
    const geminiHost = relayGeminiUpstreamHost();
    if (geminiHost) args.push('-e', `RELAY_GEMINI_UPSTREAM_HOST=${geminiHost}`);
    args.push(RELAY_IMAGE);
    return args;
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
    // tools.elevated.enabled and browser.enabled are both real, documented
    // OpenClaw config keys (openclaw config schema), on by default in an
    // unconfigured cell - confirmed via a real in-cell security audit
    // (2026-08-22) to shrink the attack-surface summary when disabled, and
    // squarely matches this deployment's own use case (CRM tool invocation
    // via MCP only - no browser automation is ever needed here). Using the
    // same real `openclaw config set` CLI already proven to write this
    // correctly, rather than hand-constructing a config file whose exact
    // on-disk schema/merge behavior with --allow-unconfigured isn't
    // separately verified. `exec` hands off to the actual gateway process
    // as PID 1's replacement rather than leaving the shell as an extra
    // parent process.
    args.push(
      'sh', '-lc',
      'openclaw config set tools.elevated.enabled false && ' +
      'openclaw config set browser.enabled false && ' +
      'exec node dist/index.js gateway --bind lan --port 18789 --auth token --allow-unconfigured',
    );
    return args;
  }

  async create(cellId: string, image: string, env: Record<string, string>): Promise<CellCreateResult> {
    await this.ensureNetwork(cellId);
    await this.ensureStateDir(cellId);
    const port = await findFreePort();

    let containerId: string;
    try {
      const stdout = await docker(this.buildRunArgs(cellId, image, env, port));
      containerId = stdout.trim();
    } catch (error) {
      throw new Error(`docker run for cell ${cellId} failed: ${describeExecError(error)}`);
    }

    const healthy = await waitForHealthy(containerName(cellId), curlHealthCheckArgs(18789), this.healthCheckDeadlineMs, this.healthCheckPollIntervalMs);
    if (!healthy) {
      throw new Error(`Cell ${cellId} did not become healthy within ${this.healthCheckDeadlineMs}ms of starting (container ${containerId})`);
    }

    await this.ensureRelayEgressNetwork(cellId);
    try {
      await docker(this.buildRelayRunArgs(cellId));
      await docker(['network', 'connect', relayEgressNetworkName(cellId), relayContainerName(cellId)]);
    } catch (error) {
      throw new Error(`relay creation for cell ${cellId} failed: ${describeExecError(error)}`);
    }
    const relayHealthy = await waitForHealthy(relayContainerName(cellId), nodeFetchHealthCheckArgs(RELAY_PORT), this.healthCheckDeadlineMs, this.healthCheckPollIntervalMs);
    if (!relayHealthy) {
      throw new Error(`Relay for cell ${cellId} did not become healthy within ${this.healthCheckDeadlineMs}ms of starting`);
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
    const healthy = await waitForHealthy(containerName(cellId), curlHealthCheckArgs(18789), Math.min(5_000, this.healthCheckDeadlineMs), this.healthCheckPollIntervalMs);
    return { state: 'running', healthy };
  }

  async stop(cellId: string): Promise<void> {
    // Best-effort - the relay serves only this cell, so a stopped cell
    // leaving its relay briefly running is wasteful but harmless. A real
    // stop failure on the cell itself is what actually needs to surface.
    await docker(['stop', relayContainerName(cellId)]).catch(() => undefined);
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
    const healthy = await waitForHealthy(containerName(cellId), curlHealthCheckArgs(18789), this.healthCheckDeadlineMs, this.healthCheckPollIntervalMs);
    if (!healthy) {
      throw new Error(`Cell ${cellId} did not report healthy within ${this.healthCheckDeadlineMs}ms of restarting`);
    }

    try {
      await docker(['start', relayContainerName(cellId)]);
    } catch (error) {
      throw new Error(`docker start for cell ${cellId}'s relay failed: ${describeExecError(error)}`);
    }
    const relayHealthy = await waitForHealthy(relayContainerName(cellId), nodeFetchHealthCheckArgs(RELAY_PORT), this.healthCheckDeadlineMs, this.healthCheckPollIntervalMs);
    if (!relayHealthy) {
      throw new Error(`Relay for cell ${cellId} did not report healthy within ${this.healthCheckDeadlineMs}ms of restarting`);
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
    // The relay is replaced too, same as the cell - `create()` below would
    // otherwise fail trying to `docker run` a container name that's still
    // in use by the pre-upgrade relay.
    await docker(['rm', '--force', relayContainerName(cellId)]).catch(() => undefined);

    return this.create(cellId, image, previousEnv);
  }

  /**
   * Container/network removal and host-state deletion are deliberately
   * kept as two separate steps with two separate failure semantics.
   * Container/network removal is idempotent best-effort - it already
   * treats "not found" as success, matching this runtime's existing
   * lifecycle semantics elsewhere. Host-state deletion, when requested,
   * is NOT swallowed on failure - a caller that asked for purgeData and
   * didn't get it needs to know that, not receive a silent, misleading
   * "fully cleaned up." See `purgeCellStateDir` for the containment
   * checks a real deletion has to pass first.
   */
  async remove(cellId: string, options: { purgeData: boolean }): Promise<void> {
    await docker(['rm', '--force', relayContainerName(cellId)]).catch(() => undefined);
    await docker(['network', 'rm', relayEgressNetworkName(cellId)]).catch(() => undefined);
    await docker(['rm', '--force', containerName(cellId)]).catch(() => undefined);
    await docker(['network', 'rm', networkName(cellId)]).catch(() => undefined);
    if (options.purgeData) {
      try {
        await purgeCellStateDir(cellId);
      } catch (error) {
        throw new Error(
          `container/network for cell ${cellId} were removed, but state-directory purge failed and did NOT complete: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
