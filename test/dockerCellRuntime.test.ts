import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `DockerCellRuntime` shells out to the real `docker` CLI and polls a
 * real HTTP `/healthz` endpoint - this sandbox has no OpenClaw image it
 * can actually run (see CHANGELOG_SECURITY.md's "OpenClaw Cell Runtime"
 * entry: a real Docker daemon exists here, but neither Docker Hub nor
 * GHCR blob downloads complete through this sandbox's egress policy), so
 * every test here mocks `execFile` and `fetch` directly rather than
 * pretending to run a real container. IMPLEMENTED BUT NOT FULLY
 * VERIFIED until exercised against a real daemon with the real image.
 *
 * Same custom-promisify mocking approach as `openclawCellService.test.ts`
 * used for the (now-removed) Fleet CLI mock.
 */
const execFileMock = vi.fn(async (..._args: unknown[]) => ({ stdout: '', stderr: '' }));
(execFileMock as unknown as { [key: symbol]: unknown })[promisify.custom] = execFileMock;

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

const { DockerCellRuntime } = await import('../src/services/dockerCellRuntime.js');

function okResponse(): Response {
  return new Response(null, { status: 200 });
}

describe('DockerCellRuntime', () => {
  const cellId = 'wc-testcell';
  const image = 'ghcr.io/openclaw/openclaw@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac';
  let runtime: InstanceType<typeof DockerCellRuntime>;

  beforeEach(() => {
    execFileMock.mockReset();
    fetchMock.mockReset();
    // Fast health-check timing for tests - production uses 60s/1s.
    runtime = new DockerCellRuntime(300, 20);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates a per-cell network only when one does not already exist, then runs the container with the full hardening profile', async () => {
    execFileMock
      .mockRejectedValueOnce(new Error('network not found')) // network inspect - doesn't exist
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // network create
      .mockResolvedValueOnce({ stdout: 'container123\n', stderr: '' }); // docker run
    fetchMock.mockResolvedValueOnce(okResponse());

    const result = await runtime.create(cellId, image, { OPENCLAW_GATEWAY_TOKEN: 'tok-a', OPENCLAW_CALLBACK_TOKEN: 'tok-b' });

    expect(result.containerId).toBe('container123');
    expect(result.gatewayEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(result.port).toBeGreaterThan(0);

    expect(execFileMock).toHaveBeenCalledTimes(3);
    const [inspectCall, createCall, runCall] = execFileMock.mock.calls as [unknown[], unknown[], unknown[]];
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
    // Loopback-only publish - never a wildcard bind.
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
  });

  it('skips network creation when the per-cell network already exists', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: 'exists', stderr: '' }) // network inspect succeeds
      .mockResolvedValueOnce({ stdout: 'container123\n', stderr: '' }); // docker run
    fetchMock.mockResolvedValueOnce(okResponse());

    await runtime.create(cellId, image, {});

    expect(execFileMock).toHaveBeenCalledTimes(2); // inspect + run, no create
  });

  it('throws a real error, never a silently-succeeded cell, if the container never becomes healthy', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: 'exists', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'container123\n', stderr: '' });
    fetchMock.mockRejectedValue(new Error('connection refused')); // never healthy within the deadline

    await expect(runtime.create(cellId, image, {})).rejects.toThrow(/did not become healthy/);
  });

  it('throws a real error if docker run itself fails', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: 'exists', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('docker: no such image'), { stderr: 'no such image' }));

    await expect(runtime.create(cellId, image, {})).rejects.toThrow(/docker run for cell/);
  });

  it('status() reports running+healthy only when the container is running AND /healthz responds ok', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' }) // .State.Running
      .mockResolvedValueOnce({ stdout: '19104\n', stderr: '' }); // HostPort
    fetchMock.mockResolvedValueOnce(okResponse());

    const status = await runtime.status(cellId);
    expect(status).toEqual({ state: 'running', healthy: true });
  });

  it('status() reports running+unhealthy when the container is running but /healthz never responds', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '19104\n', stderr: '' });
    fetchMock.mockRejectedValue(new Error('connection refused'));

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

  it('stop() and start() invoke the correct docker subcommand against the correct container name', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '', stderr: '' });
    await runtime.stop(cellId);
    expect(execFileMock).toHaveBeenLastCalledWith('docker', ['stop', `openclaw-cell-${cellId}`], expect.anything());

    execFileMock.mockReset();
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // start
      .mockResolvedValueOnce({ stdout: '19104\n', stderr: '' }); // port lookup
    fetchMock.mockResolvedValueOnce(okResponse());

    await runtime.start(cellId);
    expect(execFileMock.mock.calls[0]).toEqual(['docker', ['start', `openclaw-cell-${cellId}`], expect.anything()]);
    // start() polls the port directly rather than delegating through
    // status()'s separate .State.Running inspect - exactly two docker
    // calls (start, port lookup), not three.
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('start() throws if the container comes back up but never reports healthy', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // start
      .mockResolvedValueOnce({ stdout: '19104\n', stderr: '' }); // port lookup
    fetchMock.mockRejectedValue(new Error('connection refused'));

    await expect(runtime.start(cellId)).rejects.toThrow(/did not report healthy/);
  });

  it('start() gives the restart health check the full configured deadline, not the shorter routine-status-check cap', async () => {
    // Regression test for the real-runtime finding: a restart that takes
    // longer than a short routine-status cap (but well within the full
    // create()-style deadline) must still succeed, not throw.
    const slowRuntime = new (runtime.constructor as typeof DockerCellRuntime)(2_000, 50);
    execFileMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // start
      .mockResolvedValueOnce({ stdout: '19104\n', stderr: '' }); // port lookup

    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      // First few polls fail (simulating the real ~1s+ plugin/channel boot
      // window), succeeding only after a delay that would have exceeded a
      // 5s-style short cap if this instance's deadline were shorter.
      if (calls < 4) throw new Error('connection refused');
      return okResponse();
    });

    await expect(slowRuntime.start(cellId)).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it('upgrade() reads the existing environment, replaces the container, and reuses that same environment for the new one', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: JSON.stringify(['OPENCLAW_GATEWAY_TOKEN=preserved-token', 'HOME=/home/node']), stderr: '' }) // inspect env
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // stop
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // rm
      .mockResolvedValueOnce({ stdout: 'exists', stderr: '' }) // network inspect (inside create())
      .mockResolvedValueOnce({ stdout: 'newcontainer\n', stderr: '' }); // docker run
    fetchMock.mockResolvedValueOnce(okResponse());

    const newImage = 'ghcr.io/openclaw/openclaw@sha256:0000000000000000000000000000000000000000000000000000000000000001';
    const result = await runtime.upgrade(cellId, newImage);

    expect(result.containerId).toBe('newcontainer');
    const runArgs = execFileMock.mock.calls[4]?.[1] as string[];
    expect(runArgs).toContain(newImage);
    expect(runArgs).toEqual(expect.arrayContaining(['-e', 'OPENCLAW_GATEWAY_TOKEN=preserved-token']));
  });

  it('remove() removes the container and network, and never throws even if either call fails', async () => {
    execFileMock.mockRejectedValueOnce(new Error('no such container')).mockRejectedValueOnce(new Error('no such network'));

    await expect(runtime.remove(cellId, { purgeData: false })).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenNthCalledWith(1, 'docker', ['rm', '--force', `openclaw-cell-${cellId}`], expect.anything());
    expect(execFileMock).toHaveBeenNthCalledWith(2, 'docker', ['network', 'rm', `openclaw-cell-net-${cellId}`], expect.anything());
  });

  it('remove() with purgeData logs an explicit warning rather than silently deleting or silently doing nothing', async () => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runtime.remove(cellId, { purgeData: true });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not yet implemented'));
    warnSpy.mockRestore();
  });
});
