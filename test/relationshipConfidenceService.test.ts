import { describe, expect, it } from 'vitest';
import { pool, queryAsTenant } from '../src/db/pool.js';
import { computeRelationshipSignal } from '../src/services/relationshipConfidenceService.js';
import { BusinessRepository } from '../src/repositories/businessRepository.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { ListRepository } from '../src/repositories/listRepository.js';
import { ListMemberRepository } from '../src/repositories/listMemberRepository.js';
import { ListAgentAssignmentRepository } from '../src/repositories/listAgentAssignmentRepository.js';
import { ChatRelationshipSignalRepository } from '../src/repositories/chatRelationshipSignalRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness } from './helpers.js';

async function createContact(businessId: string, accountId: string, jid: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO whatsapp_contacts (business_id, whatsapp_account_id, whatsapp_jid, jid_kind) VALUES ($1, $2, $3, 'individual') RETURNING id`,
    [businessId, accountId, jid],
  );
  return rows[0]!.id;
}

async function createChat(businessId: string, accountId: string, jid: string, contactId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO whatsapp_chats (business_id, whatsapp_account_id, chat_jid, jid_kind, chat_type, contact_id) VALUES ($1, $2, $3, 'individual', 'individual', $4) RETURNING id`,
    [businessId, accountId, jid, contactId],
  );
  return rows[0]!.id;
}

/** Sets up a real, genuinely ambiguous chat: a contact in two Lists, each with an enabled, ACTIVE agent assignment. */
async function setupAmbiguousChat(businessId: string, jid: string, workKeywords: string[], friendsKeywords: string[]) {
  const accountId = await createTestAccount(businessId, `1555000${Math.floor(Math.random() * 9000 + 1000)}@s.whatsapp.net`);
  const contactId = await createContact(businessId, accountId, jid);
  const chatId = await createChat(businessId, accountId, jid, contactId);

  const agentRepo = new AiAgentRepository(queryAsTenant(businessId));
  const workAgent = await agentRepo.create({ businessId, name: 'Work Agent', triggerKeywords: workKeywords });
  const friendsAgent = await agentRepo.create({ businessId, name: 'Friends Agent', triggerKeywords: friendsKeywords });

  const listRepo = new ListRepository(queryAsTenant(businessId));
  const workList = await listRepo.create({ businessId, name: 'Work' });
  const friendsList = await listRepo.create({ businessId, name: 'Friends' });

  const memberRepo = new ListMemberRepository(queryAsTenant(businessId));
  await memberRepo.addMember({ businessId, listId: workList.id, memberType: 'contact', memberId: contactId });
  await memberRepo.addMember({ businessId, listId: friendsList.id, memberType: 'contact', memberId: contactId });

  const assignmentRepo = new ListAgentAssignmentRepository(queryAsTenant(businessId));
  await assignmentRepo.upsert({ businessId, listId: workList.id, agentId: workAgent.id, enabled: true });
  await assignmentRepo.upsert({ businessId, listId: friendsList.id, agentId: friendsAgent.id, enabled: true });

  return { chatId, workList, friendsList };
}

describe('relationshipConfidenceService.computeRelationshipSignal (real Postgres, Relationship-Confidence Engine Phase 3)', () => {
  it('a business with the engine off (the default) never computes anything, even for a genuinely ambiguous chat', async () => {
    const businessId = await createTestBusiness();
    const { chatId } = await setupAmbiguousChat(businessId, '10@s.whatsapp.net', ['invoice'], ['weekend']);

    expect(await computeRelationshipSignal(businessId, chatId, 'Can you send the invoice over?')).toBeNull();
    expect(await new ChatRelationshipSignalRepository(queryAsTenant(businessId)).findForChat(businessId, chatId)).toBeNull();
  });

  it('a clear single winner: the message matches one candidate\'s trigger keyword and not the other\'s', async () => {
    const businessId = await createTestBusiness();
    await new BusinessRepository(pool).setRelationshipConfidenceEnabled(businessId, true);
    const { chatId, workList } = await setupAmbiguousChat(businessId, '11@s.whatsapp.net', ['invoice'], ['weekend']);

    const signal = await computeRelationshipSignal(businessId, chatId, 'Can you send the invoice over?');
    expect(signal?.suggestedListId).toBe(workList.id);
    expect(signal?.candidates.find((c) => c.listId === workList.id)?.score).toBe(1);
    expect(signal?.candidates.find((c) => c.listId !== workList.id)?.score).toBe(0);
  });

  it('a tie (including an all-zero tie) never guesses - suggestedListId stays null, but the real scores are still persisted', async () => {
    const businessId = await createTestBusiness();
    await new BusinessRepository(pool).setRelationshipConfidenceEnabled(businessId, true);
    const { chatId } = await setupAmbiguousChat(businessId, '12@s.whatsapp.net', ['meeting'], ['weekend']);

    const signal = await computeRelationshipSignal(businessId, chatId, 'Just checking in, how are things?');
    expect(signal?.suggestedListId).toBeNull();
    expect(signal?.candidates).toHaveLength(2);
    expect(signal?.candidates.every((c) => c.score === 0)).toBe(true);
  });

  it('never writes whatsapp_chats.active_list_id - that column stays exclusively human-set', async () => {
    const businessId = await createTestBusiness();
    await new BusinessRepository(pool).setRelationshipConfidenceEnabled(businessId, true);
    const { chatId } = await setupAmbiguousChat(businessId, '13@s.whatsapp.net', ['invoice'], ['weekend']);

    await computeRelationshipSignal(businessId, chatId, 'Can you send the invoice over?');
    const chat = await new WhatsAppChatRepository(pool).findByIdForBusiness(chatId, businessId);
    expect(chat?.activeListId).toBeNull();
  });

  it('is deterministic - the same message against the same candidates produces the identical score and suggestion on repeated calls', async () => {
    const businessId = await createTestBusiness();
    await new BusinessRepository(pool).setRelationshipConfidenceEnabled(businessId, true);
    const { chatId, workList } = await setupAmbiguousChat(businessId, '14@s.whatsapp.net', ['invoice'], ['weekend']);

    const first = await computeRelationshipSignal(businessId, chatId, 'Can you send the invoice over?');
    const second = await computeRelationshipSignal(businessId, chatId, 'Can you send the invoice over?');
    expect(first?.suggestedListId).toBe(workList.id);
    expect(second?.suggestedListId).toBe(workList.id);
    expect(first?.candidates).toEqual(second?.candidates);
  });
});

