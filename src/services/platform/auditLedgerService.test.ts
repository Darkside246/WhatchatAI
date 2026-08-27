import { beforeEach, describe, expect, it } from 'vitest';
import { auditLedgerService } from './auditLedgerService.js';

describe('AuditLedgerService', () => {
  beforeEach(() => auditLedgerService.clear());

  it('creates a verifiable tenant-specific hash chain', () => {
    auditLedgerService.append({ id: '1', tenantId: 'tenant-1', eventType: 'ONE', actor: { kind: 'SYSTEM', id: 'test' }, correlationId: 'corr', payload: { value: 1 }, occurredAt: '2026-01-01T00:00:00.000Z' });
    auditLedgerService.append({ id: '2', tenantId: 'tenant-1', eventType: 'TWO', actor: { kind: 'SYSTEM', id: 'test' }, correlationId: 'corr', payload: { value: 2 }, occurredAt: '2026-01-01T00:00:01.000Z' });
    expect(auditLedgerService.verify('tenant-1')).toBe(true);
  });

  it('detects tampering with an earlier event payload', () => {
    auditLedgerService.append({ id: '1', tenantId: 'tenant-1', eventType: 'ONE', actor: { kind: 'SYSTEM', id: 'test' }, correlationId: 'corr', payload: { value: 1 }, occurredAt: '2026-01-01T00:00:00.000Z' });
    auditLedgerService.append({ id: '2', tenantId: 'tenant-1', eventType: 'TWO', actor: { kind: 'SYSTEM', id: 'test' }, correlationId: 'corr', payload: { value: 2 }, occurredAt: '2026-01-01T00:00:01.000Z' });

    // list() returns a new array, so replacing an element does not mutate the
    // ledger. Mutate the stored event payload to exercise integrity verification.
    const chain = auditLedgerService.list('tenant-1');
    (chain[0]!.payload as { value: number }).value = 999;

    expect(auditLedgerService.verify('tenant-1')).toBe(false);
  });

  it('keeps tenant chains isolated', () => {
    auditLedgerService.append({ id: '1', tenantId: 'tenant-a', eventType: 'ONE', actor: { kind: 'SYSTEM', id: 'test' }, correlationId: 'corr', payload: {}, occurredAt: '2026-01-01T00:00:00.000Z' });
    auditLedgerService.append({ id: '2', tenantId: 'tenant-b', eventType: 'ONE', actor: { kind: 'SYSTEM', id: 'test' }, correlationId: 'corr', payload: {}, occurredAt: '2026-01-01T00:00:00.000Z' });
    expect(auditLedgerService.list('tenant-a')).toHaveLength(1);
    expect(auditLedgerService.list('tenant-b')).toHaveLength(1);
  });
});
