import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { CustomerMemoryRepository, CustomerMemoryConflictError } from '../src/repositories/customerMemoryRepository.js';
import { CustomerIdentityRepository } from '../src/repositories/customerIdentityRepository.js';
import { applyCustomerMemoryUpdate } from '../src/services/state/conversationStateWriter.js';
import { gatherAiHandoffContext } from '../src/services/aiContextGathererService.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { EntitlementService } from '../src/services/entitlementService.js';
import { PlanRepository } from '../src/repositories/planRepository.js';
import { SubscriptionRepository } from '../src/repositories/subscriptionRepository.js';
import { createTestAccount, createTestBusiness, createTestPlan, createTestSubscription, resetDatabase } from './helpers.js';

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

    await repo.update(businessId, customerId, 1, { confirmedFacts: [{ key: 'k', value: 'v', origin: 'user_confirmed', confirmedAt: new Date().toISOString() }] });
    const second = await repo.getOrCreate(businessId, customerId);
    expect(second.confirmedFacts).toHaveLength(1); // not reset back to empty
  });

  it('update() rejects a stale version with a real CAS conflict', async () => {
    await repo.getOrCreate(businessId, customerId);
    await expect(
      repo.update(businessId, customerId, 999, { confirmedFacts: [{ key: 'k', value: 'v', origin: 'user_confirmed', confirmedAt: new Date().toISOString() }] }),
    ).rejects.toThrow(CustomerMemoryConflictError);
  });

  it('never leaks another business\'s customer memory', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const { rows } = await pool.query<{ id: string }>('INSERT INTO customers (business_id) VALUES ($1) RETURNING id', [otherBusinessId]);
    const otherCustomerId = rows[0]!.id;
    await repo.update(businessId, customerId, (await repo.getOrCreate(businessId, customerId)).version, {
      confirmedFacts: [{ key: 'secret', value: 'only-this-business', origin: 'user_confirmed', confirmedAt: new Date().toISOString() }],
    });
    expect(await repo.find(otherBusinessId, otherCustomerId)).toBeNull();
  });

  describe('deleteByCustomer (Section 75-91 - single-subject erasure, the counterpart to exportCrmContactData)', () => {
    it('actually erases a real memory row and reports true', async () => {
      await repo.update(businessId, customerId, (await repo.getOrCreate(businessId, customerId)).version, {
        confirmedFacts: [{ key: 'k', value: 'v', origin: 'user_confirmed', confirmedAt: new Date().toISOString() }],
      });
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
      await repo.update(businessId, customerId, (await repo.getOrCreate(businessId, customerId)).version, {
        confirmedFacts: [{ key: 'secret', value: 'must-survive', origin: 'user_confirmed', confirmedAt: new Date().toISOString() }],
      });

      await repo.deleteByCustomer(otherBusinessId, otherCustomerId);

      const stillThere = await repo.find(businessId, customerId);
      expect(stillThere?.confirmedFacts).toEqual([expect.objectContaining({ key: 'secret', value: 'must-survive' })]);
    });
  });
});

describe('CustomerMemoryRepository.countByBusiness (AI Agents Page Consolidation)', () => {
  beforeEach(resetDatabase);

  it('counts real memory rows for this business only, never another business\'s', async () => {
    const repo = new CustomerMemoryRepository(pool);
    const businessA = await createTestBusiness('Business A');
    const businessB = await createTestBusiness('Business B');
    const { rows: customersA } = await pool.query<{ id: string }>('INSERT INTO customers (business_id) VALUES ($1), ($1) RETURNING id', [businessA]);
    const { rows: customersB } = await pool.query<{ id: string }>('INSERT INTO customers (business_id) VALUES ($1) RETURNING id', [businessB]);

    await repo.getOrCreate(businessA, customersA[0]!.id);
    await repo.getOrCreate(businessA, customersA[1]!.id);
    await repo.getOrCreate(businessB, customersB[0]!.id);

    expect(await repo.countByBusiness(businessA)).toBe(2);
    expect(await repo.countByBusiness(businessB)).toBe(1);
  });

  it('returns zero for a business with no memory rows at all', async () => {
    const repo = new CustomerMemoryRepository(pool);
    const businessId = await createTestBusiness();
    expect(await repo.countByBusiness(businessId)).toBe(0);
  });
});

