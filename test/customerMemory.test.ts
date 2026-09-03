import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { CustomerMemoryRepository, CustomerMemoryConflictError } from '../src/repositories/customerMemoryRepository.js';
import { CustomerIdentityRepository } from '../src/repositories/customerIdentityRepository.js';
import { applyCustomerMemoryUpdate } from '../src/services/state/conversationStateWriter.js';
import { gatherAiHandoffContext } from '../src/services/aiContextGathererService.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('CustomerMemoryRepository (real Postgres - migration 959, layer 2 of layered memory)', () => {
  let businessId: string;
  let customerId: string;
  let repo: CustomerMemoryRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    const { rows } = await pool.query<{ id: string }>('INSERT INTO customers (business_id) VALUES ($1) RETURNING id', [businessId]);
    customerId = rows[0]!.id;
    repo = new CustomerMemoryRepository(pool);
  });

  it('find() returns null for a customer with no memory row yet', async () => {
    expect(await repo.find(businessId, customerId)).toBeNull();
  });

  it('getOrCreate() creates a real empty row on first call, and never overwrites it on a second call', async () => {
    const first = await repo.getOrCreate(businessId, customerId);
    expect(first.confirmedFacts).toEqual([]);
    expect(first.version).toBe(1);

    await repo.update(businessId, customerId, 1, [{ key: 'k', value: 'v', origin: 'user_confirmed', confirmedAt: new Date().toISOString() }]);
    const second = await repo.getOrCreate(businessId, customerId);
    expect(second.confirmedFacts).toHaveLength(1); // not reset back to empty
  });

  it('update() rejects a stale version with a real CAS conflict', async () => {
    await repo.getOrCreate(businessId, customerId);
    await expect(
      repo.update(businessId, customerId, 999, [{ key: 'k', value: 'v', origin: 'user_confirmed', confirmedAt: new Date().toISOString() }]),
    ).rejects.toThrow(CustomerMemoryConflictError);
  });

  it('never leaks another business\'s customer memory', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const { rows } = await pool.query<{ id: string }>('INSERT INTO customers (business_id) VALUES ($1) RETURNING id', [otherBusinessId]);
    const otherCustomerId = rows[0]!.id;
    await repo.update(businessId, customerId, (await repo.getOrCreate(businessId, customerId)).version, [
      { key: 'secret', value: 'only-this-business', origin: 'user_confirmed', confirmedAt: new Date().toISOString() },
    ]);
    expect(await repo.find(otherBusinessId, otherCustomerId)).toBeNull();
  });

  describe('deleteByCustomer (Section 75-91 - single-subject erasure, the counterpart to exportCrmContactData)', () => {
    it('actually erases a real memory row and reports true', async () => {
      await repo.update(businessId, customerId, (await repo.getOrCreate(businessId, customerId)).version, [
        { key: 'k', value: 'v', origin: 'user_confirmed', confirmedAt: new Date().toISOString() },
      ]);
      expect(await repo.deleteByCustomer(businessId, customerId)).toBe(true);
      expect(await repo.find(businessId, customerId)).toBeNull();
    });

    it('is idempotent - reports false (not an error) for a customer with no memory row', async () => {
      expect(await repo.deleteByCustomer(businessId, customerId)).toBe(false);
    });

    it('never erases another business\'s customer memory for a colliding customerId', async () => {
      const otherBusinessId = await createTestBusiness('Other Business');
      const { rows } = await pool.query<{ id: string }>('INSERT INTO customers (business_id) VALUES ($1) RETURNING id', [otherBusinessId]);
      const otherCustomerId = rows[0]!.id;
      await repo.update(businessId, customerId, (await repo.getOrCreate(businessId, customerId)).version, [
        { key: 'secret', value: 'must-survive', origin: 'user_confirmed', confirmedAt: new Date().toISOString() },
      ]);

      await repo.deleteByCustomer(otherBusinessId, otherCustomerId);

      const stillThere = await repo.find(businessId, customerId);
      expect(stillThere?.confirmedFacts).toEqual([expect.objectContaining({ key: 'secret', value: 'must-survive' })]);
    });
  });
});

