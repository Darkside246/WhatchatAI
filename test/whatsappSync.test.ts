import { beforeEach, describe, expect, it } from 'vitest';
import type { Chat, Contact, GroupMetadata } from '@whiskeysockets/baileys';
import { pool } from '../src/db/pool.js';
import { WhatsAppSyncService } from '../src/services/whatsappSyncService.js';
import { WhatsAppMessageIngestionService } from '../src/services/whatsappMessageIngestionService.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppGroupMemberRepository } from '../src/repositories/whatsappGroupMemberRepository.js';
import { WhatsAppSyncJobRepository } from '../src/repositories/whatsappSyncJobRepository.js';
import { WhatsAppAccountRepository } from '../src/repositories/whatsappAccountRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('WhatsAppSyncService (real Phase 3 sync, real Postgres)', () => {
  let businessId: string;
  let accountId: string;
  let sync: WhatsAppSyncService;
  let ingestionService: WhatsAppMessageIngestionService;
  const accountJid = '15550001111@s.whatsapp.net';

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, accountJid);
    sync = new WhatsAppSyncService();
    ingestionService = new WhatsAppMessageIngestionService();
  });

  it('ingests real contacts, including @lid contacts with a genuine Baileys-supplied phone mapping', async () => {
    const contacts: Contact[] = [
      { id: '15550002222@s.whatsapp.net', name: 'Saved Name', notify: 'Push Name' },
      { id: '9988776655443@lid', phoneNumber: '15550003333@s.whatsapp.net', notify: 'Lid Contact' },
      { id: '9988776655444@lid', notify: 'Lid Without Mapping' }, // no phoneNumber field known
    ];

    const processed = await sync.ingestContacts(businessId, accountId, contacts);
    expect(processed).toBe(3);

    const contactRepo = new WhatsAppContactRepository(pool);
    const phoneContact = await contactRepo.findByJid(businessId, accountId, '15550002222@s.whatsapp.net');
    expect(phoneContact?.phoneNumber).toBe('+15550002222');
    expect(phoneContact?.displayName).toBe('Saved Name');

    const lidWithMapping = await contactRepo.findByJid(businessId, accountId, '9988776655443@lid');
    expect(lidWithMapping?.phoneNumber).toBe('+15550003333'); // real Baileys-supplied mapping

    const lidWithoutMapping = await contactRepo.findByJid(businessId, accountId, '9988776655444@lid');
    expect(lidWithoutMapping?.phoneNumber).toBeNull(); // never fabricated
  });

  it('accepts a partial contacts.update-shaped payload (no phoneNumber/verifiedName fields at all) and updates the existing contact', async () => {
    await sync.ingestContacts(businessId, accountId, [{ id: '15550002222@s.whatsapp.net', name: 'Original Name' }]);

    // Baileys' real contacts.update event type is Partial<Contact>[] - only
    // the fields that actually changed, never a full re-send of everything.
    const partialUpdate: Partial<Contact>[] = [{ id: '15550002222@s.whatsapp.net', name: 'Renamed' }];
    const processed = await sync.ingestContacts(businessId, accountId, partialUpdate);
    expect(processed).toBe(1);

    const contactRepo = new WhatsAppContactRepository(pool);
    const updated = await contactRepo.findByJid(businessId, accountId, '15550002222@s.whatsapp.net');
    expect(updated?.displayName).toBe('Renamed');
  });

  it('ingests real chats and links individual chats to their real contact', async () => {
    await sync.ingestContacts(businessId, accountId, [{ id: '15550002222@s.whatsapp.net', name: 'Jane' }]);
    const chats: Chat[] = [
      { id: '15550002222@s.whatsapp.net', unreadCount: 3, archived: false } as Chat,
    ];

    const processed = await sync.ingestChats(businessId, accountId, chats);
    expect(processed).toBe(1);

    const chatRepo = new WhatsAppChatRepository(pool);
    const chat = await chatRepo.findByJid(businessId, accountId, '15550002222@s.whatsapp.net');
    expect(chat).not.toBeNull();
    expect(chat?.contactId).not.toBeNull();
    expect(chat?.unreadCount).toBe(3);
    expect(chat?.chatType).toBe('individual');
  });

  it('ingests a real group, its members, and links an existing chat to it', async () => {
    const chatRepo = new WhatsAppChatRepository(pool);
    await chatRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '120363011111111111@g.us',
      jidKind: 'group',
      chatType: 'group',
    });

    const groups: GroupMetadata[] = [
      {
        id: '120363011111111111@g.us',
        subject: 'Ops Team',
        owner: '15550001111@s.whatsapp.net',
        desc: 'Internal coordination',
        participants: [
          { id: '15550001111@s.whatsapp.net', admin: 'superadmin', isSuperAdmin: true } as never,
          { id: '15550002222@s.whatsapp.net', admin: null } as never,
        ],
      } as GroupMetadata,
    ];

    const processed = await sync.ingestGroups(businessId, accountId, groups);
    expect(processed).toBe(1);

    const chat = await chatRepo.findByJid(businessId, accountId, '120363011111111111@g.us');
    expect(chat?.groupId).not.toBeNull();
    expect(chat?.name).toBe('Ops Team');

    const groupMembers = new WhatsAppGroupMemberRepository(pool);
    const members = await groupMembers.listByGroup(chat!.groupId!);
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.participantJid === '15550001111@s.whatsapp.net')?.role).toBe('superadmin');
  });

  it('processes a real history-sync batch end-to-end and marks the sync job + account completed on the last chunk', async () => {
    await sync.ingestHistorySet(businessId, accountId, accountJid, {
      chats: [{ id: '15550004444@s.whatsapp.net' } as Chat],
      contacts: [{ id: '15550004444@s.whatsapp.net', name: 'History Contact' }],
      messages: [
        {
          key: { remoteJid: '15550004444@s.whatsapp.net', id: 'HIST-MSG-1', fromMe: false },
          message: { conversation: 'hello from history' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        } as never,
      ],
      progress: 50,
      isLatest: false,
    }, ingestionService);

    const accountRepo = new WhatsAppAccountRepository(pool);
    const midway = await accountRepo.findById(accountId);
    expect(midway?.syncStatus).toBe('in_progress');
    expect(midway?.syncProgress).toBe(50);

    await sync.ingestHistorySet(businessId, accountId, accountJid, {
      chats: [],
      contacts: [],
      messages: [],
      progress: 100,
      isLatest: true,
    }, ingestionService);

    const complete = await accountRepo.findById(accountId);
    expect(complete?.syncStatus).toBe('completed');
    expect(complete?.syncCompletedAt).toBeTruthy();

    const chatRepo = new WhatsAppChatRepository(pool);
    const chat = await chatRepo.findByJid(businessId, accountId, '15550004444@s.whatsapp.net');
    expect(chat?.messageCount).toBe(1);

    const syncJobs = new WhatsAppSyncJobRepository(pool);
    const { rows } = await pool.query('SELECT id FROM whatsapp_sync_jobs WHERE whatsapp_account_id = $1', [accountId]);
    expect(rows).toHaveLength(1);
    const job = await syncJobs.findById(rows[0].id);
    expect(job?.status).toBe('completed');
    expect(job?.contactsProcessed).toBe(1);
    expect(job?.chatsProcessed).toBe(1);
    expect(job?.messagesProcessed).toBe(1);
  });

  it('Section 25: skips reprocessing a resent history-sync batch once the account has already completed its initial sync', async () => {
    // Complete the initial sync first, exactly as the previous test does.
    await sync.ingestHistorySet(businessId, accountId, accountJid, {
      chats: [{ id: '15550004444@s.whatsapp.net' } as Chat],
      contacts: [{ id: '15550004444@s.whatsapp.net', name: 'History Contact' }],
      messages: [],
      progress: 100,
      isLatest: true,
    }, ingestionService);

    const accountRepo = new WhatsAppAccountRepository(pool);
    expect((await accountRepo.findById(accountId))?.syncStatus).toBe('completed');

    // Baileys/WhatsApp resends a full history-sync batch on a later
    // reconnect (real-world behavior, not hypothetical) - this must be
    // skipped entirely, not reprocessed, even though reprocessing it would
    // be harmless (idempotent upserts) rather than corrupting.
    await sync.ingestHistorySet(businessId, accountId, accountJid, {
      chats: [{ id: '15550005555@s.whatsapp.net' } as Chat],
      contacts: [{ id: '15550005555@s.whatsapp.net', name: 'Should Not Be Ingested' }],
      messages: [],
      progress: 100,
      isLatest: true,
    }, ingestionService);

    const neverIngested = await new WhatsAppContactRepository(pool).findByJid(businessId, accountId, '15550005555@s.whatsapp.net');
    expect(neverIngested).toBeNull(); // never ingested - the resend was skipped before any writes

    // Only the one real sync job from the original completed sync exists -
    // the resend never created a second one.
    const { rows } = await pool.query('SELECT id FROM whatsapp_sync_jobs WHERE whatsapp_account_id = $1', [accountId]);
    expect(rows).toHaveLength(1);
  });

  it('Section 25: a history-sync batch after a genuine prior FAILURE still gets processed, not skipped (resume, not permanently stuck)', async () => {
    const accountRepo = new WhatsAppAccountRepository(pool);
    await accountRepo.markSyncFailed(accountId, 'simulated transient failure');
    expect((await accountRepo.findById(accountId))?.syncStatus).toBe('failed');

    await sync.ingestHistorySet(businessId, accountId, accountJid, {
      chats: [{ id: '15550006666@s.whatsapp.net' } as Chat],
      contacts: [{ id: '15550006666@s.whatsapp.net', name: 'Resumed Contact' }],
      messages: [],
      progress: 100,
      isLatest: true,
    }, ingestionService);

    const contactRepo = new WhatsAppContactRepository(pool);
    expect(await contactRepo.findByJid(businessId, accountId, '15550006666@s.whatsapp.net')).not.toBeNull();
    expect((await accountRepo.findById(accountId))?.syncStatus).toBe('completed');
  });
});
