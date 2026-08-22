import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OpenClawCellRepository, type OpenClawCellRecord } from '../repositories/openclawCellRepository.js';
import { hashCallbackToken } from './openclawCallbackTokenService.js';
import { OpenClawToolGateway, openclawToolGateway } from './openclawToolGateway.js';
import { pool } from '../db/pool.js';

/**
 * Resolves the real, authenticated identity of an MCP caller from a raw
 * `Authorization` header - the exact same Bearer-token, hash-looked-up
 * mechanism `openclawAdapterService.ts` already uses for the REST tool
 * adapter (see `handleOpenClawToolInvokeRequest`). Deliberately duplicated
 * rather than imported: this is the one place the MCP transport differs
 * from HTTP (headers arrive via the transport's own request object, not
 * an Express `req`), so keeping the check as a small standalone function
 * keeps both call sites simple instead of forcing one to depend on the
 * other's request shape.
 *
 * The returned cell record is the caller's *entire* trusted identity -
 * businessId and cellId are never taken from an MCP tool argument, only
 * from here.
 */
export async function authenticateOpenClawMcpCaller(
  authorizationHeader: string | undefined,
  cellRepo: OpenClawCellRepository = new OpenClawCellRepository(pool),
): Promise<OpenClawCellRecord | null> {
  const bearerMatch = /^Bearer\s+(\S+)$/i.exec(authorizationHeader ?? '');
  if (!bearerMatch) return null;
  const rawToken = bearerMatch[1] as string;
  return cellRepo.findByCallbackTokenHash(hashCallbackToken(rawToken));
}

/**
 * `update_lead`'s real MCP-visible arguments. Deliberately mirrors the
 * REST adapter's own body shape (`chatId`/`cellGeneration`/`entityId`/
 * `fields`/`idempotencyKey` are all caller-claimed there too - see
 * `openclawAdapterService.ts`'s doc comment) - NOT a new trust model.
 * `businessId`/`cellId` are the only fields ever excluded from both
 * shapes, because those are the two an attacker could use to reach
 * another tenant; a wrong `cellGeneration` or `chatId` only ever produces
 * a real gateway DENY, never a privilege escalation, so exposing them as
 * ordinary model-visible arguments (same as the already-reviewed REST
 * path) is safe.
 */
const updateLeadInputShape = {
  entity_id: z.string().min(1).describe('The lead ID to update.'),
  chat_id: z.string().min(1).describe('The WhatsApp chat this update is being made on behalf of.'),
  cell_generation: z.number().int().describe("This cell's own generation number, as provided at boot."),
  idempotency_key: z.string().min(1).describe('A unique key identifying this exact operation, for safe retries.'),
  fields: z.record(z.string(), z.unknown()).describe('Fields to update: status, stage, and/or notes.'),
};

/**
 * Builds a fresh MCP server bound to one already-authenticated cell.
 * Deliberately built per-request (see `openclawMcpRouter.ts`) rather than
 * shared - the cell identity a tool call is authorized to act as must
 * never outlive the single authenticated request it came from.
 *
 * This is a thin protocol-translation layer only: every real
 * authorization decision (ownership, fencing, quarantine, idempotency,
 * rate limiting, field allow-listing) still happens exactly once, inside
 * `OpenClawToolGateway.invoke()`, completely unmodified. Nothing here
 * touches the database or any repository directly.
 */
export function createOpenClawMcpServer(
  cell: OpenClawCellRecord,
  gateway: OpenClawToolGateway = openclawToolGateway,
): McpServer {
  const server = new McpServer({ name: 'whatchatai-openclaw-tools', version: '1.0.0' });

  server.registerTool(
    'update_lead',
    {
      title: 'Update Lead',
      description:
        "Update this cell's authorized CRM lead - status, pipeline stage, and/or notes. " +
        'Only fields the caller is authorized to change are ever applied; the request is ' +
        'denied outright if the lead is not one this chat is authorized to act on.',
      inputSchema: updateLeadInputShape,
    },
    async (args) => {
      const outcome = await gateway.invoke({
        businessId: cell.businessId,
        cellId: cell.cellId,
        cellGeneration: args.cell_generation,
        chatId: args.chat_id,
        toolName: 'update_lead',
        entityId: args.entity_id,
        fields: args.fields as Record<string, unknown>,
        idempotencyKey: args.idempotency_key,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(outcome) }],
        isError: outcome.outcome === 'DENIED',
      };
    },
  );

  return server;
}
