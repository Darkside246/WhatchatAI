import type { Chat, Contact, GroupMetadata } from '@whiskeysockets/baileys';
import type { LIDMapping } from '@whiskeysockets/baileys';
import { pool } from '../db/pool.js';
import { classifyJid, derivePhoneNumber } from '../domain/whatsapp/jid.js';
import { chatTypeFromJidKind } from '../domain/whatsapp/chatType.js';
import { WhatsAppAccountRepository } from '../repositories/whatsappAccountRepository.js';
import { WhatsAppContactRepository } from '../repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';
import { WhatsAppGroupRepository } from '../repositories/whatsappGroupRepository.js';
import { WhatsAppGroupMemberRepository } from '../repositories/whatsappGroupMemberRepository.js';
import { WhatsAppJidMappingRepository } from '../repositories/whatsappJidMappingRepository.js';
import { WhatsAppSyncJobRepository } from '../repositories/whatsappSyncJobRepository.js';
import { whatsappMessageIngestionService } from './whatsappMessageIngestionService.js';
import { whatsappMessagePersistenceService } from './whatsappMessagePersistenceService.js';
import type { WAMessage } from '@whiskeysockets/baileys';

export interface HistorySetPayload {
  chats: Chat[];
  contacts: Contact[];
  messages: WAMessage[];
  lidPnMappings?: LIDMapping[];
  isLatest?: boolean;
  progress?: number | null;
}

/**
 * Real Phase 3 synchronization: turns Baileys' own history-sync/upsert events
 * into persisted rows via the existing repositories. Nothing here is
 * fabricated - if an event never arrives (this Baileys version/account never
 * exposes it), the corresponding data simply stays absent, and the sync job
 * honestly reflects only what was actually processed.
 */
export class WhatsAppSyncService {
  private readonly accountRepository = new WhatsAppAccountRepository(pool);
  private readonly contactRepository = new WhatsAppContactRepository(pool);
  private readonly chatRepository = new WhatsAppChatRepository(pool);
  private readonly groupRepository = new WhatsAppGroupRepository(pool);
  private readonly groupMemberRepository = new WhatsAppGroupMemberRepository(pool);
  private readonly jidMappingRepository = new WhatsAppJidMappingRepository(pool);
  private readonly syncJobRepository = new WhatsAppSyncJobRepository(pool);

  /** account id -> in-flight initial sync job id, for this process's lifetime. */
  private readonly activeSyncJobs = new Map<string, string>();

  async startInitialSync(businessId: string, whatsappAccountId: string): Promise<void> {
    if (this.activeSyncJobs.has(whatsappAccountId)) return;

    // ingestHistorySet() calls this at the top of every history-set batch -
    // once a real completion has already been recorded, further batches
    // (which Baileys sometimes still sends) must not spawn a new job.
    const account = await this.accountRepository.findById(whatsappAccountId);
    if (account?.syncStatus === 'completed') return;

    const job = await this.syncJobRepository.create(businessId, whatsappAccountId, 'initial');
    await this.syncJobRepository.markRunning(job.id);
    await this.accountRepository.markSyncStarted(whatsappAccountId);
    this.activeSyncJobs.set(whatsappAccountId, job.id);
  }

  async ingestContacts(businessId: string, whatsappAccountId: string, contacts: Contact[]): Promise<number> {
    let processed = 0;
    for (const contact of contacts) {
      const jid = contact.id;
      if (!jid) continue;
      const jidKind = classifyJid(jid);
      if (jidKind !== 'individual' && jidKind !== 'lid') continue;

      let phoneNumber: string | null = null;
      if (jidKind === 'individual') {
        phoneNumber = derivePhoneNumber(jid, jidKind, null);
      } else if (contact.phoneNumber) {
        // contact.phoneNumber is itself a real @s.whatsapp.net JID, per Baileys' own type comment.
        phoneNumber = derivePhoneNumber(contact.phoneNumber, classifyJid(contact.phoneNumber), null);
      }

      await this.contactRepository.upsertFromWhatsApp({
        businessId,
        whatsappAccountId,
        whatsappJid: jid,
        jidKind,
        phoneNumber,
        displayName: contact.name ?? null,
        pushName: contact.notify ?? null,
        verifiedName: contact.verifiedName ?? null,
      });

      if (jidKind === 'lid' && contact.phoneNumber && phoneNumber) {
        await this.jidMappingRepository.upsert(
          businessId,
          whatsappAccountId,
          jid,
          contact.phoneNumber,
          phoneNumber,
          'baileys_alt_jid',
          'high',
        );
      }

      processed += 1;
    }
    return processed;
  }

  async ingestChats(businessId: string, whatsappAccountId: string, chats: Chat[]): Promise<number> {
    let processed = 0;
    for (const chat of chats) {
      const jid = chat.id;
      if (!jid) continue;
      const jidKind = classifyJid(jid);
      const chatType = chatTypeFromJidKind(jidKind);

      let contactId: string | null = null;
      let groupId: string | null = null;
      if (chatType === 'individual') {
        const contact = await this.contactRepository.findByJid(businessId, whatsappAccountId, jid);
        contactId = contact?.id ?? null;
      } else if (chatType === 'group') {
        const group = await this.groupRepository.findByJid(businessId, whatsappAccountId, jid);
        groupId = group?.id ?? null;
      }

      await this.chatRepository.upsertFromWhatsApp({
        businessId,
        whatsappAccountId,
        chatJid: jid,
        jidKind,
        chatType,
        contactId,
        groupId,
        name: chat.name ?? null,
        ...(typeof chat.unreadCount === 'number' ? { unreadCount: chat.unreadCount } : {}),
        ...(typeof chat.archived === 'boolean' ? { isArchived: chat.archived } : {}),
        ...(typeof chat.pinned === 'number' ? { isPinned: chat.pinned > 0 } : {}),
      });

      processed += 1;
    }
    return processed;
  }

