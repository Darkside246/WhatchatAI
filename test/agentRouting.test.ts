import { beforeEach, describe, expect, it } from 'vitest';
import { register } from '../src/services/authService.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { routeInboundMessage, resolveEscalationAgent } from '../src/services/agentRoutingService.js';
import { resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

describe('agentRoutingService (real config-driven agent selection)', () => {
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register(
      { email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      device,
    );
    businessId = owner.business.id;
  });

  it('returns no_agent - never a fabricated fallback - when the business has no active agent', async () => {
    const decision = await routeInboundMessage(businessId, 'hello there');
    expect(decision.outcome).toBe('no_agent');
  });

  it('routes to the agent whose real trigger keyword matched', async () => {
    await workspaceService.createAgent(businessId, { name: 'Generalist' });
    const bookings = await workspaceService.createAgent(businessId, {
      name: 'Bookings',
      category: 'bookings',
      triggerKeywords: ['appointment', 'booking'],
    });

    const decision = await routeInboundMessage(businessId, 'Can I move my appointment to Friday?');
    expect(decision.outcome).toBe('route');
    if (decision.outcome === 'route') {
      expect(decision.agent.id).toBe(bookings.id);
      expect(decision.matchedKeyword).toBe('appointment');
    }
  });

  it('breaks a tie between two matching agents using the real priority field', async () => {
    await workspaceService.createAgent(businessId, {
      name: 'Low priority',
      triggerKeywords: ['quote'],
      priority: 1,
    });
    const urgent = await workspaceService.createAgent(businessId, {
      name: 'High priority',
      triggerKeywords: ['quote'],
      priority: 99,
    });

    const decision = await routeInboundMessage(businessId, 'Please send me a quote');
    expect(decision.outcome).toBe('route');
    if (decision.outcome === 'route') expect(decision.agent.id).toBe(urgent.id);
  });

  it('falls back to a general-purpose agent when no trigger keyword matches', async () => {
    const generalist = await workspaceService.createAgent(businessId, { name: 'Generalist' });
    await workspaceService.createAgent(businessId, { name: 'Bookings', triggerKeywords: ['appointment'] });

    const decision = await routeInboundMessage(businessId, 'just saying hi');
    expect(decision.outcome).toBe('route');
    if (decision.outcome === 'route') {
      expect(decision.agent.id).toBe(generalist.id);
      expect(decision.matchedKeyword).toBeNull();
    }
  });

  it('returns no_agent when every agent is keyword-scoped and none matched', async () => {
    await workspaceService.createAgent(businessId, { name: 'Bookings', triggerKeywords: ['appointment'] });
    const decision = await routeInboundMessage(businessId, 'unrelated question');
    expect(decision.outcome).toBe('no_agent');
  });

  it('a blocked keyword stops the AI entirely, even when another agent would have matched', async () => {
    await workspaceService.createAgent(businessId, {
      name: 'Sales',
      triggerKeywords: ['price'],
      priority: 10,
    });
    await workspaceService.createAgent(businessId, {
      name: 'Guard',
      blockedKeywords: ['refund'],
      priority: 1,
    });

    const decision = await routeInboundMessage(businessId, 'What is the price - actually I want a refund');
    expect(decision.outcome).toBe('escalate_to_human');
    if (decision.outcome === 'escalate_to_human') expect(decision.matchedKeyword).toBe('refund');
  });

  it('matches keywords on word boundaries, so "art" never triggers on "start"', async () => {
    await workspaceService.createAgent(businessId, { name: 'Art desk', triggerKeywords: ['art'] });

    const falsePositive = await routeInboundMessage(businessId, 'when can we start the job');
    expect(falsePositive.outcome).toBe('no_agent');

    const realMatch = await routeInboundMessage(businessId, 'do you sell art supplies?');
    expect(realMatch.outcome).toBe('route');
  });

  it('is case-insensitive and tolerates punctuation around a real keyword', async () => {
    await workspaceService.createAgent(businessId, { name: 'Bookings', triggerKeywords: ['booking'] });
    const decision = await routeInboundMessage(businessId, 'BOOKING, please!');
    expect(decision.outcome).toBe('route');
  });

  it('never routes to a paused agent', async () => {
    const agent = await workspaceService.createAgent(businessId, { name: 'Paused one' });
    await workspaceService.updateAgentStatus(businessId, agent.id, 'PAUSED');

    const decision = await routeInboundMessage(businessId, 'anything at all');
    expect(decision.outcome).toBe('no_agent');
  });

  it('resolves a real escalation target, and refuses a paused one', async () => {
    const senior = await workspaceService.createAgent(businessId, { name: 'Senior' });
    const junior = await workspaceService.createAgent(businessId, { name: 'Junior' });
    const linked = await workspaceService.updateAgent(businessId, junior.id, {
      name: 'Junior',
      escalateToAgentId: senior.id,
    });

    expect((await resolveEscalationAgent(linked))?.id).toBe(senior.id);

    await workspaceService.updateAgentStatus(businessId, senior.id, 'PAUSED');
    expect(await resolveEscalationAgent(linked)).toBeNull();
  });
});