describe('relationshipConfidenceService.computeRelationshipSignal - engagement-history tiebreak follow-up, real Postgres', () => {
  it('a genuine keyword tie is broken by recency: the more recently engaged candidate wins', async () => {
    const businessId = await createTestBusiness();
    await new BusinessRepository(pool).setRelationshipConfidenceEnabled(businessId, true);
    const { chatId, workList, friendsList } = await setupAmbiguousChat(businessId, '15@s.whatsapp.net', ['meeting'], ['weekend']);

    // Tie both candidates' keyword score at zero, then give Work a real, more recent engagement row.
    const { ChatListEngagementRepository } = await import('../src/repositories/chatListEngagementRepository.js');
    await new ChatListEngagementRepository(queryAsTenant(businessId)).recordEngagement(businessId, chatId, workList.id);

    const signal = await computeRelationshipSignal(businessId, chatId, 'Just checking in, how are things?');
    expect(signal?.suggestedListId).toBe(workList.id);
    expect(signal?.candidates.find((c) => c.listId === workList.id)?.engagementCount).toBe(1);
    expect(signal?.candidates.find((c) => c.listId === friendsList.id)?.lastActiveAt).toBeUndefined();
  });

  it('a real keyword winner is NEVER overridden by engagement history, even when the other candidate has more/more-recent engagement', async () => {
    const businessId = await createTestBusiness();
    await new BusinessRepository(pool).setRelationshipConfidenceEnabled(businessId, true);
    const { chatId, workList, friendsList } = await setupAmbiguousChat(businessId, '16@s.whatsapp.net', ['invoice'], ['weekend']);

    const { ChatListEngagementRepository } = await import('../src/repositories/chatListEngagementRepository.js');
    // Friends has real, recent engagement - but Work still wins because its own keyword actually matched this message.
    await new ChatListEngagementRepository(queryAsTenant(businessId)).recordEngagement(businessId, chatId, friendsList.id);

    const signal = await computeRelationshipSignal(businessId, chatId, 'Can you send the invoice over?');
    expect(signal?.suggestedListId).toBe(workList.id);
  });

  it('neither candidate ever engaged - stays null, never fabricates a tiebreak from nothing', async () => {
    const businessId = await createTestBusiness();
    await new BusinessRepository(pool).setRelationshipConfidenceEnabled(businessId, true);
    const { chatId } = await setupAmbiguousChat(businessId, '17@s.whatsapp.net', ['meeting'], ['weekend']);

    const signal = await computeRelationshipSignal(businessId, chatId, 'Just checking in, how are things?');
    expect(signal?.suggestedListId).toBeNull();
  });

  it('both candidates equally engaged (same recency) - stays tied, never guesses', async () => {
    const businessId = await createTestBusiness();
    await new BusinessRepository(pool).setRelationshipConfidenceEnabled(businessId, true);
    const { chatId, workList, friendsList } = await setupAmbiguousChat(businessId, '18@s.whatsapp.net', ['meeting'], ['weekend']);

    // Directly insert two engagement rows with the identical last_active_at - a real, deliberate tie.
    const fixedTimestamp = new Date().toISOString();
    await pool.query(
      `INSERT INTO chat_list_engagement (business_id, chat_id, list_id, engagement_count, last_active_at) VALUES ($1, $2, $3, 1, $4), ($1, $2, $5, 1, $4)`,
      [businessId, chatId, workList.id, fixedTimestamp, friendsList.id],
    );

    const signal = await computeRelationshipSignal(businessId, chatId, 'Just checking in, how are things?');
    expect(signal?.suggestedListId).toBeNull();
  });
});
