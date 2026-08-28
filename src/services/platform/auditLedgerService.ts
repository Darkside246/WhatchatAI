import { createHash } from 'node:crypto';
import { AuditEventSchema, type AuditEvent } from '../../domain/platform/contracts.js';
import type { PlatformAuditLedgerRepository } from '../../repositories/platformAuditLedgerRepository.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function digest(event: Omit<AuditEvent, 'payloadHash'>): string {
  return createHash('sha256').update(canonical(event)).digest('hex');
}

export class AuditLedgerService {
  private readonly chains = new Map<string, AuditEvent[]>();
  private repository: PlatformAuditLedgerRepository | null = null;

  setRepository(repo: PlatformAuditLedgerRepository): void { this.repository = repo; }

  append(input: Omit<AuditEvent, 'payloadHash' | 'previousHash'>): AuditEvent {
    const parsed = AuditEventSchema.pick({ id: true, tenantId: true, eventType: true, actor: true, correlationId: true, actionRequestId: true, payload: true, occurredAt: true, metadata: true }).parse(input);
    const chain = this.chains.get(parsed.tenantId) ?? [];
    const previousHash = chain.at(-1)?.payloadHash;
    const unsigned = { ...parsed, previousHash } as Omit<AuditEvent, 'payloadHash'>;
    const event = AuditEventSchema.parse({ ...unsigned, payloadHash: digest(unsigned) });
    chain.push(event);
    this.chains.set(parsed.tenantId, chain);
    if (this.repository) {
      void this.repository.append(parsed.tenantId, event).catch((err: unknown) => {
        console.error('[AuditLedger] DB write failed:', err);
      });
    }
    return event;
  }

  list(tenantId: string): AuditEvent[] { return [...(this.chains.get(tenantId) ?? [])]; }

  verify(tenantId: string): boolean {
    const chain = this.chains.get(tenantId) ?? [];
    return chain.every((event, index) => {
      const previous = index > 0 ? chain[index - 1]!.payloadHash : undefined;
      if (event.previousHash !== previous) return false;
      const { payloadHash: _payloadHash, ...unsigned } = event;
      return event.payloadHash === digest(unsigned);
    });
  }

  clear(tenantId?: string): void { if (tenantId) this.chains.delete(tenantId); else this.chains.clear(); }
}

export const auditLedgerService = new AuditLedgerService();
