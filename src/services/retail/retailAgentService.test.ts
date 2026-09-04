import { beforeEach, describe, expect, it } from 'vitest';
import type { AIProviderAdapter, CommunicationEvent } from '../../domain/platform/contracts.js';
import { skillRegistry, retailOrderTriageSkill } from '../platform/skillRegistry.js';
import { runRetailOrderTriage } from './retailAgentService.js';
import { AiGateway } from '../ai/aiGateway.js';

function event(text: string, overrides: Partial<CommunicationEvent> = {}): CommunicationEvent {
  return {
    id: 'event-1',
    tenantId: 'tenant-1',
    channel: 'WHATSAPP',
    conversationId: 'conversation-1',
    sender: { address: '+12465551234', role: 'GUEST' },
    message: { type: 'TEXT', text },
    occurredAt: '2026-01-01T00:00:00.000Z',
    correlationId: 'corr-1',
    idempotencyKey: 'idem-1',
    ...overrides,
  };
}

function provider(text: string): AIProviderAdapter & { model: string; priority: number } {
  return {
    name: 'test-provider', model: 'test-model', priority: 1,
    async capabilities() { return { text: true, vision: false, audio: false, video: false, documents: false, functionCalling: false }; },
    async generate() { return { provider: 'test-provider', text }; },
  };
}

describe('runRetailOrderTriage', () => {
  beforeEach(() => {
    skillRegistry.clear();
    skillRegistry.register({ ...retailOrderTriageSkill, enabled: true });
  });

  it('escalates deterministic risk signals without calling the model', async () => {
    const gateway = new AiGateway();
    gateway.register({ ...provider('{"category":"NEW_ORDER","urgency":"ROUTINE","confidence":1,"summary":"order","items":[],"missingInformation":[],"recommendedNextStep":"CREATE_ORDER"}'), priority: 1 });

    const result = await runRetailOrderTriage({
      event: event('I want to dispute the charge, this was never authorized.'),
      context: { relevantProducts: [] },
      agentId: 'agent-retail',
      gateway,
    });

    expect(result.classification.urgency).toBe('ESCALATE');
    expect(result.classification.source).toBe('RULES');
    expect(result.actionRequests[0]?.type).toBe('retail.request_human_review');
    expect(result.actionRequests[0]?.requestedBy.id).toBe('agent-retail');
    expect(result.actionRequests[0]?.approval.required).toBe(false);
  });

  it('accepts valid structured AI output for a new order and produces an approval-gated action', async () => {
    const gateway = new AiGateway();
    gateway.register({
      ...provider(JSON.stringify({
        category: 'NEW_ORDER', urgency: 'ROUTINE', confidence: 0.9, summary: '2x Blue T-Shirt',
        items: [{ productNameOrRef: 'Blue T-Shirt', quantity: 2 }], missingInformation: [], recommendedNextStep: 'CREATE_ORDER',
      })),
      priority: 1,
    });

    const result = await runRetailOrderTriage({
      event: event("I'd like to order 2 blue t-shirts please, and I'm ready to check out now"),
      context: { relevantProducts: [] },
      agentId: 'agent-retail',
      gateway,
    });

    expect(result.classification.category).toBe('NEW_ORDER');
    expect(result.classification.confidence).toBe(0.9);
    expect(result.actionRequests).toHaveLength(1);
    expect(result.actionRequests[0]?.type).toBe('retail.create_order');
    expect(result.actionRequests[0]?.approval.required).toBe(true);
  });

  it('fails safe when AI output is invalid JSON', async () => {
    const gateway = new AiGateway();
    gateway.register({ ...provider('not-json'), priority: 1 });

    const result = await runRetailOrderTriage({
      event: event("I'd like to order something but I'm not sure exactly what yet, thinking it over"),
      context: { relevantProducts: [] },
      agentId: 'agent-retail',
      gateway,
    });

    expect(result.classification.confidence).toBe(0.2);
    expect(result.actionRequests[0]?.type).toBe('retail.request_human_review');
  });
});
