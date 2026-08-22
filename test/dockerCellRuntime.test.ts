import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm as fsRm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `DockerCellRuntime` shells out to the real `docker` CLI for everything,
 * including health checking (`docker exec ... curl .../healthz`, run
 * inside the container's own namespace - see CHANGELOG_SECURITY.md's
 * "egress containment" entry for why this isn't a host-side HTTP request
 * against a published port: `--internal` networks block host reachability
 * of published ports entirely, confirmed against a real container). This
 * sandbox has no OpenClaw image it can actually run (neither Docker Hub
 * nor GHCR blob downloads complete through this sandbox's egress policy),
 * so every test here mocks `execFile` directly rather than pretending to
 * run a real container.
 *
 * Same custom-promisify mocking approach as `openclawCellService.test.ts`
 * used for the (now-removed) Fleet CLI mock.
 */
const execFileMock = vi.fn(async (..._args: unknown[]) => ({ stdout: '', stderr: '' }));
(execFileMock as unknown as { [key: symbol]: unknown })[promisify.custom] = execFileMock;

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const { DockerCellRuntime, resolveContainedCellStateDir, purgeCellStateDir, CellStatePurgeError } = await import(
  '../src/services/dockerCellRuntime.js'
);

const HEALTHY = { stdout: '200\n', stderr: '' };

describe('DockerCellRuntime', () => {
  const cellId = 'wc-testcell';
  const image = 'ghcr.io/openclaw/openclaw@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac';
  let runtime: InstanceType<typeof DockerCellRuntime>;
  let stateRoot: string;
  const originalEnv = process.env.OPENCLAW_CELL_STATE_DIR;

  beforeEach(async () => {
    execFileMock.mockReset();
    // create() now touches the real filesystem (mkdir+chmod the state
    // dir) - point it at a throwaway temp root rather than the repo's
    // own data/openclaw-cells.
    stateRoot = await mkdtemp(path.join(tmpdir(), 'openclaw-runtime-root-'));
    process.env.OPENCLAW_CELL_STATE_DIR = stateRoot;
    // Fast health-check timing for tests - production uses 60s/1s.
    runtime = new DockerCellRuntime(300, 20);
  });

  afterEach(async () => {
    process.env.OPENCLAW_CELL_STATE_DIR = originalEnv;
    await fsRm(stateRoot, { recursive: true, force: true }).catch(() => undefined);
    vi.clearAllMocks();
  });

  it('creates a per-cell network only when one does not already exist, then runs the container with the full hardening profile', async () => {
    execFileMock
      .mockRejectedValueOnce(new Error('network not found')) // network inspect - doesn't exist
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // network create
      .mockResolvedValueOnce({ stdout: 'container123\n', stderr: '' }) // docker run
      .mockResolvedValueOnce(HEALTHY) // docker exec health check
      .mockRejectedValueOnce(new Error('network not found')) // relay egress network inspect - doesn't exist
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // relay egress network create
      .mockResolvedValueOnce({ stdout: 'relaycontainer123\n', stderr: '' }) // relay docker run
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // relay docker network connect
      .mockResolvedValueOnce(HEALTHY); // relay docker exec health check

    const result = await runtime.create(cellId, image, { OPENCLAW_GATEWAY_TOKEN: 'tok-a', OPENCLAW_CALLBACK_TOKEN: 'tok-b' });

    expect(result.containerId).toBe('container123');
    expect(result.gatewayEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(result.port).toBeGreaterThan(0);

    expect(execFileMock).toHaveBeenCalledTimes(9);
    const [inspectCall, createCall, runCall, healthCall] = execFileMock.mock.calls as [unknown[], unknown[], unknown[], unknown[]];
    expect(inspectCall[0]).toBe('docker');
    expect(inspectCall[1]).toEqual(expect.arrayContaining(['network', 'inspect']));
    // --internal: no default route to the outside world for this network -
    // the actual egress-containment mechanism, not just a private network.
    expect(createCall[1]).toEqual(expect.arrayContaining(['network', 'create', '--driver', 'bridge', '--internal']));

    const runArgs = runCall[1] as string[];
    expect(runArgs).toEqual(
      expect.arrayContaining([
        '--user', '1000:1000',
        '--read-only',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--init',
        '--pids-limit', '512',
        '--memory', '2g',
        '--cpus', '2',
      ]),
    );
    // Loopback-only publish - never a wildcard bind. Kept even though it's
    // not currently reachable from the host under --internal (see the
    // class doc comment) - health checking below does not depend on it.
    expect(runArgs.some((arg) => /^127\.0\.0\.1:\d+:18789$/.test(arg))).toBe(true);
    expect(runArgs.some((arg) => arg.startsWith('0.0.0.0:'))).toBe(false);
    // The one deliberate hole in the internal network - reaching the
    // Docker host itself (where the Tool Gateway/adapter listens), via
    // Docker's own local name resolution, not a real DNS lookup.
    expect(runArgs).toEqual(expect.arrayContaining(['--add-host', 'host.docker.internal:host-gateway']));
    // Digest-pinned image only, never :latest.
    expect(runArgs).toContain(image);
    expect(runArgs.join(' ')).not.toMatch(/:latest/);
    // Real secrets passed via env, never as bare CLI args elsewhere.
    expect(runArgs).toEqual(expect.arrayContaining(['-e', 'OPENCLAW_GATEWAY_TOKEN=tok-a', '-e', 'OPENCLAW_CALLBACK_TOKEN=tok-b']));
    // Attack-surface reduction, confirmed via a real in-cell security
    // audit (2026-08-22) to shrink the attack-surface summary: elevated
    // tool access and browser automation are both disabled before the
    // gateway process starts, using the real `openclaw config set` CLI
    // rather than a hand-constructed config file.
    const command = runArgs[runArgs.length - 1] as string;
    expect(runArgs[runArgs.length - 3]).toBe('sh');
    expect(runArgs[runArgs.length - 2]).toBe('-lc');
    expect(command).toContain('openclaw config set tools.elevated.enabled false');
    expect(command).toContain('openclaw config set browser.enabled false');
    expect(command).toContain('exec node dist/index.js gateway');

    // Health checking runs inside the container's own namespace via
    // docker exec, never as a host-side request against the published port.
    expect(healthCall[1]).toEqual(
      expect.arrayContaining(['exec', `openclaw-cell-${cellId}`, 'curl', 'http://127.0.0.1:18789/healthz']),
    );

    // Regression test for a real in-cell audit finding (2026-08-22): the
    // host state directory must be created and locked down by us, not
    // left to whatever Docker's own bind-mount auto-creation default is
    // (observed as world-writable 0o777 on a real Docker Desktop/WSL2
    // host).
    const createdStateDir = path.join(stateRoot, cellId);
    const dirStats = await stat(createdStateDir);
    expect(dirStats.isDirectory()).toBe(true);
    expect(dirStats.mode & 0o777).toBe(0o700);

    // The relay - a separate, dedicated container attached to the cell's
    // own --internal network (so the cell can reach it) plus a second,
    // dedicated, NOT --internal egress network (its own only real route
    // out). Lighter hardening limits than the cell itself - a thin
    // forwarder, not a full OpenClaw runtime.
    const relayNetworkInspectCall = execFileMock.mock.calls[4] as unknown[];
    const relayNetworkCreateCall = execFileMock.mock.calls[5] as unknown[];
    const relayRunCall = execFileMock.mock.calls[6] as unknown[];
    const relayConnectCall = execFileMock.mock.calls[7] as unknown[];
    const relayHealthCall = execFileMock.mock.calls[8] as unknown[];

    expect(relayNetworkInspectCall[1]).toEqual(['network', 'inspect', `openclaw-relay-egress-net-${cellId}`]);
    // Not --internal - real outbound routing, but only the relay ever joins this network.
    expect(relayNetworkCreateCall[1]).toEqual(['network', 'create', '--driver', 'bridge', `openclaw-relay-egress-net-${cellId}`]);

    const relayRunArgs = relayRunCall[1] as string[];
    expect(relayRunArgs).toEqual(
      expect.arrayContaining([
        '--name', `openclaw-relay-${cellId}`,
        '--user', '1000:1000',
        '--read-only',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--init',
        '--pids-limit', '64',
        '--memory', '256m',
        '--cpus', '0.5',
        // Attached to the CELL's own --internal network at creation, not
        // the relay's own egress network - the second attachment happens
        // via a separate `docker network connect` call below.
        '--network', `openclaw-cell-net-${cellId}`,
        '-e', 'RELAY_PORT=8080',
      ]),
    );
    // No published port at all - nothing outside the cell's own network needs to reach the relay.
    expect(relayRunArgs).not.toContain('--publish');
    expect(relayRunArgs).toEqual(expect.arrayContaining(['-e', expect.stringMatching(/^RELAY_MCP_UPSTREAM_URL=http/)]));
    // No Gemini upstream configured in this test's environment - the env var must not be passed at all, not passed empty.
    expect(relayRunArgs.join(' ')).not.toContain('RELAY_GEMINI_UPSTREAM_HOST');
    expect(relayRunArgs).toContain('whatchatai-openclaw-relay:local');

    expect(relayConnectCall[1]).toEqual(['network', 'connect', `openclaw-relay-egress-net-${cellId}`, `openclaw-relay-${cellId}`]);
    expect(relayHealthCall[1]).toEqual(
      expect.arrayContaining(['exec', `openclaw-relay-${cellId}`, 'curl', 'http://127.0.0.1:8080/healthz']),
    );
  });

  it('passes RELAY_GEMINI_UPSTREAM_HOST to the relay only when configured', async () => {
    const originalGeminiHost = process.env.OPENCLAW_RELAY_GEMINI_UPSTREAM_HOST;
    process.env.OPENCLAW_RELAY_GEMINI_UPSTREAM_HOST = 'generativelanguage.googleapis.com';
    try {
      execFileMock
        .mockResolvedValueOnce({ stdout: 'exists', stderr: '' }) // cell network inspect
        .mockResolvedValueOnce({ stdout: 'container123\n', stderr: '' }) // cell run
        .mockResolvedValueOnce(HEALTHY) // cell health check
        .mockResolvedValueOnce({ stdout: 'exists', stderr: '' }) // relay egress network inspect
        .mockResolvedValueOnce({ stdout: 'relaycontainer123\n', stderr: '' }) // relay run
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // relay network connect
        .mockResolvedValueOnce(HEALTHY); // relay health check

      await runtime.create(cellId, image, {});

      const relayRunArgs = execFileMock.mock.calls[4]?.[1] as string[];
      expect(relayRunArgs).toEqual(
        expect.arrayContaining(['-e', 'RELAY_GEMINI_UPSTREAM_HOST=generativelanguage.googleapis.com']),
      );
    } finally {
      process.env.OPENCLAW_RELAY_GEMINI_UPSTREAM_HOST = originalGeminiHost;
    }
  });

  it('skips network creation when the per-cell network already exists', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: 'exists', stderr: '' }) // cell network inspect succeeds
      .mockResolvedValueOnce({ stdout: 'container123\n', stderr: '' }) // docker run
      .mockResolvedValueOnce(HEALTHY) // docker exec health check
      .mockResolvedValueOnce({ stdout: 'exists', stderr: '' }) // relay egress network inspect succeeds
      .mockResolvedValueOnce({ stdout: 'relaycontainer123\n', stderr: '' }) // relay run
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // relay network connect
      .mockResolvedValueOnce(HEALTHY); // relay health check

    await runtime.create(cellId, image, {});

    expect(execFileMock).toHaveBeenCalledTimes(7); // no network create for either the cell or the relay
  });

  it('throws a real error, never a silently-succeeded cell, if the container never becomes healthy', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: 'exists', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'container123\n', stderr: '' })
      .mockRejectedValue(new Error('exec failed - process not listening yet')); // health check never succeeds

    await expect(runtime.create(cellId, image, {})).rejects.toThrow(/did not become healthy/);
  });

  it('throws a real error if docker run itself fails', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: 'exists', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('docker: no such image'), { stderr: 'no such image' }));

    await expect(runtime.create(cellId, image, {})).rejects.toThrow(/docker run for cell/);
  });

  it('status() reports running+healthy only when the container is running AND the in-container health check succeeds', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' }) // .State.Running
      .mockResolvedValueOnce(HEALTHY); // docker exec health check

    const status = await runtime.status(cellId);
    expect(status).toEqual({ state: 'running', healthy: true });
  });

  it('status() reports running+unhealthy when the container is running but the health check never succeeds', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
      .mockRejectedValue(new Error('exec failed'));

    const status = await runtime.status(cellId);
    expect(status).toEqual({ state: 'running', healthy: false });
  });

  it('status() reports stopped for a real, present-but-not-running container', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: 'false\n', stderr: '' });
    const status = await runtime.status(cellId);
    expect(status).toEqual({ state: 'stopped', healthy: false });
  });

  it('status() reports unknown when the container does not exist at all', async () => {
    execFileMock.mockRejectedValueOnce(new Error('no such container'));
    const status = await runtime.status(cellId);
    expect(status).toEqual({ state: 'unknown', healthy: false });
  });

  it('stop() and start() invoke the correct docker subcommand against the correct container name, including the relay', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // relay stop (best-effort)
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // cell stop
    await runtime.stop(cellId);
    expect(execFileMock.mock.calls[0]).toEqual(['docker', ['stop', `openclaw-relay-${cellId}`], expect.anything()]);
    expect(execFileMock).toHaveBeenLastCalledWith('docker', ['stop', `openclaw-cell-${cellId}`], expect.anything());

    execFileMock.mockReset();
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // cell start
      .mockResolvedValueOnce(HEALTHY) // cell docker exec health check
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // relay start
      .mockResolvedValueOnce(HEALTHY); // relay docker exec health check

    await runtime.start(cellId);
    expect(execFileMock.mock.calls[0]).toEqual(['docker', ['start', `openclaw-cell-${cellId}`], expect.anything()]);
    expect(execFileMock.mock.calls[2]).toEqual(['docker', ['start', `openclaw-relay-${cellId}`], expect.anything()]);
    // start() checks health directly via docker exec for both the cell and its relay - four calls total.
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it('stop() still stops the cell even if stopping the relay fails - relay stop is best-effort', async () => {
    execFileMock
      .mockRejectedValueOnce(new Error('no such container')) // relay stop fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // cell stop still happens and succeeds

    await expect(runtime.stop(cellId)).resolves.toBeUndefined();
  });

  it('start() throws if the container comes back up but never reports healthy', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // start
      .mockRejectedValue(new Error('exec failed'));

    await expect(runtime.start(cellId)).rejects.toThrow(/did not report healthy/);
  });

  it('start() throws if the cell comes up healthy but its relay never does', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // cell start
      .mockResolvedValueOnce(HEALTHY) // cell health check
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // relay start
      .mockRejectedValue(new Error('exec failed')); // relay health check never succeeds

    await expect(runtime.start(cellId)).rejects.toThrow(/Relay for cell .* did not report healthy/);
  });

  it('start() gives the restart health check the full configured deadline, not the shorter routine-status-check cap', async () => {
    // Regression test for the real-runtime finding: a restart that takes
    // longer than a short routine-status cap (but well within the full
    // create()-style deadline) must still succeed, not throw.
    const slowRuntime = new (runtime.constructor as typeof DockerCellRuntime)(2_000, 50);
    execFileMock.mockResolvedValueOnce({ stdout: '', stderr: '' }); // start

    let calls = 0;
    execFileMock.mockImplementation(async () => {
      calls += 1;
      // First few polls fail (simulating the real ~1s+ plugin/channel boot
      // window), succeeding only after a delay that would have exceeded a
      // 5s-style short cap if this instance's deadline were shorter.
      if (calls < 4) throw new Error('exec failed - not up yet');
      return HEALTHY;
    });

    await expect(slowRuntime.start(cellId)).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it('upgrade() reads the existing environment, replaces the container (and its relay), and reuses that same environment for the new one', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: JSON.stringify(['OPENCLAW_GATEWAY_TOKEN=preserved-token', 'HOME=/home/node']), stderr: '' }) // inspect env
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // stop cell
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // rm cell
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // rm --force relay (replaced too, before create() re-runs it)
      .mockResolvedValueOnce({ stdout: 'exists', stderr: '' }) // cell network inspect (inside create())
      .mockResolvedValueOnce({ stdout: 'newcontainer\n', stderr: '' }) // docker run (cell)
      .mockResolvedValueOnce(HEALTHY) // cell docker exec health check
      .mockResolvedValueOnce({ stdout: 'exists', stderr: '' }) // relay egress network inspect
      .mockResolvedValueOnce({ stdout: 'newrelaycontainer\n', stderr: '' }) // docker run (relay)
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // relay network connect
      .mockResolvedValueOnce(HEALTHY); // relay docker exec health check

    const newImage = 'ghcr.io/openclaw/openclaw@sha256:0000000000000000000000000000000000000000000000000000000000000001';
    const result = await runtime.upgrade(cellId, newImage);

    expect(result.containerId).toBe('newcontainer');
    expect(execFileMock.mock.calls[3]).toEqual(['docker', ['rm', '--force', `openclaw-relay-${cellId}`], expect.anything()]);
    const runArgs = execFileMock.mock.calls[5]?.[1] as string[];
    expect(runArgs).toContain(newImage);
    expect(runArgs).toEqual(expect.arrayContaining(['-e', 'OPENCLAW_GATEWAY_TOKEN=preserved-token']));
  });

  it('remove() removes the relay container/network first, then the cell container/network - never throws even if every call fails', async () => {
    execFileMock
      .mockRejectedValueOnce(new Error('no such container')) // relay rm
      .mockRejectedValueOnce(new Error('no such network')) // relay network rm
      .mockRejectedValueOnce(new Error('no such container')) // cell rm
      .mockRejectedValueOnce(new Error('no such network')); // cell network rm

    await expect(runtime.remove(cellId, { purgeData: false })).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenNthCalledWith(1, 'docker', ['rm', '--force', `openclaw-relay-${cellId}`], expect.anything());
    expect(execFileMock).toHaveBeenNthCalledWith(2, 'docker', ['network', 'rm', `openclaw-relay-egress-net-${cellId}`], expect.anything());
    expect(execFileMock).toHaveBeenNthCalledWith(3, 'docker', ['rm', '--force', `openclaw-cell-${cellId}`], expect.anything());
    expect(execFileMock).toHaveBeenNthCalledWith(4, 'docker', ['network', 'rm', `openclaw-cell-net-${cellId}`], expect.anything());
  });

});

