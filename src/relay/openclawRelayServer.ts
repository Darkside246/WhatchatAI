import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { URL } from 'node:url';
import { isPrivateOrLoopbackAddress } from './privateAddressCheck.js';

/**
 * The per-cell network policy enforcement boundary - a deliberately narrow
 * reverse relay, NOT a general-purpose HTTP/CONNECT proxy. It has exactly
 * two fixed upstream identities, configured once at startup and never
 * derived from anything a request says: the AURA MCP endpoint, and
 * (when configured) one Gemini provider endpoint. There is no code path
 * anywhere in this file that accepts a caller-supplied target host, port,
 * or URL - "proxy this request to https://anything.example" has nothing to
 * latch onto here, structurally, not because of a check that rejects it.
 *
 * Trust boundaries stay separate by design (per the architecture this
 * mirrors): OpenClaw itself is the untrusted agent execution boundary, the
 * Tool Gateway is the authorization boundary, and this relay is the
 * network policy enforcement boundary - each auditable independently.
 */

export interface OpenClawRelayConfig {
  /** Fixed, exact URL every `/mcp` request is forwarded to verbatim. Never derived from a request. */
  mcpUpstreamUrl: string;
  /**
   * Fixed hostname every `/gemini/*` request is forwarded to, with the
   * `/gemini` prefix stripped and the remaining path+query preserved.
   * Optional - a relay with no Gemini upstream configured returns 404 for
   * that whole route, same as any other unrecognized path.
   */
  geminiUpstreamHost?: string;
  geminiUpstreamProtocol?: 'https' | 'http';
  /** Default 5_000_000 (5MB) - generous for MCP/Gemini JSON payloads, bounded against abuse. */
  maxRequestBodyBytes?: number;
  /** Default 60_000ms - long enough for a real LLM generation, short enough not to repeat the `security audit --deep` hang lesson. */
  requestTimeoutMs?: number;
  /** Default 5_000ms - matches the health-check pattern already used elsewhere in this codebase. */
  connectTimeoutMs?: number;
  /** Default 16 - exactly one cell talks to exactly one relay; this is a small defensive cap, not a shared-resource concern. */
  maxConnections?: number;
  /** Injectable for tests; defaults to a single-line JSON console.log. Never receives request/response bodies or the Authorization header value. */
  log?: (entry: RelayLogEntry) => void;
  /**
   * Policy hook deciding whether a resolved Gemini-upstream IP is allowed -
   * defaults to `!isPrivateOrLoopbackAddress(ip)`, the real production
   * behavior. Exists so tests can point `geminiUpstreamHost` at a local
   * loopback stand-in server and verify forwarding mechanics without
   * fighting the private-address rejection that real deployments always
   * want - the default is never weakened by this option's mere existence,
   * only by a caller explicitly overriding it (which only test code does).
   */
  isGeminiAddressAllowed?: (ip: string) => boolean;
}

export interface RelayLogEntry {
  timestamp: string;
  route: 'healthz' | 'mcp' | 'gemini' | 'unknown';
  method: string;
  /** Path only - deliberately never the query string, since a caller's API key can legitimately ride there (Gemini's own convention), not just in headers. */
  path: string;
  outcome:
    | 'forwarded'
    | 'rejected_unknown_path'
    | 'rejected_body_too_large'
    | 'rejected_private_address'
    | 'rejected_no_gemini_upstream_configured'
    | 'upstream_timeout'
    | 'upstream_error';
  upstreamStatus?: number;
  latencyMs: number;
  requestBytes: number;
  responseBytes?: number;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function forwardableHeaders(incoming: IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function defaultLog(entry: RelayLogEntry): void {
  console.log(JSON.stringify(entry));
}

async function readBodyWithLimit(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) return null; // caller responds 413, no partial buffer kept
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

interface ForwardTarget {
  protocol: 'http' | 'https';
  hostname: string;
  /** The IP actually connected to - resolved once, used both for the private-address check and the real connection, closing the DNS-rebinding TOCTOU gap. */
  connectAddress: string;
  port: number;
  path: string;
}

async function resolveForwardTarget(base: URL, subPath: string): Promise<ForwardTarget> {
  const protocol = base.protocol === 'https:' ? 'https' : 'http';
  const port = base.port ? Number(base.port) : protocol === 'https' ? 443 : 80;
  const { address } = await dns.lookup(base.hostname);
  return { protocol, hostname: base.hostname, connectAddress: address, port, path: subPath || '/' };
}

function forwardRequest(
  target: ForwardTarget,
  method: string,
  headers: Record<string, string | string[]>,
  body: Buffer,
  timeoutMs: number,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https' ? https : http;
    const outgoing = client.request(
      {
        protocol: `${target.protocol}:`,
        host: target.connectAddress,
        port: target.port,
        path: target.path,
        method,
        headers: { ...headers, host: target.hostname, 'content-length': String(body.length) },
        // TLS SNI/cert validation targets the real hostname even though we connect by resolved IP.
        servername: target.protocol === 'https' ? target.hostname : undefined,
        timeout: timeoutMs,
      },
      (upstreamRes) => {
        const chunks: Buffer[] = [];
        upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          resolve({ statusCode: upstreamRes.statusCode ?? 502, headers: upstreamRes.headers, body: Buffer.concat(chunks) });
        });
        upstreamRes.on('error', reject);
      },
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error('upstream request timed out')));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

