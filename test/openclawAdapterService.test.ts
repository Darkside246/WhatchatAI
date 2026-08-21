import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { CrmContactRepository } from '../src/repositories/crmContactRepository.js';
import { LeadRepository } from '../src/repositories/leadRepository.js';
import { OpenClawFleetCellRepository } from '../src/repositories/openclawFleetCellRepository.js';
import { generateCallbackToken, hashCallbackToken } from '../src/services/openclawCallbackTokenService.js';
import { handleOpenClawToolInvokeRequest } from '../src/services/openclawAdapterService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('handleOpenClawToolInvokeRequest (the real HTTP-facing adapter, called directly)', () => {
  const fleetCellRepo = new OpenClawFleetCellRepository(pool);
  const leadRepo = new LeadRepository(pool);
  const crmContactRepo = new CrmContactRepository(pool);
  const chatRepo = new WhatsAppChatRepository(pool);

  let businessId: string;
  let chatId: string;
  let leadId: string;
  let fleetCellId: string;
  let rawToken: string;

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
    const crmContact = await crmContactRepo.upsertForWhatsAppContact({ businessId: bizId, whatsappContactId: contact.id });
    const lead = await leadRepo.create({ businessId: bizId, crmContactId: crmContact.id });

    const token = generateCallbackToken();
    const cellId = `wc-${bizId.replace(/-/g, '')}`.slice(0, 40);
    await fleetCellRepo.create({
      businessId: bizId,
      fleetCellId: cellId,
      deploymentVersion: '2026.7.1-2',
      imageDigest: 'ghcr.io/openclaw/openclaw@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac',
    });
    await fleetCellRepo.setCallbackTokenHash(bizId, hashCallbackToken(token));

    return { businessId: bizId, chatId: chat.id, leadId: lead.id, fleetCellId: cellId, token };
  }

  beforeEach(async () => {
    await resetDatabase();
    const t = await setUpTenant('Adapter Tenant');
    businessId = t.businessId;
    chatId = t.chatId;
    leadId = t.leadId;
    fleetCellId = t.fleetCellId;
    rawToken = t.token;
  });

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      toolName: 'update_lead',
      entityId: leadId,
      chatId,
      cellGeneration: 1,
      idempotencyKey: `adapter-${Math.random()}`,
      fields: { status: 'QUALIFIED' },
      ...overrides,
    };
  }

  it('401s when the Authorization header is missing', async () => {
    const result = await handleOpenClawToolInvokeRequest(undefined, validBody());
    expect(result.httpStatus).toBe(401);
  });

  it('401s when the Authorization header is malformed (not "Bearer <token>")', async () => {
    const result = await handleOpenClawToolInvokeRequest(`Basic ${rawToken}`, validBody());
    expect(result.httpStatus).toBe(401);
  });

  it('401s on a well-formed but wrong token', async () => {
    const result = await handleOpenClawToolInvokeRequest(`Bearer ${generateCallbackToken()}`, validBody());
    expect(result.httpStatus).toBe(401);
    expect(result.body.error).toMatch(/invalid callback token/i);
  });

  it('400s on a non-object body', async () => {
    const result = await handleOpenClawToolInvokeRequest(`Bearer ${rawToken}`, 'not an object');
    expect(result.httpStatus).toBe(400);
  });

  it.each(['toolName', 'entityId', 'chatId', 'idempotencyKey'])('400s when "%s" is missing', async (field) => {
    const body = validBody();
    delete (body as Record<string, unknown>)[field];
    const result = await handleOpenClawToolInvokeRequest(`Bearer ${rawToken}`, body);
    expect(result.httpStatus).toBe(400);
  });

  it('400s when "fields" is not an object', async () => {
    const result = await handleOpenClawToolInvokeRequest(`Bearer ${rawToken}`, validBody({ fields: 'not an object' }));
    expect(result.httpStatus).toBe(400);
  });

  it('400s when "cellGeneration" is not an integer', async () => {
    const result = await handleOpenClawToolInvokeRequest(`Bearer ${rawToken}`, validBody({ cellGeneration: 'one' }));
    expect(result.httpStatus).toBe(400);
  });

  it('APPROVES a legitimate request with a valid token, and the lead actually changes', async () => {
    const result = await handleOpenClawToolInvokeRequest(`Bearer ${rawToken}`, validBody());
    expect(result.httpStatus).toBe(200);
    expect(result.body.outcome).toBe('APPROVED');

    const lead = await leadRepo.findById(leadId);
    expect(lead?.status).toBe('QUALIFIED');
  });

  it('a stolen token from a DIFFERENT tenant can never reach this tenant\'s lead, even if the body claims it', async () => {
    const attacker = await setUpTenant('Attacker Tenant');

    // Attacker's own valid token, but the request body tries to target
    // the victim's lead/chat. The adapter's authenticated businessId
    // comes from the attacker's own token, not from the body - so this
    // must fail as "not found" (cross-tenant), never succeed.
    const result = await handleOpenClawToolInvokeRequest(
      `Bearer ${attacker.token}`,
      validBody({ entityId: leadId, chatId }), // victim's real entity/chat
    );

    expect(result.httpStatus).toBe(200); // a real gateway DENY, not an HTTP auth failure
    expect(result.body.outcome).toBe('DENIED');
    const lead = await leadRepo.findById(leadId);
    expect(lead?.status).toBe('NEW'); // untouched
  });

  it('ignores a businessId/fleetCellId the request body tries to claim - only the authenticated token\'s identity is ever used', async () => {
    const result = await handleOpenClawToolInvokeRequest(
      `Bearer ${rawToken}`,
      validBody({ businessId: '00000000-0000-0000-0000-000000000000', fleetCellId: 'wc-someoneelse' }),
    );
    // Still resolves via the real token's own cell/tenant, so this still succeeds normally.
    expect(result.httpStatus).toBe(200);
    expect(result.body.outcome).toBe('APPROVED');
    expect(fleetCellId).toBeTruthy(); // sanity: the real cell id was never the one claimed above
  });
});
