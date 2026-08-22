import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenClawRelayServer, type RelayLogEntry } from '../src/relay/openclawRelayServer.js';
import { isPrivateOrLoopbackAddress } from '../src/relay/privateAddressCheck.js';

/** A tiny stand-in upstream that echoes back method/headers/body as JSON, so tests can assert exactly what the relay forwarded. */
function startEchoUpstream(): Promise<{ server: http.Server; url: string; requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> }> {
  const requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, receivedPath: req.url }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

function listenEphemeral(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function request(baseUrl: string, method: string, path: string, body?: string, headers?: Record<string, string>) {
  const res = await fetch(`${baseUrl}${path}`, { method, body, headers });
  const text = await res.text();
  return { status: res.status, body: text };
}

describe('OpenClaw relay server', () => {
  let mcpUpstream: Awaited<ReturnType<typeof startEchoUpstream>>;
  let logs: RelayLogEntry[];

  beforeEach(async () => {
    mcpUpstream = await startEchoUpstream();
    logs = [];
  });

  afterEach(async () => {
    await new Promise((resolve) => mcpUpstream.server.close(resolve));
  });

  it('forwards a real POST /mcp request to the fixed MCP upstream, verbatim', async () => {
    const relay = createOpenClawRelayServer({
      mcpUpstreamUrl: `${mcpUpstream.url}/api/openclaw/mcp`,
      log: (e) => logs.push(e),
    });
    const relayUrl = await listenEphemeral(relay);

    const res = await request(relayUrl, 'POST', '/mcp', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', {
      'content-type': 'application/json',
      authorization: 'Bearer real-callback-token',
    });

    expect(res.status).toBe(200);
    expect(mcpUpstream.requests).toHaveLength(1);
    expect(mcpUpstream.requests[0]!.url).toBe('/api/openclaw/mcp');
    expect(mcpUpstream.requests[0]!.headers.authorization).toBe('Bearer real-callback-token');
    expect(mcpUpstream.requests[0]!.body).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');

    relay.close();
  });

  it('rejects any path outside /mcp and /gemini with 404, never touching the network', async () => {
    const relay = createOpenClawRelayServer({ mcpUpstreamUrl: `${mcpUpstream.url}/api/openclaw/mcp`, log: (e) => logs.push(e) });
    const relayUrl = await listenEphemeral(relay);

    const attempts = ['/', '/anything', '/proxy?target=https://evil.example', '/mcpx', '/openai'];
    for (const path of attempts) {
      const res = await request(relayUrl, 'GET', path);
      expect(res.status).toBe(404);
    }
    expect(mcpUpstream.requests).toHaveLength(0);
    expect(logs.every((l) => l.outcome === 'rejected_unknown_path')).toBe(true);

    relay.close();
  });

  it('a path-traversal-style segment normalizes to a real route rather than bypassing the allow-list', async () => {
    // /mcp/../gemini normalizes to /gemini before routing (standard URL
    // resolution) - it must be treated exactly like a real /gemini request
    // (404, since no Gemini upstream is configured in this test), not as
    // some third, unvalidated path that slips past the allow-list.
    const relay = createOpenClawRelayServer({ mcpUpstreamUrl: `${mcpUpstream.url}/api/openclaw/mcp`, log: (e) => logs.push(e) });
    const relayUrl = await listenEphemeral(relay);

    const res = await request(relayUrl, 'GET', '/mcp/../gemini');
    expect(res.status).toBe(404);
    expect(logs.at(-1)?.outcome).toBe('rejected_no_gemini_upstream_configured');
    expect(mcpUpstream.requests).toHaveLength(0);

    relay.close();
  });

  it('has no mechanism to accept a caller-supplied forwarding target - GET /mcp (wrong method) is rejected, not routed elsewhere', async () => {
    const relay = createOpenClawRelayServer({ mcpUpstreamUrl: `${mcpUpstream.url}/api/openclaw/mcp`, log: (e) => logs.push(e) });
    const relayUrl = await listenEphemeral(relay);

    const res = await request(relayUrl, 'GET', '/mcp');
    expect(res.status).toBe(404);
    expect(mcpUpstream.requests).toHaveLength(0);

    relay.close();
  });

  it('/gemini/* forwards to the fixed Gemini upstream with the prefix stripped and query preserved', async () => {
    const geminiUpstream = await startEchoUpstream();
    const relay = createOpenClawRelayServer({
      mcpUpstreamUrl: `${mcpUpstream.url}/api/openclaw/mcp`,
      geminiUpstreamHost: `127.0.0.1:${new URL(geminiUpstream.url).port}`,
      geminiUpstreamProtocol: 'http',
      // The real Gemini upstream is never a loopback address - this test's
      // stand-in upstream is, purely for test convenience, so the private-
      // address rejection (covered by its own dedicated test below) is
      // explicitly overridden here rather than defeated by accident.
      isGeminiAddressAllowed: () => true,
      log: (e) => logs.push(e),
    });
    const relayUrl = await listenEphemeral(relay);

    const res = await request(relayUrl, 'POST', '/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=disposable-test-key', '{"contents":[]}', {
      'content-type': 'application/json',
    });

    expect(res.status).toBe(200);
    expect(geminiUpstream.requests).toHaveLength(1);
    expect(geminiUpstream.requests[0]!.url).toBe('/v1beta/models/gemini-2.5-flash:generateContent?key=disposable-test-key');

    relay.close();
    await new Promise((resolve) => geminiUpstream.server.close(resolve));
  });

  it('/gemini/* returns 404 when no Gemini upstream is configured', async () => {
    const relay = createOpenClawRelayServer({ mcpUpstreamUrl: `${mcpUpstream.url}/api/openclaw/mcp`, log: (e) => logs.push(e) });
    const relayUrl = await listenEphemeral(relay);

    const res = await request(relayUrl, 'POST', '/gemini/v1beta/models/foo:generateContent');
    expect(res.status).toBe(404);

    relay.close();
  });

  it('rejects a Gemini upstream hostname that resolves to a private/loopback address, without forwarding', async () => {
    const relay = createOpenClawRelayServer({
      mcpUpstreamUrl: `${mcpUpstream.url}/api/openclaw/mcp`,
      geminiUpstreamHost: 'localhost', // resolves to 127.0.0.1 - must be rejected, not treated as a legitimate upstream
      geminiUpstreamProtocol: 'http',
      log: (e) => logs.push(e),
    });
    const relayUrl = await listenEphemeral(relay);

    const res = await request(relayUrl, 'POST', '/gemini/v1beta/models/foo:generateContent');
    expect(res.status).toBe(502);
    expect(logs.some((l) => l.outcome === 'rejected_private_address')).toBe(true);

    relay.close();
  });

  it('rejects a request body larger than the configured limit before forwarding anything', async () => {
    const relay = createOpenClawRelayServer({
      mcpUpstreamUrl: `${mcpUpstream.url}/api/openclaw/mcp`,
      maxRequestBodyBytes: 10,
      log: (e) => logs.push(e),
    });
    const relayUrl = await listenEphemeral(relay);

    const res = await request(relayUrl, 'POST', '/mcp', 'x'.repeat(1000));
    expect(res.status).toBe(413);
    expect(mcpUpstream.requests).toHaveLength(0);

    relay.close();
  });

  it('never logs request/response bodies or the Authorization header value', async () => {
    const relay = createOpenClawRelayServer({ mcpUpstreamUrl: `${mcpUpstream.url}/api/openclaw/mcp`, log: (e) => logs.push(e) });
    const relayUrl = await listenEphemeral(relay);

    await request(relayUrl, 'POST', '/mcp', '{"secret":"super-secret-body-content"}', {
      authorization: 'Bearer sk-real-disposable-credential-xyz',
    });

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('super-secret-body-content');
    expect(serialized).not.toContain('sk-real-disposable-credential-xyz');

    relay.close();
  });

  it('never logs the query string (Gemini API keys can ride there, not just in headers)', async () => {
    const geminiUpstream = await startEchoUpstream();
    const relay = createOpenClawRelayServer({
      mcpUpstreamUrl: `${mcpUpstream.url}/api/openclaw/mcp`,
      geminiUpstreamHost: `127.0.0.1:${new URL(geminiUpstream.url).port}`,
      geminiUpstreamProtocol: 'http',
      log: (e) => logs.push(e),
    });
    const relayUrl = await listenEphemeral(relay);

    await request(relayUrl, 'POST', '/gemini/v1beta/models/foo:generateContent?key=super-secret-api-key-value');

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('super-secret-api-key-value');
    expect(logs.find((l) => l.route === 'gemini')?.path).toBe('/gemini/v1beta/models/foo:generateContent');

    relay.close();
    await new Promise((resolve) => geminiUpstream.server.close(resolve));
  });

  it('/healthz responds without ever attempting to forward anywhere', async () => {
    const relay = createOpenClawRelayServer({ mcpUpstreamUrl: `${mcpUpstream.url}/api/openclaw/mcp`, log: (e) => logs.push(e) });
    const relayUrl = await listenEphemeral(relay);

    const res = await request(relayUrl, 'GET', '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
    expect(mcpUpstream.requests).toHaveLength(0);

    relay.close();
  });
});

describe('isPrivateOrLoopbackAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.1.1', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['142.250.72.14', false], // a real, non-private Google IP range shape
    ['::1', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['2001:4860:4860::8888', false], // a real, non-private IPv6 shape
    ['::ffff:127.0.0.1', true],
    ['not-an-ip', true],
  ])('%s -> private=%s', (ip, expected) => {
    expect(isPrivateOrLoopbackAddress(ip)).toBe(expected);
  });
});
