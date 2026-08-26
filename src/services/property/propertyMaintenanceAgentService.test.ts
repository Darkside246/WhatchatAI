import { beforeEach, describe, expect, it } from 'vitest';
import type { AIProviderAdapter, CommunicationEvent } from '../../domain/platform/contracts.js';
import { skillRegistry, propertyMaintenanceTriageSkill } from '../platform/skillRegistry.js';
import { runPropertyMaintenanceTriage } from './propertyMaintenanceAgentService.js';
import { AiGateway } from '../ai/aiGateway.js';

function event(text: string, overrides: Partial<CommunicationEvent> = {}): CommunicationEvent {
  return {
    id: 'event-1',
    tenantId: 'tenant-1',
    channel: 'WHATSAPP',
    conversationId: 'conversation-1',
    sender: { address: '+12465551234', role: 'GUEST' },
    propertyId: 'property-1',
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
    async capabilities() { return { text: true, vision: false, audio: false, video: false, documents: false }; },
    async generate() { return { provider: 'test-provider', text }; },
  };
}

describe('runPropertyMaintenanceTriage', () => {
  beforeEach(() => {
    skillRegistry.clear();
    skillRegistry.register({ ...propertyMaintenanceTriageSkill, enabled: true });
  });

  it('escalates deterministic life-safety signals without calling the model', async () => {
    const gateway = new AiGateway();
    gateway.register({ ...provider('{"category":"OTHER","urgency":"ROUTINE","confidence":1,"summary":"unsafe","missingInformation":[],"recommendedNextStep":"CREATE_WORK_ORDER"}') , priority: 1 });

    const result = await runPropertyMaintenanceTriage({
      event: event('There are sparks and a burning smell from the outlet.'),
      context: { propertyId: 'property-1' },
      agentId: 'agent-maintenance',
      gateway,
    });

    expect(result.classification.urgency).toBe('EMERGENCY');
    expect(result.classification.source).toBe('RULES');
    expect(result.actionRequests[0]?.type).toBe('maintenance.request_human_review');
    expect(result.actionRequests[0]?.requestedBy.id).toBe('agent-maintenance');
  });

  it('accepts valid structured AI output for a non-emergency request', async () => {
    const gateway = new AiGateway();
    gateway.register({ ...provider(JSON.stringify({ category: 'HVAC', urgency: 'PRIORITY', confidence: 0.88, summary: 'AC not cooling', missingInformation: ['photo of thermostat'], recommendedNextStep: 'REQUEST_MEDIA' })), priority: 1 });

    const result = await runPropertyMaintenanceTriage({
      event: event('The AC is not cooling.'),
      context: { propertyId: 'property-1', assetType: 'AC' },
      agentId: 'agent-maintenance',
      gateway,
    });

    expect(result.classification.category).toBe('HVAC');
    expect(result.classification.confidence).toBe(0.88);
    expect(result.replyGuidance).toEqual(['Request: photo of thermostat']);
    expect(result.actionRequests).toEqual([]);
  });

  it('fails safe when AI output is invalid JSON', async () => {
    const gateway = new AiGateway();
    gateway.register({ ...provider('not-json'), priority: 1 });

    const result = await runPropertyMaintenanceTriage({
      event: event('The pool equipment is making a strange noise.'),
      context: { propertyId: 'property-1' },
      agentId: 'agent-maintenance',
      gateway,
    });

    expect(result.classification.confidence).toBe(0.2);
    expect(result.actionRequests[0]?.type).toBe('maintenance.request_human_review');
  });
});
