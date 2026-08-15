import { pool } from '../db/pool.js';
import { CrmContactRepository, type CrmContactRecord } from '../repositories/crmContactRepository.js';
import { WhatsAppMessageRepository, type WhatsAppMessageRecord } from '../repositories/whatsappMessageRepository.js';
import { searchKnowledgeBase, type KnowledgeBaseSearchResult } from './knowledgeBaseSearchService.js';

export interface GatherAiHandoffContextInput {
  businessId: string;
  chatId: string;
  contactId: string | null;
  queryText: string;
  historyLimit?: number;
}

export interface AiHandoffContext {
  crmContact: CrmContactRecord | null;
  knowledgeBase: KnowledgeBaseSearchResult;
  conversationHistory: WhatsAppMessageRecord[];
}

/**
 * Once a message clears the Sentinel and is decrypted in memory, this
 * gathers everything the Gemini Orchestrator needs concurrently instead of
 * sequentially: CRM contact lookup, Knowledge Base vector search, and
 * conversation history all run in parallel via Promise.all(), so total
 * latency is bounded by the slowest lookup, not their sum.
 */
export async function gatherAiHandoffContext(input: GatherAiHandoffContextInput): Promise<AiHandoffContext> {
  const crmContactRepository = new CrmContactRepository(pool);
  const messageRepository = new WhatsAppMessageRepository(pool);

  const [crmContact, knowledgeBase, conversationHistory] = await Promise.all([
    input.contactId
      ? crmContactRepository.findByWhatsAppContact(input.businessId, input.contactId)
      : Promise.resolve(null),
    searchKnowledgeBase(input.businessId, input.queryText),
    messageRepository.listByChat(input.chatId, input.historyLimit ?? 20),
  ]);

  return { crmContact, knowledgeBase, conversationHistory };
}