/**
 * purgeData containment - real filesystem, no mocking. This is exactly
 * the class of bug that a mocked fs would hide: whether the containment
 * checks actually stop a real symlink or a real `../` from escaping a
 * real directory. `node:child_process` stays mocked (container/network
 * removal aren't under test here); `node:fs/promises` is not.
 */
describe('purgeData containment (real filesystem)', () => {
  let stateRoot: string;
  let outsideCanaryDir: string;
  let outsideCanaryFile: string;
  const originalEnv = process.env.OPENCLAW_CELL_STATE_DIR;

  beforeEach(async () => {
    stateRoot = await mkdtemp(path.join(tmpdir(), 'openclaw-purge-root-'));
    process.env.OPENCLAW_CELL_STATE_DIR = stateRoot;

    // A real directory OUTSIDE the state root, with a real file in it -
    // every rejection test below asserts this survives untouched, which
    // is a much stronger proof than just "it threw."
    outsideCanaryDir = await mkdtemp(path.join(tmpdir(), 'openclaw-purge-outside-'));
    outsideCanaryFile = path.join(outsideCanaryDir, 'canary.txt');
    await writeFile(outsideCanaryFile, 'do-not-delete-me');
  });

  afterEach(async () => {
    process.env.OPENCLAW_CELL_STATE_DIR = originalEnv;
    await fsRm(stateRoot, { recursive: true, force: true }).catch(() => undefined);
    await fsRm(outsideCanaryDir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function exists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  it('deletes a valid cell directory', async () => {
    const cellDir = path.join(stateRoot, 'valid-cell-1');
    await mkdir(cellDir, { recursive: true });
    await writeFile(path.join(cellDir, 'session.json'), '{}');

    await purgeCellStateDir('valid-cell-1');

    expect(await exists(cellDir)).toBe(false);
    expect(await exists(stateRoot)).toBe(true); // the root itself survives
  });

  it('is idempotent - a nonexistent target is handled safely, not an error', async () => {
    await expect(purgeCellStateDir('never-existed-cell')).resolves.toBeUndefined();
  });

  it.each([
    ['../ traversal', '../escape'],
    ['a deeper ../ traversal', '../../etc/passwd'],
    ['nested path', 'foo/bar'],
    ['nested path with leading segment', 'a/b/c'],
    ['a bare dot-segment', '.'],
    ['a bare parent-segment', '..'],
    ['empty string', ''],
    ['a malformed identifier with a hyphen prefix', '-bad'],
    ['a malformed identifier with uppercase', 'Evil-Cell'],
    ['a malformed identifier with a null byte', 'cell\0evil'],
    ['a malformed identifier with percent-encoding', '%2e%2e%2fescape'],
  ])('rejects %s ("%s") without touching anything', async (_label, badCellId) => {
    await expect(resolveContainedCellStateDir(badCellId)).rejects.toThrow(CellStatePurgeError);
    expect(await exists(outsideCanaryFile)).toBe(true);
    expect(await exists(stateRoot)).toBe(true);
  });

  it('rejects an absolute path used as a cellId', async () => {
    await expect(resolveContainedCellStateDir(path.join(stateRoot, 'valid-cell'))).rejects.toThrow(CellStatePurgeError);
    await expect(resolveContainedCellStateDir('/etc/passwd')).rejects.toThrow(CellStatePurgeError);
  });

  it('never resolves to the state root itself - always exactly one level below it', async () => {
    const resolved = await resolveContainedCellStateDir('some-valid-cell');
    expect(resolved).not.toBe(stateRoot);
    expect(path.dirname(resolved)).toBe(stateRoot);
    expect(path.basename(resolved)).toBe('some-valid-cell');
  });

  it('rejects a symlink at the target, even one pointing inside the state root', async () => {
    const realDir = path.join(stateRoot, 'real-cell');
    await mkdir(realDir, { recursive: true });
    await writeFile(path.join(realDir, 'keep.txt'), 'should survive');

    const symlinkCellDir = path.join(stateRoot, 'symlink-cell');
    await symlink(realDir, symlinkCellDir, 'dir');

    await expect(purgeCellStateDir('symlink-cell')).rejects.toThrow(CellStatePurgeError);
    // Neither the symlink nor what it points to was touched.
    expect(await exists(symlinkCellDir)).toBe(true);
    expect(await exists(realDir)).toBe(true);
    expect(await exists(path.join(realDir, 'keep.txt'))).toBe(true);
  });

  it('rejects a symlink pointing outside the state root', async () => {
    const escapeCellDir = path.join(stateRoot, 'escape-cell');
    await symlink(outsideCanaryDir, escapeCellDir, 'dir');

    await expect(purgeCellStateDir('escape-cell')).rejects.toThrow(CellStatePurgeError);
    expect(await exists(outsideCanaryFile)).toBe(true); // the real target, untouched
    expect(await exists(escapeCellDir)).toBe(true); // the symlink itself, untouched
  });

  it('refuses to delete a file (not a directory) at the target', async () => {
    const filePath = path.join(stateRoot, 'not-a-dir');
    await writeFile(filePath, 'unexpected file where a cell directory should be');

    await expect(purgeCellStateDir('not-a-dir')).rejects.toThrow(CellStatePurgeError);
    expect(await exists(filePath)).toBe(true);
  });
});

describe('DockerCellRuntime.remove() wiring for purgeData', () => {
  const cellId = 'wc-testcell';
  let stateRoot: string;
  const originalEnv = process.env.OPENCLAW_CELL_STATE_DIR;

  beforeEach(async () => {
    execFileMock.mockReset();
    stateRoot = await mkdtemp(path.join(tmpdir(), 'openclaw-purge-wiring-'));
    process.env.OPENCLAW_CELL_STATE_DIR = stateRoot;
  });

  afterEach(async () => {
    process.env.OPENCLAW_CELL_STATE_DIR = originalEnv;
    await fsRm(stateRoot, { recursive: true, force: true }).catch(() => undefined);
    vi.clearAllMocks();
  });

  it('container removal succeeds even if the container/network are already absent, independent of purgeData', async () => {
    execFileMock.mockRejectedValueOnce(new Error('no such container')).mockRejectedValueOnce(new Error('no such network'));
    const runtime = new DockerCellRuntime();

    await expect(runtime.remove(cellId, { purgeData: false })).resolves.toBeUndefined();
  });

  it('purgeData: true actually deletes the real cell state directory on disk', async () => {
    const cellDir = path.join(stateRoot, cellId);
    await mkdir(cellDir, { recursive: true });
    await writeFile(path.join(cellDir, 'gateway-token.txt'), 'irrelevant, just proving the directory existed');

    execFileMock.mockResolvedValue({ stdout: '', stderr: '' }); // docker rm + network rm both succeed
    const runtime = new DockerCellRuntime();

    await runtime.remove(cellId, { purgeData: true });

    await expect(stat(cellDir)).rejects.toThrow();
  });

  it('surfaces a purge failure clearly rather than reporting a silent full cleanup - container/network removal already happened first', async () => {
    // Plant a symlink so containment rejects it - proves the failure is
    // reported, not swallowed, and that it happens AFTER container/network
    // removal was already attempted (matching the documented separation).
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'openclaw-purge-wiring-outside-'));
    try {
      const escapeCellDir = path.join(stateRoot, cellId);
      await symlink(outsideDir, escapeCellDir, 'dir');

      execFileMock.mockResolvedValue({ stdout: '', stderr: '' }); // container/network removal succeeds
      const runtime = new DockerCellRuntime();

      await expect(runtime.remove(cellId, { purgeData: true })).rejects.toThrow(/state-directory purge failed/);
      // The container/network removal calls still happened, despite the
      // later purge failure - the two are genuinely separate steps.
      expect(execFileMock).toHaveBeenCalledWith('docker', ['rm', '--force', `openclaw-cell-${cellId}`], expect.anything());
      expect(execFileMock).toHaveBeenCalledWith('docker', ['network', 'rm', `openclaw-cell-net-${cellId}`], expect.anything());
    } finally {
      await fsRm(outsideDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
