import { describe, expect, it } from 'vitest';
import { VoiceGateway } from './voiceGateway.js';

describe('VoiceGateway', () => {
  it('registers and lists voice providers', () => {
    const gateway = new VoiceGateway();
    gateway.register({ name: 'test', async startOutbound() { return { externalCallId: 'call-1' }; }, async health() { return { healthy: true }; } });
    expect(gateway.list()).toEqual(['test']);
    expect(gateway.get('test')?.name).toBe('test');
  });
  it('creates tenant-bound call state', () => {
    const gateway = new VoiceGateway();
    const call = gateway.createCall({ tenantId: 'tenant-1', from: '+12465550000', to: '+12465550001' });
    expect(call.tenantId).toBe('tenant-1');
    expect(call.status).toBe('RINGING');
  });
  it('rejects duplicate provider registration', () => {
    const gateway = new VoiceGateway();
    const provider = { name: 'test', async startOutbound() { return { externalCallId: 'call-1' }; }, async health() { return { healthy: true }; } };
    gateway.register(provider); expect(() => gateway.register(provider)).toThrow('already registered');
  });
});
