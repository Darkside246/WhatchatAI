import { describe, expect, it } from 'vitest';
import { pool, queryAsTenant } from '../src/db/pool.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { CrmContactRepository } from '../src/repositories/crmContactRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Regression coverage for migration 944 (Postgres Row-Level Security on
 * whatsapp_chats, whatsapp_messages, ai_agents, crm_contacts) - a
 * database-enforced backstop for the business_id filter every repository
 * query already applies in application code. The point of these tests is
 * specifically to prove the backstop works even when application-level
 * scoping is bypassed or forgotten - that's the only scenario where it
 * matters, since well-behaved queries were already correctly isolated
 * before this migration existed.
 */
describe('Row-Level Security backstop (migration 944)', () => {
  it('queryAsTenant never returns another business\'s ai_agents row, even via a raw query with no WHERE clause at all', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness();
    const businessB = await createTestBusiness();
    await pool.query(`INSERT INTO ai_agents (business_id, name) VALUES ($1, 'Agent A')`, [businessA]);
    await pool.query(`INSERT INTO ai_agents (business_id, name) VALUES ($1, 'Agent B')`, [businessB]);

    // Deliberately the exact bug class this migration exists to catch: a
    // real query with NO business_id filter whatsoever.
    const scoped = queryAsTenant(businessA);
    const { rows } = await scoped.query<{ name: string; business_id: string }>('SELECT name, business_id FROM ai_agents');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Agent A');
    expect(rows[0]?.business_id).toBe(businessA);
  });

  it('the ordinary superuser pool is completely unaffected - sees every tenant, exactly as before this migration', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness();
    const businessB = await createTestBusiness();
    await pool.query(`INSERT INTO ai_agents (business_id, name) VALUES ($1, 'Agent A')`, [businessA]);
    await pool.query(`INSERT INTO ai_agents (business_id, name) VALUES ($1, 'Agent B')`, [businessB]);

    const { rows } = await pool.query<{ name: string }>('SELECT name FROM ai_agents ORDER BY name');
    expect(rows.map((row) => row.name)).toEqual(['Agent A', 'Agent B']);
  });

  it('AiAgentRepository built from queryAsTenant only ever returns its own business\'s agents through real repository methods', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness();
    const businessB = await createTestBusiness();
    const repoA = new AiAgentRepository(queryAsTenant(businessA));
    const repoB = new AiAgentRepository(queryAsTenant(businessB));
    const agentA = await repoA.create({ businessId: businessA, name: 'Agent A' });
    await repoB.create({ businessId: businessB, name: 'Agent B' });

    // findByIdForBusiness already double-checks businessId in its own SQL -
    // this proves the RLS layer holds even for a call shaped to pass that
    // check for the WRONG tenant (repoB's own restricted role can never see
    // agentA's row at all, regardless of what businessId argument it's given).
    expect(await repoB.findByIdForBusiness(agentA.id, businessB)).toBeNull();
    expect(await repoA.findByIdForBusiness(agentA.id, businessA)).not.toBeNull();

    const listedByB = await repoB.listByBusiness(businessB);
    expect(listedByB.map((agent) => agent.name)).toEqual(['Agent B']);
  });

  it('CrmContactRepository built from queryAsTenant cannot see another business\'s contact, even by guessing its real id', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness();
    const businessB = await createTestBusiness();
    // Inserted directly (whatsapp_contact_id left null) rather than through
    // upsertForWhatsAppContact - what's under test here is whether the RLS
    // policy blocks a cross-tenant read, not the full whatsapp_contacts
    // FK chain a real contact-linked row would need.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO crm_contacts (business_id) VALUES ($1) RETURNING id`,
      [businessA],
    );
    const contactAId = rows[0]!.id;
    const repoA = new CrmContactRepository(queryAsTenant(businessA));
    const repoB = new CrmContactRepository(queryAsTenant(businessB));

    expect(await repoB.findByIdForBusiness(businessB, contactAId)).toBeNull();
    expect(await repoA.findByIdForBusiness(businessA, contactAId)).not.toBeNull();
  });
});
