import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  guardToolInvocation,
  UnregisteredToolError,
  UnknownTenantError,
  UnknownActorError,
  SystemTierToolDeniedError,
  ToolRateLimitExceededError,
} from '../src/services/ai/agentGuard.js';
import { isToolRegistered, listRegisteredTools, isTierAlwaysDenied } from '../src/services/ai/aiToolPolicy.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('agentGuard / AI Security Governor (real Postgres tenant, actor, and rate-limit checks - not mocked)', () => {
  let businessId: string;
  let agentId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Reception Agent' });
    agentId = agent.id;
  });

  it('fails closed on an unregistered tool name, and audits the denial (not silent)', async () => {
    await expect(
      guardToolInvocation('delete_everything', { businessId, whatsappAccountId: null, chatId: null, agentId }),
    ).rejects.toThrow(UnregisteredToolError);

    const log = await new SecurityAuditLogRepository(pool).listRecent(businessId);
    expect(log).toHaveLength(1);
    expect(log[0]?.eventType).toBe('ai_tool_denied');
    expect(log[0]?.severity).toBe('critical');
  });

  it('writes a real ai_tool_invoked audit event for a registered tool called by a real, active agent, with no message text/contact PII', async () => {
    await guardToolInvocation('get_current_time', {
      businessId,
      whatsappAccountId: null,
      chatId: 'chat-123',
      agentId,
    });

    const log = await new SecurityAuditLogRepository(pool).listRecent(businessId);
    expect(log).toHaveLength(1);
    expect(log[0]?.eventType).toBe('ai_tool_invoked');
    expect(log[0]?.rawMetadata).toMatchObject({ toolName: 'get_current_time', risk: 'READ', chatId: 'chat-123', agentId });
    // Structural/diagnostic only - never message content or contact identity.
    // agentId is a real UUID (already asserted exactly above) and is
    // expected to contain digit runs by chance - excluded here so this
    // check targets the actual concern (a phone-number-shaped value
    // leaking into audit metadata) without flaking on unrelated hex.
    const { agentId: _agentId, ...metadataWithoutAgentId } = log[0]?.rawMetadata as Record<string, unknown>;
    expect(JSON.stringify(metadataWithoutAgentId)).not.toMatch(/\+?\d{7,}/); // no phone-number-shaped value
  });

  it('the get_current_time tool is registered as READ risk, alongside only the other known tools', () => {
    expect(isToolRegistered('get_current_time')).toBe(true);
    expect(isToolRegistered('anything_else')).toBe(false);
    expect(listRegisteredTools()).toEqual(
      expect.arrayContaining([{ name: 'get_current_time', risk: 'READ', description: expect.any(String) }]),
    );
    expect(listRegisteredTools().map((tool) => tool.name).sort()).toEqual([
      'get_current_time',
      'schedule_google_meet',
      'schedule_zoom_meeting',
      'update_conversation_memory',
    ]);
  });

  it('SYSTEM is the only risk tier always denied, regardless of registration', () => {
    expect(isTierAlwaysDenied('SYSTEM')).toBe(true);
    expect(isTierAlwaysDenied('READ')).toBe(false);
    expect(isTierAlwaysDenied('WRITE')).toBe(false);
    expect(isTierAlwaysDenied('SEND')).toBe(false);
    expect(isTierAlwaysDenied('HIGH_RISK')).toBe(false);
  });

  it('denies a tool invocation for a business that does not exist - a forged or stale businessId is never trusted', async () => {
    const fakeBusinessId = '00000000-0000-0000-0000-000000000000';
    await expect(
      guardToolInvocation('get_current_time', { businessId: fakeBusinessId, whatsappAccountId: null, chatId: null, agentId }),
    ).rejects.toThrow(UnknownTenantError);

    // security_audit_logs.business_id has a real FK to businesses(id), so a
    // denial can never be logged against a business that doesn't exist -
    // there is nowhere real to attribute it. The audit write's own .catch()
    // absorbs that FK violation (audit logging must never crash the
    // caller); the throw above is what actually stops the call.
  });

  it('denies and audits a tool invocation from an agent that does not exist', async () => {
    const fakeAgentId = '00000000-0000-0000-0000-000000000000';
    await expect(
      guardToolInvocation('get_current_time', { businessId, whatsappAccountId: null, chatId: null, agentId: fakeAgentId }),
    ).rejects.toThrow(UnknownActorError);

    const log = await new SecurityAuditLogRepository(pool).listRecent(businessId);
    expect(log).toHaveLength(1);
    expect(log[0]?.eventType).toBe('ai_tool_denied');
  });

  it('denies a cross-tenant agent - a real, active agent belonging to a DIFFERENT business must never be trusted for this one', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAgent = await new AiAgentRepository(pool).create({ businessId: otherBusinessId, name: 'Other Business Agent' });

    await expect(
      guardToolInvocation('get_current_time', { businessId, whatsappAccountId: null, chatId: null, agentId: otherAgent.id }),
    ).rejects.toThrow(UnknownActorError);
  });

  it('denies a real agent that has been archived - status must be ACTIVE, not merely exist', async () => {
    const agentRepository = new AiAgentRepository(pool);
    await pool.query('UPDATE ai_agents SET status = $2 WHERE id = $1', [agentId, 'ARCHIVED']);
    const archived = await agentRepository.findById(agentId);
    expect(archived?.status).toBe('ARCHIVED');

    await expect(
      guardToolInvocation('get_current_time', { businessId, whatsappAccountId: null, chatId: null, agentId }),
    ).rejects.toThrow(UnknownActorError);
  });

  it('enforces a real per-business, per-tool rate limit over a rolling window - denies and audits once the ceiling is reached', async () => {
    process.env.AI_TOOL_RATE_LIMIT_READ = '3';
    try {
      for (let i = 0; i < 3; i += 1) {
        await guardToolInvocation('get_current_time', { businessId, whatsappAccountId: null, chatId: null, agentId });
      }

      await expect(
        guardToolInvocation('get_current_time', { businessId, whatsappAccountId: null, chatId: null, agentId }),
      ).rejects.toThrow(ToolRateLimitExceededError);

      const log = await new SecurityAuditLogRepository(pool).listRecent(businessId, 10);
      const denials = log.filter((entry) => entry.eventType === 'ai_tool_denied');
      expect(denials).toHaveLength(1);
      expect(denials[0]?.reason).toContain('Rate limit exceeded');
    } finally {
      delete process.env.AI_TOOL_RATE_LIMIT_READ;
    }
  });
});