export function createOpenClawRelayServer(config: OpenClawRelayConfig): http.Server {
  const maxRequestBodyBytes = config.maxRequestBodyBytes ?? 5_000_000;
  const requestTimeoutMs = config.requestTimeoutMs ?? 60_000;
  const log = config.log ?? defaultLog;
  const mcpUpstream = new URL(config.mcpUpstreamUrl);
  const geminiProtocol = config.geminiUpstreamProtocol ?? 'https';

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const startedAt = Date.now();
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const parsedUrl = new URL(rawUrl, 'http://relay.local');
    const path = parsedUrl.pathname;

    const finish = (statusCode: number, entry: Omit<RelayLogEntry, 'timestamp' | 'method' | 'path' | 'latencyMs'>, responseBody?: Buffer) => {
      res.writeHead(statusCode, responseBody ? { 'content-type': 'application/octet-stream' } : undefined);
      res.end(responseBody);
      log({ timestamp: new Date().toISOString(), method, path, latencyMs: Date.now() - startedAt, ...entry });
    };

    if (method === 'GET' && path === '/healthz') {
      finish(200, { route: 'healthz', outcome: 'forwarded', requestBytes: 0 }, Buffer.from('ok'));
      return;
    }

    // Reject unrecognized paths before touching the network at all - the
    // fixed two-route allow-list is enforced here, not by inspecting or
    // trusting anything about the request beyond its own path.
    const isMcpRoute = method === 'POST' && path === '/mcp';
    const isGeminiRoute = path === '/gemini' || path.startsWith('/gemini/');
    if (!isMcpRoute && !isGeminiRoute) {
      finish(404, { route: 'unknown', outcome: 'rejected_unknown_path', requestBytes: 0 });
      return;
    }

    const body = await readBodyWithLimit(req, maxRequestBodyBytes);
    if (body === null) {
      finish(413, { route: isMcpRoute ? 'mcp' : 'gemini', outcome: 'rejected_body_too_large', requestBytes: maxRequestBodyBytes + 1 });
      return;
    }

    try {
      if (isMcpRoute) {
        const target = await resolveForwardTarget(mcpUpstream, mcpUpstream.pathname + mcpUpstream.search);
        const upstream = await forwardRequest(target, method, forwardableHeaders(req), body, requestTimeoutMs);
        res.writeHead(upstream.statusCode, upstream.headers);
        res.end(upstream.body);
        log({
          timestamp: new Date().toISOString(), route: 'mcp', method, path, outcome: 'forwarded',
          upstreamStatus: upstream.statusCode, latencyMs: Date.now() - startedAt,
          requestBytes: body.length, responseBytes: upstream.body.length,
        });
        return;
      }

      // Gemini route
      if (!config.geminiUpstreamHost) {
        finish(404, { route: 'gemini', outcome: 'rejected_no_gemini_upstream_configured', requestBytes: body.length });
        return;
      }
      const subPath = path === '/gemini' ? '/' : path.slice('/gemini'.length);
      const target = await resolveForwardTarget(
        new URL(`${geminiProtocol}://${config.geminiUpstreamHost}`),
        subPath + parsedUrl.search,
      );
      const addressAllowed = config.isGeminiAddressAllowed
        ? config.isGeminiAddressAllowed(target.connectAddress)
        : !isPrivateOrLoopbackAddress(target.connectAddress);
      if (!addressAllowed) {
        finish(502, { route: 'gemini', outcome: 'rejected_private_address', requestBytes: body.length });
        return;
      }
      const upstream = await forwardRequest(target, method, forwardableHeaders(req), body, requestTimeoutMs);
      res.writeHead(upstream.statusCode, upstream.headers);
      res.end(upstream.body);
      log({
        timestamp: new Date().toISOString(), route: 'gemini', method, path, outcome: 'forwarded',
        upstreamStatus: upstream.statusCode, latencyMs: Date.now() - startedAt,
        requestBytes: body.length, responseBytes: upstream.body.length,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.message.includes('timed out');
      finish(timedOut ? 504 : 502, {
        route: isMcpRoute ? 'mcp' : 'gemini',
        outcome: timedOut ? 'upstream_timeout' : 'upstream_error',
        requestBytes: body.length,
      });
    }
  });

  server.maxConnections = config.maxConnections ?? 16;
  return server;
}