describe('applyCustomerMemoryUpdate (real Postgres write-through)', () => {
  let businessId: string;
  let customerId: string;
  let repo: CustomerMemoryRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    const { rows } = await pool.query<{ id: string }>('INSERT INTO customers (business_id) VALUES ($1) RETURNING id', [businessId]);
    customerId = rows[0]!.id;
    repo = new CustomerMemoryRepository(pool);
  });

  it('an empty/undefined confirmFacts list is a real no-op - never creates a row', async () => {
    await applyCustomerMemoryUpdate(repo, businessId, customerId, undefined);
    await applyCustomerMemoryUpdate(repo, businessId, customerId, []);
    expect(await repo.find(businessId, customerId)).toBeNull();
  });

  it('writes a real confirmed fact, unconditionally stamped user_confirmed', async () => {
    await applyCustomerMemoryUpdate(repo, businessId, customerId, [{ key: 'unit_number', value: '4B' }]);
    const memory = await repo.find(businessId, customerId);
    expect(memory?.confirmedFacts).toEqual([expect.objectContaining({ key: 'unit_number', value: '4B', origin: 'user_confirmed' })]);
  });

  it('a repeated fact with the same key overwrites rather than duplicates, across separate calls (separate conversations)', async () => {
    await applyCustomerMemoryUpdate(repo, businessId, customerId, [{ key: 'unit_number', value: '4B' }]);
    await applyCustomerMemoryUpdate(repo, businessId, customerId, [{ key: 'unit_number', value: '5C' }]);
    const memory = await repo.find(businessId, customerId);
    expect(memory?.confirmedFacts).toHaveLength(1);
    expect(memory?.confirmedFacts[0]?.value).toBe('5C');
  });

  it('retries through a genuine optimistic-concurrency conflict rather than losing the update', async () => {
    const state = await repo.getOrCreate(businessId, customerId);
    const realUpdate = repo.update.bind(repo);
    let calls = 0;
    vi.spyOn(repo, 'update').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) {
        await realUpdate(businessId, customerId, state.version, [{ key: 'concurrent', value: 'writer', origin: 'user_confirmed', confirmedAt: new Date().toISOString() }]);
      }
      return realUpdate(...args);
    });

    await applyCustomerMemoryUpdate(repo, businessId, customerId, [{ key: 'k', value: 'v' }]);

    expect(calls).toBeGreaterThanOrEqual(2);
    const final = await repo.find(businessId, customerId);
    expect(final?.confirmedFacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'concurrent', value: 'writer' }), expect.objectContaining({ key: 'k', value: 'v' })]),
    );
  });
});

describe('gatherAiHandoffContext resolves and surfaces customer-level memory (real Postgres)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('resolves a real customerId and customerMemory for a contact linked to a customer, and surfaces facts confirmed in an earlier conversation', async () => {
    const contact = await new WhatsAppContactRepository(pool).upsertFromWhatsApp({
      businessId, whatsappAccountId: accountId, whatsappJid: '15550001111@s.whatsapp.net', jidKind: 'individual', phoneNumber: '+15550001111', pushName: 'Returning Customer',
    });
    const customerId = await new CustomerIdentityRepository(pool).getOrCreateForWhatsAppContact(businessId, contact.id, contact.displayName);
    const memoryRepo = new CustomerMemoryRepository(pool);
    await applyCustomerMemoryUpdate(memoryRepo, businessId, customerId, [{ key: 'preferred_time', value: 'mornings' }]);

    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId, whatsappAccountId: accountId, chatJid: '15550001111@s.whatsapp.net', jidKind: 'individual', chatType: 'individual', contactId: contact.id,
    });

    const context = await gatherAiHandoffContext({ businessId, chatId: chat.id, contactId: contact.id, queryText: 'hi again' });

    expect(context.customerId).toBe(customerId);
    expect(context.customerMemory?.confirmedFacts).toEqual([expect.objectContaining({ key: 'preferred_time', value: 'mornings' })]);
  });

  it('resolves customerId to null (not throw, not fabricate one) for a contact never linked to a customer', async () => {
    const contact = await new WhatsAppContactRepository(pool).upsertFromWhatsApp({
      businessId, whatsappAccountId: accountId, whatsappJid: '15550002222@s.whatsapp.net', jidKind: 'individual', phoneNumber: '+15550002222', pushName: 'Never Linked',
    });
    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId, whatsappAccountId: accountId, chatJid: '15550002222@s.whatsapp.net', jidKind: 'individual', chatType: 'individual', contactId: contact.id,
    });

    const context = await gatherAiHandoffContext({ businessId, chatId: chat.id, contactId: contact.id, queryText: 'hi' });

    expect(context.customerId).toBeNull();
    expect(context.customerMemory).toBeNull();
  });

  it('resolves customerId to null when there is no real contactId at all (e.g. a group message)', async () => {
    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId, whatsappAccountId: accountId, chatJid: '120363000000000000@g.us', jidKind: 'group', chatType: 'group',
    });
    const context = await gatherAiHandoffContext({ businessId, chatId: chat.id, contactId: null, queryText: 'hi' });
    expect(context.customerId).toBeNull();
    expect(context.customerMemory).toBeNull();
  });
});
