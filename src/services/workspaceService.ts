import { pool } from '../db/pool.js';
import { resolveDisplayName } from '../domain/whatsapp/displayName.js';
import { WhatsAppAccountRepository } from '../repositories/whatsappAccountRepository.js';
import { WhatsAppChatRepository, type ChatAiMode } from '../repositories/whatsappChatRepository.js';
import { WhatsAppContactRepository } from '../repositories/whatsappContactRepository.js';
import { WhatsAppMessageRepository } from '../repositories/whatsappMessageRepository.js';
import { WhatsAppSyncJobRepository } from '../repositories/whatsappSyncJobRepository.js';
import { CrmContactRepository } from '../repositories/crmContactRepository.js';
import { AiAgentRepository } from '../repositories/aiAgentRepository.js';
import { WhatsAppJidMappingRepository } from '../repositories/whatsappJidMappingRepository.js';

export interface WorkspaceChatSummary {
  id: string;
  chatJid: string;
  chatType: string;
  displayName: string;
  phoneNumber: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  aiMode: ChatAiMode;
}

export interface ChatNotFoundError extends Error {
  code: 'CHAT_NOT_FOUND';
}

function isChatNotFoundError(error: unknown): error is ChatNotFoundError {
  return error instanceof Error && (error as ChatNotFoundError).code === 'CHAT_NOT_FOUND';
}

export { isChatNotFoundError };

export class WorkspaceService {
  private readonly accountRepository = new WhatsAppAccountRepository(pool);
  private readonly chatRepository = new WhatsAppChatRepository(pool);
  private readonly contactRepository = new WhatsAppContactRepository(pool);
  private readonly messageRepository = new WhatsAppMessageRepository(pool);
  private readonly syncJobRepository = new WhatsAppSyncJobRepository(pool);
  private readonly crmContactRepository = new CrmContactRepository(pool);
  private readonly agentRepository = new AiAgentRepository(pool);
  private readonly jidMappingRepository = new WhatsAppJidMappingRepository(pool);

  async listChats(businessId: string, whatsappAccountId: string): Promise<WorkspaceChatSummary[]> {
    const chats = await this.chatRepository.listByAccount(businessId, whatsappAccountId);
    const summaries: WorkspaceChatSummary[] = [];

    for (const chat of chats) {
      // Status updates, broadcast lists, and newsletters aren't conversations
      // - WhatsApp's own client keeps them out of the chat list too. Real
      // individual/group chats only, here.
      if (chat.chatType !== 'individual' && chat.chatType !== 'group') continue;

      let displayName = chat.name ?? chat.chatJid;
      let phoneNumber = chat.phoneNumber;

      if (chat.contactId) {
        const contact = await this.contactRepository.findById(chat.contactId);
        if (contact) {
          displayName = resolveDisplayName({
            verifiedName: contact.verifiedName,
            businessName: contact.businessName,
            displayName: contact.displayName ?? chat.name,
            pushName: contact.pushName,
            phoneNumber: contact.phoneNumber,
            whatsappJid: contact.whatsappJid,
          });
          phoneNumber = contact.phoneNumber;
        }
      }

      // A `@lid` chat identity carries no phone number of its own - WhatsApp
      // supplies the real phone-based JID separately (via contacts.upsert /
      // lidPnMappings during sync), persisted in whatsapp_jid_mappings. Only
      // fall back to it when nothing better was already resolved.
      if (chat.jidKind === 'lid' && !phoneNumber) {
        const mapping = await this.jidMappingRepository.findByLid(businessId, whatsappAccountId, chat.chatJid);
        if (mapping?.phoneNumber) {
          phoneNumber = mapping.phoneNumber;
          if (displayName === chat.chatJid) displayName = mapping.phoneNumber;
        }
      }

      let lastMessagePreview: string | null = null;
      if (chat.lastMessageId) {
        const lastMessage = await this.messageRepository.findById(chat.lastMessageId);
        lastMessagePreview = lastMessage?.textContent ?? (lastMessage ? `[${lastMessage.messageType}]` : null);
      }

      summaries.push({
        id: chat.id,
        chatJid: chat.chatJid,
        chatType: chat.chatType,
        displayName,
        phoneNumber,
        unreadCount: chat.unreadCount,
        lastMessageAt: chat.lastMessageAt,
        lastMessagePreview,
        aiMode: chat.aiMode,
      });
    }

    return summaries.sort((a, b) => {
      if (!a.lastMessageAt) return 1;
      if (!b.lastMessageAt) return -1;
      return b.lastMessageAt.localeCompare(a.lastMessageAt);
    });
  }

  private notFound(): ChatNotFoundError {
    const error = new Error('Chat not found for this business.') as ChatNotFoundError;
    error.code = 'CHAT_NOT_FOUND';
    return error;
  }

  async getChatDetail(businessId: string, whatsappAccountId: string, chatId: string) {
    const chat = await this.chatRepository.findById(chatId);
    if (!chat || chat.businessId !== businessId || chat.whatsappAccountId !== whatsappAccountId) {
      throw this.notFound();
    }

    const contact = chat.contactId ? await this.contactRepository.findById(chat.contactId) : null;
    const crmContact = contact
      ? await this.crmContactRepository.upsertForWhatsAppContact({ businessId, whatsappContactId: contact.id })
      : null;

    let resolvedPhoneNumber = contact?.phoneNumber ?? chat.phoneNumber ?? null;
    if (chat.jidKind === 'lid' && !resolvedPhoneNumber) {
      const mapping = await this.jidMappingRepository.findByLid(businessId, whatsappAccountId, chat.chatJid);
      resolvedPhoneNumber = mapping?.phoneNumber ?? null;
    }

    return { chat, contact, crmContact, resolvedPhoneNumber };
  }

  async listMessages(businessId: string, whatsappAccountId: string, chatId: string, limit = 50) {
    const chat = await this.chatRepository.findById(chatId);
    if (!chat || chat.businessId !== businessId || chat.whatsappAccountId !== whatsappAccountId) {
      throw this.notFound();
    }
    return this.messageRepository.listByChat(chatId, limit);
  }

  async setAiMode(businessId: string, whatsappAccountId: string, chatId: string, aiMode: ChatAiMode) {
    const chat = await this.chatRepository.findById(chatId);
    if (!chat || chat.businessId !== businessId || chat.whatsappAccountId !== whatsappAccountId) {
      throw this.notFound();
    }
    return this.chatRepository.setAiMode(chatId, aiMode);
  }

  async listAgents(businessId: string) {
    return this.agentRepository.listByBusiness(businessId);
  }

  async getSyncStatus(whatsappAccountId: string) {
    const account = await this.accountRepository.findById(whatsappAccountId);
    if (!account) throw this.notFound();

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM whatsapp_sync_jobs WHERE whatsapp_account_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [whatsappAccountId],
    );
    const latestJob = rows[0] ? await this.syncJobRepository.findById(rows[0].id) : null;

    return {
      syncStatus: account.syncStatus,
      syncProgress: account.syncProgress,
      syncStartedAt: account.syncStartedAt,
      syncCompletedAt: account.syncCompletedAt,
      lastSyncError: account.lastSyncError,
      latestJob,
    };
  }
}

export const workspaceService = new WorkspaceService();
