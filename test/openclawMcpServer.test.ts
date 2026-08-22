import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pool } from '../src/db/pool.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { CrmContactRepository } from '../src/repositories/crmContactRepository.js';
import { LeadRepository } from '../src/repositories/leadRepository.js';
import { OpenClawCellRepository } from '../src/repositories/openclawCellRepository.js';
import { generateCallbackToken, hashCallbackToken } from '../src/services/openclawCallbackTokenService.js';
import { authenticateOpenClawMcpCaller, createOpenClawMcpServer } from '../src/services/openclawMcpServer.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * This suite is the "tested standalone with a real MCP client" step the
 * user required before any live-agent wiring: it drives the real
 * `@modelcontextprotocol/sdk` `Client` class against the real
 * `createOpenClawMcpServer`, connected via the SDK's own
 * `InMemoryTransport.createLinkedPair()` (a genuine client<->server MCP
 * session, just without a network hop) - not a hand-rolled fake of the
 * protocol. The remaining, separate step (not done here) is a real HTTP
 * round trip against `openclawMcpRouter.ts` on real hardware, matching
 * how every other piece of this Docker/OpenClaw work was verified.
 */
describe('OpenClaw MCP server (real MCP client, real Tool Gateway, real Postgres)', () => {
  const cellRepo = new OpenClawCellRepository(pool);
  const leadRepo = new LeadRepository(pool);
  const crmContactRepo = new CrmContactRepository(pool);
  const chatRepo = new WhatsAppChatRepository(pool);

  let businessId: string;
  let chatId: string;
  let leadId: string;
  let cellId: string;
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
    await cellRepo.create({
      businessId: bizId,
      cellId,
      deploymentVersion: '2026.7.1-2',
      imageDigest: 'ghcr.io/openclaw/openclaw@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac',
    });
    await cellRepo.setCallbackTokenHash(bizId, hashCallbackToken(token));

    return { businessId: bizId, chatId: chat.id, leadId: lead.id, cellId, token };
  }

  /** Authenticates (or not) exactly like `openclawMcpRouter.ts` does, then wires a real linked-pair MCP client to the resulting server. Returns null if authentication failed - mirrors the router's 401 path. */
  async function connectAuthenticatedClient(authorizationHeader: string | undefined) {
    const cell = await authenticateOpenClawMcpCaller(authorizationHeader, cellRepo);
    if (!cell) return null;

    const server = createOpenClawMcpServer(cell);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return { client, server };
  }

  beforeEach(async () => {
    await resetDatabase();
    const t = await setUpTenant('MCP Tenant');
    businessId = t.businessId;
    chatId = t.chatId;
    leadId = t.leadId;
    cellId = t.cellId;
    rawToken = t.token;
  });

  function updateLeadArgs(overrides: Record<string, unknown> = {}) {
    return {
      entity_id: leadId,
      chat_id: chatId,
      cell_generation: 1,
      idempotency_key: `mcp-${Math.random()}`,
      fields: { status: 'QUALIFIED' },
      ...overrides,
    };
  }

  it('authenticateOpenClawMcpCaller rejects a missing/malformed/wrong token', async () => {
    expect(await authenticateOpenClawMcpCaller(undefined, cellRepo)).toBeNull();
    expect(await authenticateOpenClawMcpCaller(`Basic ${rawToken}`, cellRepo)).toBeNull();
    expect(await authenticateOpenClawMcpCaller(`Bearer ${generateCallbackToken()}`, cellRepo)).toBeNull();
  });

  it('authenticateOpenClawMcpCaller resolves the real cell for a valid token', async () => {
    const cell = await authenticateOpenClawMcpCaller(`Bearer ${rawToken}`, cellRepo);
    expect(cell?.businessId).toBe(businessId);
    expect(cell?.cellId).toBe(cellId);
  });

  it('tools/list exposes exactly one tool: update_lead', async () => {
    const session = await connectAuthenticatedClient(`Bearer ${rawToken}`);
    if (!session) throw new Error('expected authentication to succeed');
    const { tools } = await session.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['update_lead']);
  });

  it('tools/call reaches the real Tool Gateway and the lead actually changes', async () => {
    const session = await connectAuthenticatedClient(`Bearer ${rawToken}`);
    if (!session) throw new Error('expected authentication to succeed');

    const result = await session.client.callTool({ name: 'update_lead', arguments: updateLeadArgs() });
    expect(result.isError).toBeFalsy();
    const outcome = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(outcome.outcome).toBe('APPROVED');

    const lead = await leadRepo.findById(leadId);
    expect(lead?.status).toBe('QUALIFIED');
  });

  it('a stolen token from a DIFFERENT tenant can never reach this tenant\'s lead, even if the arguments claim it', async () => {
    const attacker = await setUpTenant('MCP Attacker Tenant');
    const session = await connectAuthenticatedClient(`Bearer ${attacker.token}`);
    if (!session) throw new Error('expected authentication to succeed');

    const result = await session.client.callTool({
      name: 'update_lead',
      arguments: updateLeadArgs({ entity_id: leadId, chat_id: chatId }), // victim's real entity/chat
    });
    expect(result.isError).toBe(true); // a real gateway DENY surfaced as a tool error, not a crash
    const outcome = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(outcome.outcome).toBe('DENIED');

    const lead = await leadRepo.findById(leadId);
    expect(lead?.status).toBe('NEW'); // untouched
  });

  it('invalid authentication never reaches tool registration at all', async () => {
    const session = await connectAuthenticatedClient(`Bearer ${generateCallbackToken()}`);
    expect(session).toBeNull();
  });

  it('a replayed idempotency key with identical fields is a safe no-op replay, not a second write', async () => {
    const session = await connectAuthenticatedClient(`Bearer ${rawToken}`);
    if (!session) throw new Error('expected authentication to succeed');
    const args = updateLeadArgs();

    const first = await session.client.callTool({ name: 'update_lead', arguments: args });
    const second = await session.client.callTool({ name: 'update_lead', arguments: args });

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    const secondOutcome = JSON.parse((second.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(secondOutcome.outcome).toBe('APPROVED');
    expect(secondOutcome.replay).toBe(true);
  });

  it('reusing an idempotency key with DIFFERENT fields is denied, not silently applied', async () => {
    const session = await connectAuthenticatedClient(`Bearer ${rawToken}`);
    if (!session) throw new Error('expected authentication to succeed');
    const key = `mcp-reuse-${Math.random()}`;

    await session.client.callTool({ name: 'update_lead', arguments: updateLeadArgs({ idempotency_key: key, fields: { status: 'QUALIFIED' } }) });
    const second = await session.client.callTool({ name: 'update_lead', arguments: updateLeadArgs({ idempotency_key: key, fields: { status: 'WON' } }) });

    expect(second.isError).toBe(true);
    const outcome = JSON.parse((second.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(outcome.outcome).toBe('DENIED');

    const lead = await leadRepo.findById(leadId);
    expect(lead?.status).toBe('QUALIFIED'); // the second, conflicting write never applied
  });

  it('a stale cell generation is denied by the real fencing check', async () => {
    const session = await connectAuthenticatedClient(`Bearer ${rawToken}`);
    if (!session) throw new Error('expected authentication to succeed');

    const result = await session.client.callTool({ name: 'update_lead', arguments: updateLeadArgs({ cell_generation: 999 }) });
    expect(result.isError).toBe(true);
    const outcome = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(outcome.outcome).toBe('DENIED');
  });

  it('a quarantined cell is denied even with a fully valid token', async () => {
    await cellRepo.quarantine(businessId, 'test quarantine');
    const session = await connectAuthenticatedClient(`Bearer ${rawToken}`);
    if (!session) throw new Error('expected authentication to succeed');

    const result = await session.client.callTool({ name: 'update_lead', arguments: updateLeadArgs() });
    expect(result.isError).toBe(true);
    const outcome = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(outcome.outcome).toBe('DENIED');
  });

  it('an unrecognized field is denied by the existing field allow-list, not silently dropped or applied', async () => {
    const session = await connectAuthenticatedClient(`Bearer ${rawToken}`);
    if (!session) throw new Error('expected authentication to succeed');

    const result = await session.client.callTool({
      name: 'update_lead',
      arguments: updateLeadArgs({ fields: { businessId: '00000000-0000-0000-0000-000000000000' } }),
    });
    expect(result.isError).toBe(true);
    const outcome = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(outcome.outcome).toBe('DENIED');
  });
});
