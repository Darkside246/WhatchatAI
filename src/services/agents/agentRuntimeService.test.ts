import { describe, expect, it } from 'vitest';
import { AgentRuntimeService } from './agentRuntimeService.js';
import type { AgentExecutionResult, AgentRuntimeAdapter, AgentTask } from '../../domain/platform/contracts.js';

const task: AgentTask = {
  id: 'task-1',
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  capabilityId: 'maintenance.triage',
  input: { message: 'AC is not working' },
  contextEntityIds: ['property-1'],
  correlationId: 'corr-1',
  createdAt: new Date().toISOString(),
};

function fakeRuntime(): AgentRuntimeAdapter {
  return {
    name: 'fake-runtime',
    async execute(_task, _context): Promise<AgentExecutionResult> {
      return { status: 'completed', executionId: 'exec-1', output: { ok: true }, actionRequests: [] };
    },
    async cancel() {},
    async health() { return { healthy: true }; },
  };
}

describe('AgentRuntimeService', () => {
  it('registers and executes through a named runtime', async () => {
    const service = new AgentRuntimeService();
    service.register(fakeRuntime());
    const result = await service.execute('fake-runtime', task, { propertyId: 'property-1' });
    expect(result.executionId).toBe('exec-1');
    expect(service.list()).toEqual(['fake-runtime']);
  });

  it('rejects unknown runtimes', async () => {
    const service = new AgentRuntimeService();
    await expect(service.execute('missing', task, {})).rejects.toThrow('not registered');
  });

  it('does not silently accept missing tenant identity', async () => {
    const service = new AgentRuntimeService();
    service.register(fakeRuntime());
    await expect(service.execute('fake-runtime', { ...task, tenantId: '' }, {})).rejects.toThrow('tenantId');
  });
});
