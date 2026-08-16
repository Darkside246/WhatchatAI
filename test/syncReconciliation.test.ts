import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppSyncJobRepository } from '../src/repositories/whatsappSyncJobRepository.js';
import { WhatsAppAccountRepository } from '../src/repositories/whatsappAccountRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppGroupRepository } from '../src/repositories/whatsappGroupRepository.js';
import { WhatsAppGroupMemberRepository } from '../src/repositories/whatsappGroupMemberRepository.js';
import { WhatsAppStatusRepository } from '../src/repositories/whatsappStatusRepository.js';
import { WhatsAppJidMappingRepository } from '../src/repositories/whatsappJidMappingRepository.js';
import { WhatsAppSyncService } from '../src/services/whatsappSyncService.js';
import { whatsappReconciliationService } from '../src/services/whatsappReconciliationService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('sync resumability + partial status (real Postgres, no in-memory state trusted)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('finds a real running job left behind by a crashed process, for resumption', async () => {
    const jobRepository = new WhatsAppSyncJobRepository(pool);
    const job = await jobRepository.create(businessId, accountId, 'initial');
    await jobRepository.markRunning(job.id);

    const found = await jobRepository.findRunning(businessId, accountId, 'initial');
    expect(found?.id).toBe(job.id);
    expect(found?.status).toBe('running');
  });

  it('does not find a completed job as "running" - resumption only applies to genuinely in-flight jobs', async () => {
    const jobRepository = new WhatsAppSyncJobRepository(pool);
    const job = await jobRepository.create(businessId, accountId, 'initial');
    await jobRepository.markRunning(job.id);
    await jobRepository.markCompleted(job.id);

    expect(await jobRepository.findRunning(businessId, accountId, 'initial')).toBeNull();
  });

  it('a fresh WhatsAppSyncService instance (simulating a worker restart) resumes the real running job instead of creating a duplicate', async () => {
    const jobRepository = new WhatsAppSyncJobRepository(pool);
    const accountRepository = new WhatsAppAccountRepository(pool);

    // Simulate the prior process's state: a job genuinely in progress.
    const originalJob = await jobRepository.create(businessId, accountId, 'initial');
    await jobRepository.markRunning(originalJob.id);
    await accountRepository.markSyncStarted(accountId);

    // A brand-new service instance has an empty in-memory activeSyncJobs map,
    // exactly like a real process restart.
    const freshService = new WhatsAppSyncService();
    await freshService.startInitialSync(businessId, accountId);

    const { rows } = await pool.query('SELECT id, status FROM whatsapp_sync_jobs WHERE whatsapp_account_id = $1', [
      accountId,
    ]);
    expect(rows).toHaveLength(1); // never duplicated
    expect(rows[0].id).toBe(originalJob.id);
    expect(rows[0].status).toBe('running');
  });

  it('marks a job partial (not a fabricated clean completion) with a real completed_at and 100% progress', async () => {
    const jobRepository = new WhatsAppSyncJobRepository(pool);
    const job = await jobRepository.create(businessId, accountId, 'initial');
    await jobRepository.markRunning(job.id);
    await jobRepository.incrementCounts(job.id, { messagesProcessed: 5, errorsCount: 2 });

    await jobRepository.markPartial(job.id);

    const updated = await jobRepository.findById(job.id);
    expect(updated?.status).toBe('partial');
    expect(updated?.progressPercent).toBe(100);
    expect(updated?.completedAt).not.toBeNull();
    expect(updated?.errorsCount).toBe(2);
    expect(updated?.messagesProcessed).toBe(5);
  });

  it('incrementCounts really accumulates errors_count across multiple real calls', async () => {
    const jobRepository = new WhatsAppSyncJobRepository(pool);
    const job = await jobRepository.create(businessId, accountId, 'initial');
    await jobRepository.incrementCounts(job.id, { errorsCount: 1 });
    await jobRepository.incrementCounts(job.id, { errorsCount: 3 });

    const updated = await jobRepository.findById(job.id);
    expect(updated?.errorsCount).toBe(4);
  });
});

