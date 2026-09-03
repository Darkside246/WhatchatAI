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
import type { WhatsAppMessageIngestionService } from './whatsappMessageIngestionService.js';
import { whatsappMessagePersistenceService } from './whatsappMessagePersistenceService.js';
import { persistStatusUpdate } from './whatsappStatusPersistenceService.js';
import { whatsappReconciliationService } from './whatsappReconciliationService.js';
import { STATUS_BROADCAST_JID } from '../domain/whatsapp/types.js';
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

    // Resumability: if a prior process crashed mid-sync, a real 'running'
    // job row for this account already exists in Postgres even though this
    // fresh process's in-memory activeSyncJobs map is empty. Resume tracking
    // that job instead of creating a duplicate that would leave the
    // original stuck at 'running' forever.
    const existingJob = await this.syncJobRepository.findRunning(businessId, whatsappAccountId, 'initial');
    if (existingJob) {
      this.activeSyncJobs.set(whatsappAccountId, existingJob.id);
      return;
    }

    const job = await this.syncJobRepository.create(businessId, whatsappAccountId, 'initial');
    await this.syncJobRepository.markRunning(job.id);
    await this.accountRepository.markSyncStarted(whatsappAccountId);
    this.activeSyncJobs.set(whatsappAccountId, job.id);
  }

  /**
   * Shared by both contacts.upsert (full Contact[] - initial sync and new
   * contacts) and contacts.update (Partial<Contact>[] - a saved contact's
   * name/verification changing later). Every field read here is already
   * optional-chained/nullish-coalesced, so a partial update naturally only
   * overwrites the fields it actually carries (see
   * WhatsAppContactRepository.upsertFromWhatsApp's own COALESCE semantics).
   */
  async ingestContacts(businessId: string, whatsappAccountId: string, contacts: Partial<Contact>[]): Promise<number> {
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
        username: contact.username ?? null,
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
    ingestionService: WhatsAppMessageIngestionService,
  ): Promise<{ processed: number; failed: number }> {
    // Historical messages are never 'notify' (live) - reuses the same, already-tested
    // classification/dedup pipeline as the live messages.upsert path. Takes the
    // caller's own tenant-scoped ingestion instance (WhatsAppTenantConnection's,
    // not a shared module singleton) so historical-sync ingestion can never write
    // into, or be confused with, another tenant's in-memory buffer.
    const ingested = ingestionService.ingestUpsert({ messages, type: 'append' });
    // Same split the live messages.upsert handler already applies
    // (whatsappTenantConnection.ts) - status@broadcast is WhatsApp's
    // fixed JID for Status updates, never a real conversation, and must
    // never reach whatsapp_messages/whatsapp_chats. Historical statuses
    // (a business's already-active Statuses at pairing time, delivered
    // via messaging-history.set) previously had no such split here and
    // were silently misfiled as ordinary messages - see
    // docs/PHASE_1_STATUS_TEXT_FIX_PROPOSAL.md.
    const statusUpdates = ingested.filter((message) => message.remoteJid === STATUS_BROADCAST_JID);
    const chatMessages = ingested.filter((message) => message.remoteJid !== STATUS_BROADCAST_JID);

    let processed = 0;
    let failed = 0;

    // Synchronous, in-process, same execution model this method already
    // used before this change - no queue hop introduced. Uses the same
    // shared persistence logic (persistStatusUpdate) the live, queued
    // status path uses, so both paths stay behaviorally identical rather
    // than maintaining two copies of the same logic.
    for (const status of statusUpdates) {
      try {
        await persistStatusUpdate(businessId, whatsappAccountId, status);
        processed += 1;
      } catch (error) {
        failed += 1;
        console.error('[Sync] Failed to persist historical status', status.messageId, error);
      }
    }

    for (const message of chatMessages) {
      try {
        await whatsappMessagePersistenceService.persist({ businessId, whatsappAccountId, accountJid, ingested: message });
        processed += 1;
      } catch (error) {
        // Real, recorded failure - not silently swallowed. The sync job's
        // errors_count reflects this, so a batch that hits real persistence
        // failures can never be reported as a clean 'completed' sync.
        failed += 1;
        console.error('[Sync] Failed to persist historical message', message.messageId, error);
      }
    }
    return { processed, failed };
  }

  /**
   * Section 25 of the AURA master directive ("sync from the point of the
   * last successful logoff/disconnect/completed sync, not by
   * reprocessing the entire history"): the socket requests
   * syncFullHistory on every connection (see whatsappTenantConnection.ts),
   * not only the first pairing, and real-world Baileys sessions can and do
   * resend a full messaging-history.set batch on an ordinary reconnect -
   * not only on a genuinely new device pairing. Before this guard, that
   * resend was fully reprocessed every time: every contact, chat, and
   * historical message run back through ingestContacts/ingestChats/
   * ingestHistoryMessages again. Never corrupted data (every write below
   * is an idempotent upsert), but real, unnecessary, potentially large
   * reprocessing work on every reconnect. An account that has already
   * completed its initial sync has no reason to redo it - any genuinely
   * new message arrives through the live messages.upsert ('notify') path
   * instead. A future explicit "request a backfill" action is a
   * deliberately separate code path from this passive event handler, not
   * blocked by this guard. 'failed'/'in_progress'/'not_started' all still
   * proceed normally below, so resuming after a real failure keeps working.
   */
  async ingestHistorySet(
    businessId: string,
    whatsappAccountId: string,
    accountJid: string,
    payload: HistorySetPayload,
    ingestionService: WhatsAppMessageIngestionService,
  ): Promise<void> {
    const accountBeforeSync = await this.accountRepository.findById(whatsappAccountId);
    if (accountBeforeSync?.syncStatus === 'completed') {
      console.log(`[Sync] Skipping a resent history-sync batch for account ${whatsappAccountId} - initial sync already completed.`);
      return;
    }

    await this.startInitialSync(businessId, whatsappAccountId);
    const jobId = this.activeSyncJobs.get(whatsappAccountId);

    try {
      const contactsProcessed = await this.ingestContacts(businessId, whatsappAccountId, payload.contacts ?? []);
      const chatsProcessed = await this.ingestChats(businessId, whatsappAccountId, payload.chats ?? []);
      if (payload.lidPnMappings?.length) {
        await this.ingestLidMappings(businessId, whatsappAccountId, payload.lidPnMappings);
      }
      const { processed: messagesProcessed, failed: messagesFailed } = await this.ingestHistoryMessages(
        businessId,
        whatsappAccountId,
        accountJid,
        payload.messages ?? [],
        ingestionService,
      );

      if (jobId) {
        await this.syncJobRepository.incrementCounts(jobId, {
          contactsProcessed,
          chatsProcessed,
          messagesProcessed,
          errorsCount: messagesFailed,
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
        if (jobId) {
          // A batch that hit real, recorded errors along the way completed,
          // but not cleanly - 'partial' says so honestly instead of
          // reporting the same 'completed' state as an error-free run.
          const job = await this.syncJobRepository.findById(jobId);
          if (job && job.errorsCount > 0) {
            await this.syncJobRepository.markPartial(jobId);
          } else {
            await this.syncJobRepository.markCompleted(jobId);
          }
        }
        await this.accountRepository.markSyncCompleted(whatsappAccountId);
        this.activeSyncJobs.delete(whatsappAccountId);

        // Reconciliation is a best-effort repair pass over already-imported
        // data - a failure here must never flip an otherwise-successful
        // sync to 'failed'.
        try {
          const report = await whatsappReconciliationService.run(businessId, whatsappAccountId);
          console.log(`[Sync] Reconciliation for account ${whatsappAccountId}:`, report);
        } catch (error) {
          console.error('[Sync] Reconciliation failed (sync itself still succeeded):', error);
        }
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
