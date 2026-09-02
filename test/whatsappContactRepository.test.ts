import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Real-Postgres coverage for WhatsAppContactRepository - specifically the
 * `username` field (WhatsApp's own @handle feature, distinct from the
 * mutable pushName) and the `findByIds` batch method added for
 * workspaceService.ts's group-chat sender-name resolution.
 */
describe('WhatsAppContactRepository (real Postgres)', () => {
  it('round-trips a real username through upsert, and a later update without one preserves the stored value', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const repo = new WhatsAppContactRepository(pool);

    const first = await repo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15559998888@s.whatsapp.net',
      jidKind: 'individual',
      pushName: 'Alex',
      username: 'alex.handle',
    });
    expect(first.username).toBe('alex.handle');

    // A later sync event carrying no username (e.g. a pushName-only
    // message) must not null out the previously captured one - same
    // COALESCE semantics as every other name field on this table.
    const second = await repo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15559998888@s.whatsapp.net',
      jidKind: 'individual',
      pushName: 'Alex Updated',
    });
    expect(second.username).toBe('alex.handle');
    expect(second.pushName).toBe('Alex Updated');
  });

  it('findByIds returns exactly the requested contacts, and an empty array for an empty input without querying', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const repo = new WhatsAppContactRepository(pool);

    const a = await repo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, whatsappJid: '15551110001@s.whatsapp.net', jidKind: 'individual', pushName: 'A' });
    const b = await repo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, whatsappJid: '15551110002@s.whatsapp.net', jidKind: 'individual', pushName: 'B' });
    await repo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, whatsappJid: '15551110003@s.whatsapp.net', jidKind: 'individual', pushName: 'C (not requested)' });

    const found = await repo.findByIds([a.id, b.id]);
    expect(found.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());

    expect(await repo.findByIds([])).toEqual([]);
  });
});
