import { describe, expect, it } from 'vitest';
import {
  businessExecutionContextForUser,
  businessExecutionContextForAiCell,
  businessExecutionContextForSystem,
} from '../src/domain/businessExecutionContext.js';

describe('BusinessExecutionContext factories (pure - no I/O)', () => {
  it('builds a user context carrying the real businessId/userId and a fresh requestId', () => {
    const context = businessExecutionContextForUser('business-1', 'user-1');
    expect(context).toMatchObject({ businessId: 'business-1', actorType: 'user', actorId: 'user-1' });
    expect(context.requestId).toBeTruthy();
  });

  it('builds an ai context carrying the cellId as actorId', () => {
    const context = businessExecutionContextForAiCell('business-1', 'cell-1');
    expect(context).toMatchObject({ businessId: 'business-1', actorType: 'ai', actorId: 'cell-1' });
  });

  it('builds a system context with no actorId - no single human/agent behind a scheduled sweep', () => {
    const context = businessExecutionContextForSystem('business-1');
    expect(context.actorType).toBe('system');
    expect(context.actorId).toBeUndefined();
  });

  it('never reuses a requestId across two calls, even for the same business', () => {
    const first = businessExecutionContextForSystem('business-1');
    const second = businessExecutionContextForSystem('business-1');
    expect(first.requestId).not.toBe(second.requestId);
  });
});
