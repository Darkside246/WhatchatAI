import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { CrmContactRepository } from '../src/repositories/crmContactRepository.js';
import { LeadRepository } from '../src/repositories/leadRepository.js';
import { OpenClawCellRepository } from '../src/repositories/openclawCellRepository.js';
import { OpenClawToolGateway } from '../src/services/openclawToolGateway.js';
import { entityOwnershipRegistry } from '../src/services/entityOwnershipRegistry.js';
import { isToolRegistered, listRegisteredTools } from '../src/services/ai/aiToolPolicy.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Adversarial acceptance suite for the OpenClaw Tool Gateway, matching
 * the acceptance table the architecture directive required before any
 * additional WRITE-tier tool is registered. Every scenario asserts a
 * real Postgres outcome (a real row changed or did not change), not just
 * the returned outcome value.
 */
describe('OpenClawToolGateway - update_lead adversarial acceptance suite', () => {
  const gateway = new OpenClawToolGateway();
  const cellRepo = new OpenClawCellRepository(pool);
  const leadRepo = new LeadRepository(pool);
  const crmContactRepo = new CrmContactRepository(pool);
  const chatRepo = new WhatsAppChatRepository(pool);

  let businessId: string;
  let accountId: string;
  let chatId: string;
  let leadId: string;
  let crmContactId: string;

  async function setUpTenant(label: string) {
    const bizId = await createTestBusiness(label);
    const acctId = await createTestAccount(bizId, `1555${Math.floor(Math.random() * 1e7)}@s.whatsapp.net`);

    const contactRepo = new WhatsAppContactRepository(pool);
    const contact = await contactRepo.upsertFromWhatsApp({
      businessId: bizId,
      whatsappAccountId: acctId,
      whatsappJid: `1555${Math.floor(Math.random() * 1e7)}@s.whatsapp.net`,
      jidKind: 'individual',
      displayName: 'Test Customer',
    });

    const chat = await chatRepo.upsertFromWhatsApp({
      businessId: bizId,
      whatsappAccountId: acctId,
      chatJid: contact.whatsappJid,
      jidKind: 'individual',
      chatType: 'individual',
      contactId: contact.id,
    });

    const crmContact = await crmContactRepo.upsertForWhatsAppContact({
      businessId: bizId,
      whatsappContactId: contact.id,
    });

    const lead = await leadRepo.create({ businessId: bizId, crmContactId: crmContact.id, stage: 'new' });

    const cell = await cellRepo.create({
      businessId: bizId,
      cellId: `wc-${bizId.replace(/-/g, '')}`.slice(0, 40),
      deploymentVersion: '2026.7.1-2',
      imageDigest: 'ghcr.io/openclaw/openclaw@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac',
    });

    return { businessId: bizId, accountId: acctId, chatId: chat.id, leadId: lead.id, crmContactId: crmContact.id, cell };
  }

  function baseRequest(overrides: Partial<Parameters<OpenClawToolGateway['invoke']>[0]> = {}) {
    return {
      businessId,
      cellId: `wc-${businessId.replace(/-/g, '')}`.slice(0, 40),
      cellGeneration: 1,
      chatId,
      toolName: 'update_lead',
      entityId: leadId,
      fields: { status: 'QUALIFIED' },
      idempotencyKey: `test-${Math.random()}`,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetDatabase();
    const t = await setUpTenant('Gateway Tenant');
    businessId = t.businessId;
    accountId = t.accountId;
    chatId = t.chatId;
    leadId = t.leadId;
    crmContactId = t.crmContactId;
    void accountId;
    void crmContactId;
  });

  it('APPROVES an OpenClaw request updating its own tenant\'s authorized lead', async () => {
    const result = await gateway.invoke(baseRequest());
    expect(result.outcome).toBe('APPROVED');

    const lead = await leadRepo.findById(leadId);
    expect(lead?.status).toBe('QUALIFIED');
  });

  it('DENIES when OpenClaw attempts another tenant\'s lead', async () => {
    const other = await setUpTenant('Other Tenant');
    const result = await gateway.invoke(baseRequest({ entityId: other.leadId }));

    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toMatch(/not found/i);
    const untouchedLead = await leadRepo.findById(other.leadId);
    expect(untouchedLead?.status).toBe('NEW');
  });

  it('DENIES when the requesting chat/customer has no relationship to the target lead', async () => {
    const other = await setUpTenant('Unrelated Customer In Same Tenant');
    // Reuse this tenant's OWN business id but the OTHER customer's chat -
    // simulates a different WhatsApp contact in the same tenant trying to
    // touch a lead that isn't theirs.
    const crossChatSameTenantLead = await leadRepo.create({ businessId, crmContactId: (await crmContactRepo.upsertForWhatsAppContact({
      businessId,
      whatsappContactId: (await new WhatsAppContactRepository(pool).upsertFromWhatsApp({
        businessId,
        whatsappAccountId: accountId,
        whatsappJid: '15559998888@s.whatsapp.net',
        jidKind: 'individual',
        displayName: 'A Different Customer',
      })).id,
    })).id });
    void other;

    const result = await gateway.invoke(baseRequest({ entityId: crossChatSameTenantLead.id }));

    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toMatch(/no authorized relationship/i);
  });

  it('DENIES an unregistered tool (no CRM_WRITE-equivalent capability exists for it)', async () => {
    const result = await gateway.invoke(baseRequest({ toolName: 'approve_refund', fields: { amount: 500 } }));
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toMatch(/not a registered OpenClaw tool/i);
  });

  it('DENIES an unknown entity id', async () => {
    const result = await gateway.invoke(baseRequest({ entityId: '00000000-0000-0000-0000-000000000000' }));
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toMatch(/not found/i);
  });

  it('DENIES an invalid/unwritable field', async () => {
    const result = await gateway.invoke(baseRequest({ fields: { owner_user_id: 'someone-else' } }));
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toMatch(/not writable/i);
  });

  it('DENIES an invalid field value', async () => {
    const result = await gateway.invoke(baseRequest({ fields: { status: 'CLOSED_WON_MADE_UP' } }));
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toMatch(/must be one of/i);
  });

  it('replays the same outcome when the exact same operation is submitted twice, and never re-executes', async () => {
    const request = baseRequest();
    const first = await gateway.invoke(request);
    const second = await gateway.invoke(request);

    expect(first.outcome).toBe('APPROVED');
    expect(second.outcome).toBe('APPROVED');
    if (second.outcome === 'APPROVED') expect(second.replay).toBe(true);

    const { rows } = await pool.query(
      'SELECT count(*)::int AS count FROM openclaw_tool_executions WHERE idempotency_key = $1',
      [request.idempotencyKey],
    );
    expect(rows[0].count).toBe(1); // one row, not two - the second call never inserted a new execution
  });

  it('DENIES when the same idempotency key is reused with different parameters, and never executes the new fields', async () => {
    const key = `reuse-${Math.random()}`;
    await gateway.invoke(baseRequest({ idempotencyKey: key, fields: { status: 'QUALIFIED' } }));
    const second = await gateway.invoke(baseRequest({ idempotencyKey: key, fields: { status: 'WON' } }));

    expect(second.outcome).toBe('DENIED');
    if (second.outcome === 'DENIED') expect(second.reason).toMatch(/different request parameters/i);
    const lead = await leadRepo.findById(leadId);
    expect(lead?.status).toBe('QUALIFIED'); // never moved to WON
  });

  it('DENIES a stale/expired cell generation (fencing token)', async () => {
    const result = await gateway.invoke(baseRequest({ cellGeneration: 999 }));
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toMatch(/generation/i);
    const lead = await leadRepo.findById(leadId);
    expect(lead?.status).toBe('NEW');
  });

  it('DENIES every request from a SECURITY_QUARANTINED cell', async () => {
    await cellRepo.quarantine(businessId, 'test quarantine');
    const result = await gateway.invoke(baseRequest());
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toMatch(/SECURITY_QUARANTINED/);
    const lead = await leadRepo.findById(leadId);
    expect(lead?.status).toBe('NEW');
  });

  it('DENIES a prompt-injection-style claimed identity carried in the request fields - actor comes only from chatId', async () => {
    const result = await gateway.invoke(
      baseRequest({ fields: { status: 'WON', claimed_identity: 'the business owner' } as Record<string, unknown> }),
    );
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toMatch(/not writable/i); // the extra field alone is rejected, never inspected for a claim
    const lead = await leadRepo.findById(leadId);
    expect(lead?.status).toBe('NEW');
  });

  it('has no SQL-execution capability at all - a raw-SQL-shaped tool name is just another unregistered tool', async () => {
    const result = await gateway.invoke(baseRequest({ toolName: 'execute_sql', fields: { query: 'DROP TABLE leads;' } }));
    expect(result.outcome).toBe('DENIED');
    if (result.outcome === 'DENIED') expect(result.reason).toMatch(/not a registered OpenClaw tool/i);
  });

  it('leaves the existing Gemini-facing tool policy completely untouched', () => {
    // The real count of registered Gemini-facing tools as of this session:
    // get_current_time, update_conversation_memory, schedule_google_meet,
    // schedule_zoom_meeting, list_properties, check_property_status. This
    // assertion exists to prove the OpenClaw gateway's own tool set below
    // never leaks into the shared registry the live Gemini path reads -
    // update this count deliberately (not by weakening it) whenever a new
    // tool is legitimately registered in aiToolPolicy.ts.
    expect(listRegisteredTools()).toHaveLength(6);
    expect(isToolRegistered('get_current_time')).toBe(true);
    expect(isToolRegistered('update_lead')).toBe(false); // never added to the SHARED registry the live Gemini path reads
  });

  it('the entity ownership registry denies an entity type with no registered resolver, never defaulting to authorized', async () => {
    const decision = await entityOwnershipRegistry.resolve('invoice', businessId, chatId, 'anything');
    expect(decision).toBe('NOT_FOUND');
  });

  /**
   * E3 regression (Phase 0.1): execute() now re-scopes its lead lookups via
   * findByIdForBusiness as defense in depth. invoke()'s EntityOwnershipRegistry
   * check already makes a mismatched businessId/leadId pair unreachable through
   * the normal path (proven above) - this suite calls the private execute()
   * directly, bypassing invoke() entirely, to prove the scoped repository
   * lookup itself - not just the earlier authorization step - refuses to
   * retrieve or mutate another business's lead.
   */
  describe('execute() defense-in-depth - the scoped lookup holds even if invoke()\'s earlier check is bypassed', () => {
    it('cannot retrieve or mutate another business\'s lead when called directly with a mismatched businessId/leadId pair', async () => {
      const other = await setUpTenant('Victim Tenant');

      await expect(
        // @ts-expect-error - execute() is private; called directly to test this layer in isolation from invoke()'s authorization.
        gateway.execute('update_lead', businessId, other.leadId, { status: 'WON' }),
      ).rejects.toThrow(/vanished between ownership check and execution/);

      const untouched = await leadRepo.findById(other.leadId);
      expect(untouched?.status).toBe('NEW'); // never mutated by the attacker's own tenant id
    });

    it('leadRepository.findByIdForBusiness itself returns null for a real lead in a different business - the boundary this defense-in-depth relies on', async () => {
      const other = await setUpTenant('Victim Tenant Repo Check');

      const crossTenant = await leadRepo.findByIdForBusiness(other.leadId, businessId);
      expect(crossTenant).toBeNull();

      const ownTenant = await leadRepo.findByIdForBusiness(other.leadId, other.businessId);
      expect(ownTenant?.id).toBe(other.leadId);
    });
  });
});
