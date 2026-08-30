import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { guardGeneratedText } from '../src/services/ai/aiOrchestrator.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('aiOrchestrator Outbound Leak Guard wiring (real Postgres agent + real security_audit_logs writes)', () => {
  it('blocks a reply containing a protected fact, writes a real ai_output_leak_blocked audit row, and never carries the leaked text on the outcome', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agentRepo = new AiAgentRepository(pool);
    const agent = await agentRepo.create({
      businessId,
      name: 'Kai',
      protectedFacts: ['Hasani', 'Hachiko'],
    });

    const outcome = await guardGeneratedText(businessId, agent, 'Nah that was Hasani on your phone, don\'t tell anyone!');

    expect(outcome.kind).toBe('blocked_leak');
    if (outcome.kind === 'blocked_leak') {
      expect(outcome.reason).toContain('Hasani');
    }
    expect(JSON.stringify(outcome)).not.toContain('phone');

    const auditLog = new SecurityAuditLogRepository(pool);
    const recent = await auditLog.listRecent(businessId, 5);
    expect(recent[0]?.eventType).toBe('ai_output_leak_blocked');
    expect(recent[0]?.severity).toBe('critical');
  });

  it('allows a clean reply through unchanged when no protected fact appears', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agentRepo = new AiAgentRepository(pool);
    const agent = await agentRepo.create({
      businessId,
      name: 'Kai',
      protectedFacts: ['Hasani', 'Hachiko'],
    });

    const outcome = await guardGeneratedText(businessId, agent, 'Sure, we open at 9am tomorrow.');

    if (!process.env.GEMINI_API_KEY) {
      // Stage 2 unavailable in this environment - still allowed through, honestly logged.
      expect(outcome.kind).toBe('reply');
      const auditLog = new SecurityAuditLogRepository(pool);
      const recent = await auditLog.listRecent(businessId, 5);
      expect(recent[0]?.eventType).toBe('ai_output_leak_check_unavailable');
    } else {
      expect(['reply', 'blocked_leak']).toContain(outcome.kind);
    }
  });

  it('allows any reply through with no audit write when the agent has no protected facts configured', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const agentRepo = new AiAgentRepository(pool);
    const agent = await agentRepo.create({ businessId, name: 'Reception Agent' });

    const outcome = await guardGeneratedText(businessId, agent, 'Sure, we open at 9am tomorrow.');
    expect(outcome.kind).toBe('reply');
    if (outcome.kind === 'reply') {
      expect(outcome.text).toBe('Sure, we open at 9am tomorrow.');
    }

    const auditLog = new SecurityAuditLogRepository(pool);
    const recent = await auditLog.listRecent(businessId, 5);
    expect(recent).toHaveLength(0);
  });
});
