import { Router } from 'express';
import { StreamableHTTPServerTransport, type StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { OpenClawCellRepository } from '../repositories/openclawCellRepository.js';
import { authenticateOpenClawMcpCaller, createOpenClawMcpServer } from '../services/openclawMcpServer.js';
import { pool } from '../db/pool.js';

/**
 * The real MCP wire-protocol surface an OpenClaw cell's agent connects to
 * as an MCP client. Feature-gated and disabled by default (see the
 * `OPENCLAW_MCP_SERVER_ENABLED` check around this router's mount in
 * `server/index.ts`) - mounting this router
 * is not, on its own, "wiring the MCP server into a live agent"; no cell
 * is configured to call it until that separate, later step happens.
 *
 * Stateless Streamable HTTP transport (`sessionIdGenerator: undefined`):
 * a fresh `McpServer` + `StreamableHTTPServerTransport` pair is built for
 * every single request, bound to whatever cell identity that request's
 * own `Authorization` header authenticates as. No session state, no
 * connection pooling, no identity that outlives one request - matching
 * how `openclawAdapterService.ts`'s REST path already authenticates on
 * every call rather than once per connection.
 */
export const openclawMcpRouter = Router();

openclawMcpRouter.post('/', async (req, res) => {
  const cellRepo = new OpenClawCellRepository(pool);
  const cell = await authenticateOpenClawMcpCaller(req.headers.authorization, cellRepo);
  if (!cell) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'invalid or missing callback token' },
      id: null,
    });
    return;
  }

  const server = createOpenClawMcpServer(cell);
  // The SDK's own docs recommend exactly `sessionIdGenerator: undefined`
  // for stateless mode, but its declared option type omits `| undefined`
  // on that optional field - incompatible with this project's
  // `exactOptionalPropertyTypes: true` under a plain object literal.
  // Upstream type-declaration gap, not a real runtime concern.
  const transportOptions: StreamableHTTPServerTransportOptions = { sessionIdGenerator: undefined } as unknown as StreamableHTTPServerTransportOptions;
  const transport = new StreamableHTTPServerTransport(transportOptions);

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  // Same upstream gap: `StreamableHTTPServerTransport`'s onclose/onerror/
  // onmessage accessors are typed `(() => void) | undefined`, which
  // `exactOptionalPropertyTypes: true` treats as not structurally
  // matching `Transport`'s `onclose?: () => void`. The object genuinely
  // implements the interface at runtime; this is a type-check-only gap.
  await server.connect(transport as unknown as Transport);
  await transport.handleRequest(req, res, req.body);
});

/**
 * Stateless mode serves POST only - there is no server-initiated stream
 * to resume via GET and no session to end via DELETE. Reject both
 * explicitly rather than letting them fall through to a generic 404.
 */
openclawMcpRouter.get('/', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed: this MCP server runs in stateless mode (POST only).' },
    id: null,
  });
});
openclawMcpRouter.delete('/', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed: this MCP server runs in stateless mode (no sessions to end).' },
    id: null,
  });
});
