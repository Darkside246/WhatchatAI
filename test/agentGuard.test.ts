import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { guardToolInvocation, UnregisteredToolError } from '../src/services/ai/agentGuard.js';
import { isToolRegistered, listRegisteredTools } from '../src/services/ai/aiToolPolicy.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('agentGuard (real audit-log writes against Postgres, not mocked)', () => {
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
  });

  it('fails closed on an unregistered tool name, before ever touching the database', async () => {
    await expect(guardToolInvocation('delete_everything', { businessId, whatsappAccountId: null, chatId: null, agentId: 'agent-1' })).rejects.toThrow(
      UnregisteredToolError,
    );

    const log = await new SecurityAuditLogRepository(pool).listRecent(businessId);
    expect(log).toHaveLength(0);
  });

  it('writes a real ai_tool_invoked audit event for a registered tool, with no message text/contact PII', async () => {
    await guardToolInvocation('get_current_time', {
      businessId,
      whatsappAccountId: null,
      chatId: 'chat-123',
      agentId: 'agent-456',
    });

    const log = await new SecurityAuditLogRepository(pool).listRecent(businessId);
    expect(log).toHaveLength(1);
    expect(log[0]?.eventType).toBe('ai_tool_invoked');
    expect(log[0]?.rawMetadata).toMatchObject({ toolName: 'get_current_time', risk: 'READ', chatId: 'chat-123', agentId: 'agent-456' });
    // Structural/diagnostic only - never message content or contact identity.
    expect(JSON.stringify(log[0]?.rawMetadata)).not.toMatch(/\+?\d{7,}/); // no phone-number-shaped value
  });

  it('the get_current_time tool is registered as READ risk, and nothing else is registered yet', () => {
    expect(isToolRegistered('get_current_time')).toBe(true);
    expect(isToolRegistered('anything_else')).toBe(false);
    expect(listRegisteredTools()).toEqual([
      { name: 'get_current_time', risk: 'READ', description: expect.any(String) },
    ]);
  });
});
