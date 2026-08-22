import { OpenClawCellRepository } from '../repositories/openclawCellRepository.js';
import { hashCallbackToken } from './openclawCallbackTokenService.js';
import { OpenClawToolGateway, openclawToolGateway } from './openclawToolGateway.js';
import { pool } from '../db/pool.js';

export interface OpenClawAdapterResponse {
  httpStatus: number;
  body: Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The one thin seam between an actual OpenClaw cell's tool-call protocol
 * and `OpenClawToolGateway.invoke()`. Deliberately just parsing +
 * authentication + a call-through - all the real authorization logic
 * lives in the gateway (already proven in its own adversarial suite),
 * not duplicated here.
 *
 * Authentication is Bearer-token, hash-looked-up (mirrors session
 * cookies - see openclawCallbackTokenService.ts) - and critically, the
 * businessId/cellId/generation used for the actual gateway call
 * come ONLY from the authenticated cell record this token resolves to,
 * never from anything the request body claims. A cell cannot present
 * its own real token and then ask to act as a different tenant, a
 * different cell, or a different generation by simply writing a
 * different value into the JSON body - those fields, if present in the
 * body, are ignored entirely.
 *
 * Exported as a plain function (not a route handler) so it is testable
 * with direct calls, matching how every other piece of this codebase is
 * tested - no HTTP-level test harness needed for logic this thin.
 */
export async function handleOpenClawToolInvokeRequest(
  authorizationHeader: string | undefined,
  body: unknown,
  cellRepo: OpenClawCellRepository = new OpenClawCellRepository(pool),
  gateway: OpenClawToolGateway = openclawToolGateway,
): Promise<OpenClawAdapterResponse> {
  const bearerMatch = /^Bearer\s+(\S+)$/i.exec(authorizationHeader ?? '');
  if (!bearerMatch) {
    return { httpStatus: 401, body: { error: 'missing or malformed Authorization header' } };
  }
  const rawToken = bearerMatch[1] as string;

  const cell = await cellRepo.findByCallbackTokenHash(hashCallbackToken(rawToken));
  if (!cell) {
    return { httpStatus: 401, body: { error: 'invalid callback token' } };
  }

  if (typeof body !== 'object' || body === null) {
    return { httpStatus: 400, body: { error: 'request body must be a JSON object' } };
  }
  const b = body as Record<string, unknown>;

  if (!isNonEmptyString(b.toolName)) return { httpStatus: 400, body: { error: '"toolName" must be a non-empty string' } };
  if (!isNonEmptyString(b.entityId)) return { httpStatus: 400, body: { error: '"entityId" must be a non-empty string' } };
  if (!isNonEmptyString(b.chatId)) return { httpStatus: 400, body: { error: '"chatId" must be a non-empty string' } };
  if (!isNonEmptyString(b.idempotencyKey)) return { httpStatus: 400, body: { error: '"idempotencyKey" must be a non-empty string' } };
  if (typeof b.fields !== 'object' || b.fields === null || Array.isArray(b.fields)) {
    return { httpStatus: 400, body: { error: '"fields" must be a JSON object' } };
  }
  if (typeof b.cellGeneration !== 'number' || !Number.isInteger(b.cellGeneration)) {
    return { httpStatus: 400, body: { error: '"cellGeneration" must be an integer' } };
  }

  const outcome = await gateway.invoke({
    // Authenticated identity - never taken from the body, even if present.
    businessId: cell.businessId,
    cellId: cell.cellId,
    // Caller-claimed, checked by the gateway against the cell's real
    // stored generation - a mismatch is a real DENY, not trusted input.
    cellGeneration: b.cellGeneration,
    chatId: b.chatId,
    toolName: b.toolName,
    entityId: b.entityId,
    fields: b.fields as Record<string, unknown>,
    idempotencyKey: b.idempotencyKey,
  });

  return { httpStatus: 200, body: outcome as unknown as Record<string, unknown> };
}