  async ingestGroups(businessId: string, whatsappAccountId: string, groups: GroupMetadata[]): Promise<number> {
    let processed = 0;
    for (const group of groups) {
      const jid = group.id;
      if (!jid || !group.subject) continue;

      const groupRecord = await this.groupRepository.upsertFromWhatsApp({
        businessId,
        whatsappAccountId,
        groupJid: jid,
        subject: group.subject,
        description: group.desc ?? null,
        ownerJid: group.owner ?? null,
        participantsCount: group.participants?.length ?? 0,
        isCommunity: group.isCommunity ?? null,
        isAnnouncement: group.announce ?? null,
        isRestricted: group.restrict ?? null,
      });

      for (const participant of group.participants ?? []) {
        if (!participant.id) continue;
        await this.groupMemberRepository.upsertMember({
          businessId,
          whatsappAccountId,
          groupId: groupRecord.id,
          participantJid: participant.id,
          role: participant.admin === 'superadmin' ? 'superadmin' : participant.admin === 'admin' ? 'admin' : 'member',
          isAdmin: Boolean(participant.isAdmin || participant.isSuperAdmin),
          isSuperAdmin: participant.isSuperAdmin ?? null,
        });
      }

      const existingChat = await this.chatRepository.findByJid(businessId, whatsappAccountId, jid);
      if (existingChat) {
        await this.chatRepository.upsertFromWhatsApp({
          businessId,
          whatsappAccountId,
          chatJid: jid,
          jidKind: 'group',
          chatType: 'group',
          groupId: groupRecord.id,
          name: group.subject,
        });
      }

      processed += 1;
    }
    return processed;
  }

  async ingestLidMappings(businessId: string, whatsappAccountId: string, mappings: LIDMapping[]): Promise<void> {
    for (const mapping of mappings) {
      if (!mapping.lid || !mapping.pn) continue;
      const phoneNumber = derivePhoneNumber(mapping.pn, classifyJid(mapping.pn), null);
      await this.jidMappingRepository.upsert(
        businessId,
        whatsappAccountId,
        mapping.lid,
        mapping.pn,
        phoneNumber,
        'baileys_alt_jid',
        'high',
      );
    }
  }

  async ingestHistoryMessages(
    businessId: string,
    whatsappAccountId: string,
    accountJid: string,
    messages: WAMessage[],
  ): Promise<number> {
    // Historical messages are never 'notify' (live) - reuses the same, already-tested
    // classification/dedup pipeline as the live messages.upsert path.
    const ingested = whatsappMessageIngestionService.ingestUpsert({ messages, type: 'append' });
    let processed = 0;
    for (const message of ingested) {
      try {
        await whatsappMessagePersistenceService.persist({ businessId, whatsappAccountId, accountJid, ingested: message });
        processed += 1;
      } catch (error) {
        console.error('[Sync] Failed to persist historical message', message.messageId, error);
      }
    }
    return processed;
  }

  async ingestHistorySet(
    businessId: string,
    whatsappAccountId: string,
    accountJid: string,
    payload: HistorySetPayload,
  ): Promise<void> {
    await this.startInitialSync(businessId, whatsappAccountId);
    const jobId = this.activeSyncJobs.get(whatsappAccountId);

    try {
      const contactsProcessed = await this.ingestContacts(businessId, whatsappAccountId, payload.contacts ?? []);
      const chatsProcessed = await this.ingestChats(businessId, whatsappAccountId, payload.chats ?? []);
      if (payload.lidPnMappings?.length) {
        await this.ingestLidMappings(businessId, whatsappAccountId, payload.lidPnMappings);
      }
      const messagesProcessed = await this.ingestHistoryMessages(
        businessId,
        whatsappAccountId,
        accountJid,
        payload.messages ?? [],
      );

      if (jobId) {
        await this.syncJobRepository.incrementCounts(jobId, {
          contactsProcessed,
          chatsProcessed,
          messagesProcessed,
        });
      }

      const progress = typeof payload.progress === 'number' ? payload.progress : null;
      if (progress !== null) {
        await this.accountRepository.updateSyncProgress(whatsappAccountId, progress);
      }

      // Baileys is supposed to flag the final history-set batch with
      // isLatest: true, but in practice some accounts/sessions never send
      // that final flag even after progress genuinely reaches 100% - the
      // sync would otherwise stay "in_progress" forever. Progress hitting
      // 100 (as reported by WhatsApp itself, never fabricated here) is
      // treated as an equally real completion signal.
      if (payload.isLatest || progress === 100) {
        if (jobId) await this.syncJobRepository.markCompleted(jobId);
        await this.accountRepository.markSyncCompleted(whatsappAccountId);
        this.activeSyncJobs.delete(whatsappAccountId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (jobId) await this.syncJobRepository.markFailed(jobId, message);
      await this.accountRepository.markSyncFailed(whatsappAccountId, message);
      throw error;
    }
  }
}

export const whatsappSyncService = new WhatsAppSyncService();
