import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('contact identity reconciliation (real Postgres) - TEST H from the sync-repair live test plan', () => {
  let businessId: string;
  let accountId: string;
  const remoteJid = '15550009999@s.whatsapp.net';

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('reconciles an initially-unresolved contact to its real name without creating a duplicate', async () => {
    const contactRepository = new WhatsAppContactRepository(pool);
    const chatRepository = new WhatsAppChatRepository(pool);
    const messageRepository = new WhatsAppMessageRepository(pool);

    // Step 1: a message arrives before any real contact metadata is known.
    // upsertFromWhatsApp with no name fields still creates exactly one
    // canonical contact row, matched purely by JID identity.
    const bareContact = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: remoteJid,
      jidKind: 'individual',
      phoneNumber: '+15550009999',
    });

    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: remoteJid,
      jidKind: 'individual',
      chatType: 'individual',
      contactId: bareContact.id,
    });

    await messageRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId: chat.id,
      whatsappMessageId: 'RECON-MSG-1',
      remoteJid,
      senderJid: remoteJid,
      direction: 'inbound',
      messageType: 'text',
      textContent: 'first message before identity is known',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });

    const beforeReconciliation = await workspaceService.listChats(businessId, accountId);
    expect(beforeReconciliation).toHaveLength(1);
    // Nothing fabricated - falls back to the phone number (the only real
    // identity known so far), never an invented "Unknown Contact" label.
    expect(beforeReconciliation[0]?.displayName).toBe('+15550009999');

    // Step 2: richer contact metadata arrives later (e.g. contacts.upsert).
    // This must update the SAME contact row (matched by JID), not create a second one.
    const enrichedContact = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: remoteJid,
      jidKind: 'individual',
      displayName: 'Jordan Lee',
      pushName: 'Jordan',
    });
    expect(enrichedContact.id).toBe(bareContact.id);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::int AS count FROM whatsapp_contacts WHERE whatsapp_jid = $1',
      [remoteJid],
    );
    expect(Number(rows[0]!.count)).toBe(1);

    // The existing chat, still pointing at the same contact_id, now resolves to the real name.
    const afterReconciliation = await workspaceService.listChats(businessId, accountId);
    expect(afterReconciliation).toHaveLength(1);
    expect(afterReconciliation[0]?.id).toBe(chat.id);
    expect(afterReconciliation[0]?.displayName).toBe('Jordan Lee');
  });

  it('never overwrites a richer known name with a later NULL value', async () => {
    const contactRepository = new WhatsAppContactRepository(pool);

    const withName = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: remoteJid,
      jidKind: 'individual',
      displayName: 'Jordan Lee',
    });
    expect(withName.displayName).toBe('Jordan Lee');

    const afterNullUpdate = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: remoteJid,
      jidKind: 'individual',
      // displayName omitted entirely (NULL) - must not erase the existing real name.
      phoneNumber: '+15550009999',
    });
    expect(afterNullUpdate.id).toBe(withName.id);
    expect(afterNullUpdate.displayName).toBe('Jordan Lee');
    expect(afterNullUpdate.phoneNumber).toBe('+15550009999');
  });
});