describe('EntitlementService.canCreateCustomerMemory (AI Agents Page Consolidation)', () => {
  let entitlements: EntitlementService;

  beforeEach(async () => {
    await resetDatabase();
    entitlements = new EntitlementService(pool);
  });

  it('allows creating memory under the plan\'s real cap', async () => {
    const businessId = await createTestBusiness();
    await createTestSubscription(businessId, 'starter');
    const result = await entitlements.canCreateCustomerMemory(businessId);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(100); // migration 982's seeded starter cap
  });

  it('denies once the plan\'s cap is reached', async () => {
    // A throwaway plan (never the real seeded 'starter') - resetDatabase()
    // deliberately never truncates plans/plan_entitlements (reference data,
    // not per-test state, per helpers.ts's own NOTE), so mutating a real
    // seed plan's entitlement in place would leak into every other test in
    // the same process for the rest of the run (planAdmin.test.ts's own
    // doc comment: "exactly what happened the first time this file was
    // written" - repeated here once already before this fix).
    const planId = await createTestPlan();
    await new PlanRepository(pool).upsertEntitlement(planId, 'max_customer_memory_profiles', { limitValue: 1, isEnabled: true });
    const businessId = await createTestBusiness();
    await new SubscriptionRepository(pool).ensureDefault(businessId, planId);

    const memoryRepo = new CustomerMemoryRepository(pool);
    const { rows } = await pool.query<{ id: string }>('INSERT INTO customers (business_id) VALUES ($1) RETURNING id', [businessId]);
    await memoryRepo.getOrCreate(businessId, rows[0]!.id);

    const result = await entitlements.canCreateCustomerMemory(businessId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('ENTITLEMENT_LIMIT_REACHED');
  });

  it('treats a NULL plan limit as genuinely unlimited (enterprise)', async () => {
    const businessId = await createTestBusiness();
    await createTestSubscription(businessId, 'enterprise');
    const result = await entitlements.canCreateCustomerMemory(businessId);
    expect(result.allowed).toBe(true);
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
        await realUpdate(businessId, customerId, state.version, { confirmedFacts: [{ key: 'concurrent', value: 'writer', origin: 'user_confirmed', confirmedAt: new Date().toISOString() }] });
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

  describe('AI Agents Page Consolidation: options-gated writes', () => {
    it('customerMemoryEnabled: false is a real no-op - no row created, no error thrown', async () => {
      await applyCustomerMemoryUpdate(repo, businessId, customerId, [{ key: 'k', value: 'v' }], undefined, { customerMemoryEnabled: false });
      expect(await repo.find(businessId, customerId)).toBeNull();
    });

    it('omitting customerMemoryEnabled behaves exactly like true - every pre-existing caller unaffected', async () => {
      await applyCustomerMemoryUpdate(repo, businessId, customerId, [{ key: 'k', value: 'v' }]);
      expect(await repo.find(businessId, customerId)).not.toBeNull();
    });

    it('canCreateNewProfile denying blocks only a brand-new customer\'s first row, never an existing one\'s update', async () => {
      const canCreateNewProfile = vi.fn().mockResolvedValue(false);
      await applyCustomerMemoryUpdate(repo, businessId, customerId, [{ key: 'k', value: 'v' }], undefined, { canCreateNewProfile });
      expect(await repo.find(businessId, customerId)).toBeNull();
      expect(canCreateNewProfile).toHaveBeenCalledTimes(1);
    });

    it('an existing customer keeps updating normally even when canCreateNewProfile denies (a plan downgrade never breaks a customer already remembered)', async () => {
      await applyCustomerMemoryUpdate(repo, businessId, customerId, [{ key: 'unit_number', value: '4B' }]);
      const canCreateNewProfile = vi.fn().mockResolvedValue(false);
      await applyCustomerMemoryUpdate(repo, businessId, customerId, [{ key: 'unit_number', value: '5C' }], undefined, { canCreateNewProfile });
      const memory = await repo.find(businessId, customerId);
      expect(memory?.confirmedFacts[0]?.value).toBe('5C');
      expect(canCreateNewProfile).not.toHaveBeenCalled();
    });

    it('canCreateNewProfile allowing lets a brand-new customer get a real row', async () => {
      const canCreateNewProfile = vi.fn().mockResolvedValue(true);
      await applyCustomerMemoryUpdate(repo, businessId, customerId, [{ key: 'k', value: 'v' }], undefined, { canCreateNewProfile });
      expect(await repo.find(businessId, customerId)).not.toBeNull();
    });
  });

  describe('Section 20 (cross-conversation preferred-name carry-over)', () => {
    it('writes a real preferredName through to customer_memory, trimmed', async () => {
      await applyCustomerMemoryUpdate(repo, businessId, customerId, undefined, '  Mike  ');
      const memory = await repo.find(businessId, customerId);
      expect(memory?.preferredName).toBe('Mike');
    });

    it('a blank/whitespace-only preferredName is a real no-op, same as an empty confirmFacts list', async () => {
      await applyCustomerMemoryUpdate(repo, businessId, customerId, undefined, '   ');
      expect(await repo.find(businessId, customerId)).toBeNull();
    });

    it('can write a confirmed fact and a preferred name together in one call', async () => {
      await applyCustomerMemoryUpdate(repo, businessId, customerId, [{ key: 'unit_number', value: '4B' }], 'Mike');
      const memory = await repo.find(businessId, customerId);
      expect(memory?.confirmedFacts).toEqual([expect.objectContaining({ key: 'unit_number', value: '4B' })]);
      expect(memory?.preferredName).toBe('Mike');
    });

    it('a later call with a new preferredName replaces the old one, without touching confirmedFacts', async () => {
      await applyCustomerMemoryUpdate(repo, businessId, customerId, [{ key: 'unit_number', value: '4B' }], 'Mike');
      await applyCustomerMemoryUpdate(repo, businessId, customerId, undefined, 'Michael');
      const memory = await repo.find(businessId, customerId);
      expect(memory?.preferredName).toBe('Michael');
      expect(memory?.confirmedFacts).toEqual([expect.objectContaining({ key: 'unit_number', value: '4B' })]);
    });
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

  it('Section 20: a preferred name stated in an earlier conversation surfaces for a brand-new conversation with the same customer', async () => {
    const contact = await new WhatsAppContactRepository(pool).upsertFromWhatsApp({
      businessId, whatsappAccountId: accountId, whatsappJid: '15550003333@s.whatsapp.net', jidKind: 'individual', phoneNumber: '+15550003333', pushName: 'Mike',
    });
    const customerId = await new CustomerIdentityRepository(pool).getOrCreateForWhatsAppContact(businessId, contact.id, contact.displayName);
    await applyCustomerMemoryUpdate(new CustomerMemoryRepository(pool), businessId, customerId, undefined, 'Mike');

    // A brand-new chat (a genuinely different conversation) for the same customer - never the same chat_id used above.
    const newChat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId, whatsappAccountId: accountId, chatJid: '15550003333@s.whatsapp.net', jidKind: 'individual', chatType: 'individual', contactId: contact.id,
    });
    const context = await gatherAiHandoffContext({ businessId, chatId: newChat.id, contactId: contact.id, queryText: 'hi, is anyone there' });

    expect(context.customerMemory?.preferredName).toBe('Mike');
    // The new conversation's own conversation_states row has never set a preferredName - only customer_memory has it.
    expect(context.conversationState.preferredName).toBeNull();
  });
});
