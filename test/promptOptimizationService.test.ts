import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { register } from '../src/services/authService.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import {
  importPromptOptimization,
  listPromptOptimizations,
  approveOptimization,
  rejectOptimization,
  isAgentNotFoundError,
  isInvalidPromptOptimizationError,
  isPromptOptimizationNotFoundError,
  isPromptOptimizationAlreadyDecidedError,
} from '../src/services/ai/promptOptimizationService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

describe('promptOptimizationService (the controlled interface between the offline DSPy tool and a live agent - real Postgres)', () => {
  let businessId: string;
  let ownerId: string;
  let agentId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    ownerId = owner.user.id;
    const agent = await new AiAgentRepository(pool).create({
      businessId,
      name: 'Reception Agent',
      systemInstruction: 'Original operator-authored instruction.',
    });
    agentId = agent.id;
  });

  it('imports a real optimization as pending_review, snapshotting the agent baseline, without ever touching the live agent', async () => {
    const optimization = await importPromptOptimization(businessId, agentId, {
      optimizedInstruction: 'A better instruction proposed by DSPy.',
      metricName: 'reply_quality_metric',
      metricScore: 0.87,
      datasetSummary: { exampleCount: 12, optimizer: 'bootstrap' },
    });

    expect(optimization.status).toBe('pending_review');
    expect(optimization.baselineInstruction).toBe('Original operator-authored instruction.');
    expect(optimization.optimizedInstruction).toBe('A better instruction proposed by DSPy.');
    expect(optimization.metricScore).toBeCloseTo(0.87);

    // The live agent is completely unaffected by import alone.
    const agent = await new AiAgentRepository(pool).findById(agentId);
    expect(agent?.systemInstruction).toBe('Original operator-authored instruction.');

    const log = await new SecurityAuditLogRepository(pool).listRecent(businessId);
    expect(log.some((entry) => entry.eventType === 'ai_prompt_optimization_imported')).toBe(true);
  });

  it('rejects an import for an agent that does not exist or belongs to a different business', async () => {
    await expect(
      importPromptOptimization(businessId, '00000000-0000-0000-0000-000000000000', { optimizedInstruction: 'x' }),
    ).rejects.toThrow();
    try {
      await importPromptOptimization(businessId, '00000000-0000-0000-0000-000000000000', { optimizedInstruction: 'x' });
    } catch (error) {
      expect(isAgentNotFoundError(error)).toBe(true);
    }

    const otherBusinessId = await createTestBusiness('Other Business');
    await expect(importPromptOptimization(otherBusinessId, agentId, { optimizedInstruction: 'x' })).rejects.toThrow();
  });

  it('rejects an empty or absurdly long optimized instruction, never storing garbage from an untrusted offline process', async () => {
    await expect(importPromptOptimization(businessId, agentId, { optimizedInstruction: '   ' })).rejects.toThrow();
    try {
      await importPromptOptimization(businessId, agentId, { optimizedInstruction: '   ' });
    } catch (error) {
      expect(isInvalidPromptOptimizationError(error)).toBe(true);
    }

    await expect(
      importPromptOptimization(businessId, agentId, { optimizedInstruction: 'x'.repeat(8_001) }),
    ).rejects.toThrow();
  });

  it('approving a pending optimization applies it to the live agent through the real AiAgentRepository.update() path, and audits it', async () => {
    const optimization = await importPromptOptimization(businessId, agentId, { optimizedInstruction: 'A genuinely better instruction.' });

    const approved = await approveOptimization(businessId, agentId, optimization.id, ownerId);
    expect(approved.status).toBe('approved');
    expect(approved.reviewedBy).toBe(ownerId);

    const agent = await new AiAgentRepository(pool).findById(agentId);
    expect(agent?.systemInstruction).toBe('A genuinely better instruction.');
    // Every other field survives untouched - approval only ever replaces systemInstruction.
    expect(agent?.name).toBe('Reception Agent');

    const log = await new SecurityAuditLogRepository(pool).listRecent(businessId);
    expect(log.some((entry) => entry.eventType === 'ai_prompt_optimization_approved')).toBe(true);
  });

  it('rejecting a pending optimization never touches the live agent', async () => {
    const optimization = await importPromptOptimization(businessId, agentId, { optimizedInstruction: 'Should never be applied.' });

    const rejected = await rejectOptimization(businessId, agentId, optimization.id, ownerId, 'Not accurate enough.');
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('Not accurate enough.');

    const agent = await new AiAgentRepository(pool).findById(agentId);
    expect(agent?.systemInstruction).toBe('Original operator-authored instruction.');

    const log = await new SecurityAuditLogRepository(pool).listRecent(businessId);
    expect(log.some((entry) => entry.eventType === 'ai_prompt_optimization_rejected')).toBe(true);
  });

  it('an already-decided optimization can never be re-decided (no double-approve, no approve-after-reject)', async () => {
    const optimization = await importPromptOptimization(businessId, agentId, { optimizedInstruction: 'Once only.' });
    await approveOptimization(businessId, agentId, optimization.id, ownerId);

    await expect(approveOptimization(businessId, agentId, optimization.id, ownerId)).rejects.toThrow();
    try {
      await approveOptimization(businessId, agentId, optimization.id, ownerId);
    } catch (error) {
      expect(isPromptOptimizationAlreadyDecidedError(error)).toBe(true);
    }
    await expect(rejectOptimization(businessId, agentId, optimization.id, ownerId, null)).rejects.toThrow();
  });

  it('refuses to approve or reject an optimization belonging to a different business or agent (real tenant/agent isolation)', async () => {
    const optimization = await importPromptOptimization(businessId, agentId, { optimizedInstruction: 'Tenant-scoped.' });

    const otherBusinessId = await createTestBusiness('Other Business');
    await expect(approveOptimization(otherBusinessId, agentId, optimization.id, ownerId)).rejects.toThrow();
    try {
      await approveOptimization(otherBusinessId, agentId, optimization.id, ownerId);
    } catch (error) {
      expect(isAgentNotFoundError(error)).toBe(true);
    }

    const otherAgent = await new AiAgentRepository(pool).create({ businessId, name: 'Other Agent' });
    await expect(approveOptimization(businessId, otherAgent.id, optimization.id, ownerId)).rejects.toThrow();
    try {
      await approveOptimization(businessId, otherAgent.id, optimization.id, ownerId);
    } catch (error) {
      expect(isPromptOptimizationNotFoundError(error)).toBe(true);
    }
  });

  it('lists optimizations newest-first, scoped to one agent', async () => {
    const first = await importPromptOptimization(businessId, agentId, { optimizedInstruction: 'First.' });
    const second = await importPromptOptimization(businessId, agentId, { optimizedInstruction: 'Second.' });

    const list = await listPromptOptimizations(businessId, agentId);
    expect(list.map((o) => o.id)).toEqual([second.id, first.id]);
  });
});