describe('WhatsAppReconciliationService (real Postgres, repairs only from authoritative data)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('attaches a real contact to a chat that arrived before its contact did', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    const contactRepository = new WhatsAppContactRepository(pool);
    const jid = '15550001111@s.whatsapp.net';

    // Chat created first, with no contact yet - a real race condition.
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: jid,
      jidKind: 'individual',
      chatType: 'individual',
    });
    expect(chat.contactId).toBeNull();

    // The contact arrives later, as it genuinely can in a real sync.
    const contact = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: jid,
      jidKind: 'individual',
      phoneNumber: '+15550001111',
      displayName: 'Real Later Contact',
    });

    const report = await whatsappReconciliationService.run(businessId, accountId);
    expect(report.chatsMissingContactFound).toBe(1);
    expect(report.chatsMissingContactRepaired).toBe(1);

    const repaired = await chatRepository.findByJid(businessId, accountId, jid);
    expect(repaired?.contactId).toBe(contact.id);
  });

  it('never attaches a contact when none actually exists for the chat - an unresolved chat stays unresolved, not guessed', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });

    const report = await whatsappReconciliationService.run(businessId, accountId);
    expect(report.chatsMissingContactFound).toBe(1);
    expect(report.chatsMissingContactRepaired).toBe(0);
  });

  it('backfills a @lid contact\'s phone number once an authoritative jid_mapping arrives', async () => {
    const contactRepository = new WhatsAppContactRepository(pool);
    const jidMappingRepository = new WhatsAppJidMappingRepository(pool);
    const lidJid = '234471341175024@lid';

    const contact = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: lidJid,
      jidKind: 'lid',
      phoneNumber: null,
    });
    expect(contact.phoneNumber).toBeNull();

    await jidMappingRepository.upsert(
      businessId,
      accountId,
      lidJid,
      '15550002222@s.whatsapp.net',
      '+15550002222',
      'baileys_alt_jid',
      'high',
    );

    const report = await whatsappReconciliationService.run(businessId, accountId);
    expect(report.unresolvedLidContactsFound).toBe(1);
    expect(report.unresolvedLidContactsRepaired).toBe(1);

    const repaired = await contactRepository.findByJid(businessId, accountId, lidJid);
    expect(repaired?.phoneNumber).toBe('+15550002222');
  });

  it('never fabricates a phone number for a @lid contact with no authoritative mapping', async () => {
    const contactRepository = new WhatsAppContactRepository(pool);
    await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '999888777666@lid',
      jidKind: 'lid',
      phoneNumber: null,
    });

    const report = await whatsappReconciliationService.run(businessId, accountId);
    expect(report.unresolvedLidContactsFound).toBe(1);
    expect(report.unresolvedLidContactsRepaired).toBe(0);

    const stillUnresolved = await contactRepository.findByJid(businessId, accountId, '999888777666@lid');
    expect(stillUnresolved?.phoneNumber).toBeNull();
  });

  it('reports real unknown-contact, missing-member, and unresolved-publisher counts without repairing them', async () => {
    const contactRepository = new WhatsAppContactRepository(pool);
    const groupRepository = new WhatsAppGroupRepository(pool);
    const groupMemberRepository = new WhatsAppGroupMemberRepository(pool);
    const statusRepository = new WhatsAppStatusRepository(pool);

    // A contact with no real name field at all.
    await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550003333@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550003333',
    });

    // A group WhatsApp reported as having participants, with none actually persisted.
    await groupRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      groupJid: '120363000000000001@g.us',
      subject: 'Real Group',
      description: null,
      ownerJid: null,
      participantsCount: 3,
    });

    // A status from a publisher with no matching contact.
    await statusRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      statusId: 'STATUS-RECON-1',
      publisherJid: '15550004444@s.whatsapp.net',
      statusType: 'text',
      textContent: 'real status text',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const report = await whatsappReconciliationService.run(businessId, accountId);
    expect(report.unknownContacts).toBe(1);
    expect(report.groupsMissingMembers).toBe(1);
    expect(report.statusesWithUnresolvedPublisher).toBe(1);

    // Reconciliation is report-only for these - no group member was invented.
    const group = await groupRepository.findByJid(businessId, accountId, '120363000000000001@g.us');
    expect(await groupMemberRepository.listByGroup(group!.id)).toHaveLength(0);
  });
});
