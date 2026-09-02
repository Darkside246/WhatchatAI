import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { AiCommitmentRepository } from '../src/repositories/aiCommitmentRepository.js';
import { PlatformActionRepository } from '../src/repositories/platformActionRepository.js';
import { InvoiceRepository } from '../src/repositories/invoiceRepository.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const chatRepo = new WhatsAppChatRepository(pool);
const commitmentRepo = new AiCommitmentRepository(pool);
const actionRepo = new PlatformActionRepository(pool);
const invoiceRepo = new InvoiceRepository(pool);
const agentRepo = new AiAgentRepository(pool);

describe('workspaceService.getNextBestActions (real Postgres, real aggregation across 4 real signal sources)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('returns an empty list when there is truly nothing to act on', async () => {
    expect(await workspaceService.getNextBestActions(businessId)).toEqual([]);
  });

  it('surfaces a real chat waiting on a human', async () => {
    const chat = await chatRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, chatJid: '15550001111@s.whatsapp.net', jidKind: 'individual', chatType: 'individual', name: 'Jane Customer' });
    await chatRepo.setAiMode(chat.id, 'HUMAN_TAKEOVER', 'manual_reply_detected');

    const actions = await workspaceService.getNextBestActions(businessId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'chat_needs_human', priority: 'action_needed', link: `/chats/${chat.id}` });
    expect(actions[0]?.title).toContain('Jane Customer');
  });

  it('surfaces a real open commitment', async () => {
    const chat = await chatRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, chatJid: '15550002222@s.whatsapp.net', jidKind: 'individual', chatType: 'individual' });
    await commitmentRepo.record({ businessId, chatId: chat.id, commitmentText: "I'll check on that.", detectedPhrase: "I'll check" });
    await pool.query(`UPDATE ai_commitments SET created_at = now() - interval '10 hours'`);

    const actions = await workspaceService.getNextBestActions(businessId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'open_commitment', priority: 'action_needed' });
  });

  it('surfaces a real pending approval', async () => {
    const agent = await agentRepo.create({ businessId, name: 'Reception Agent' });
    const row = await actionRepo.create({
      id: randomUUID(), businessId, type: 'meeting.schedule_google_meet', payload: {}, requestedByKind: 'AGENT', requestedById: agent.id,
      riskLevel: 'MEDIUM', approvalRequired: true, approvalStatus: 'PENDING', status: 'PENDING_APPROVAL',
      idempotencyKey: `test-${randomUUID()}`, correlationId: randomUUID(), executionResult: null, executionError: null,
    });
    await actionRepo.createApproval({ id: randomUUID(), actionRequestId: row.id, businessId });

    const actions = await workspaceService.getNextBestActions(businessId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'pending_approval', priority: 'action_needed', link: '/property-operations' });
  });

  it('surfaces a real overdue invoice', async () => {
    await invoiceRepo.create({
      businessId, lineItems: [{ description: 'Repair', quantity: 1, unitPriceCents: 5000 }],
      dueDate: '2020-01-01',
    });
    await pool.query(`UPDATE invoices SET status = 'OVERDUE' WHERE business_id = $1`, [businessId]);

    const actions = await workspaceService.getNextBestActions(businessId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'overdue_invoice', priority: 'action_needed' });
    expect(actions[0]?.description).toContain('50.00');
  });

  it('ranks action_needed items before suggestion items, and by age within a tier - oldest first', async () => {
    // A real approval-pattern suggestion (priority: suggestion).
    process.env.APPROVAL_PATTERN_THRESHOLD = '2';
    const agent = await agentRepo.create({ businessId, name: 'Streak Agent', requiresApprovalForActions: true });
    for (let i = 0; i < 2; i += 1) {
      const row = await actionRepo.create({
        id: randomUUID(), businessId, type: 'meeting.schedule_google_meet', payload: {}, requestedByKind: 'AGENT', requestedById: agent.id,
        riskLevel: 'MEDIUM', approvalRequired: true, approvalStatus: 'PENDING', status: 'PENDING_APPROVAL',
        idempotencyKey: `test-${randomUUID()}`, correlationId: randomUUID(), executionResult: null, executionError: null,
      });
      await actionRepo.createApproval({ id: randomUUID(), actionRequestId: row.id, businessId });
      await actionRepo.decideApproval(businessId, row.id, randomUUID(), 'APPROVED');
      // Real ApprovalService.decide() also flips the action itself to
      // APPROVED/READY - without this, listPendingApprovals would still
      // (correctly) treat these as pending, since only platform_approvals
      // was updated above.
      await actionRepo.updateState(businessId, row.id, { approvalStatus: 'APPROVED', status: 'READY' });
    }

    // A real, older chat-needs-human (action_needed).
    const oldChat = await chatRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, chatJid: '15550003333@s.whatsapp.net', jidKind: 'individual', chatType: 'individual', name: 'Older Chat' });
    await chatRepo.setAiMode(oldChat.id, 'HUMAN_TAKEOVER', 'manual_reply_detected');
    await pool.query(`UPDATE whatsapp_chats SET updated_at = now() - interval '2 days' WHERE id = $1`, [oldChat.id]);

    // A real, newer chat-needs-human (action_needed).
    const newChat = await chatRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, chatJid: '15550004444@s.whatsapp.net', jidKind: 'individual', chatType: 'individual', name: 'Newer Chat' });
    await chatRepo.setAiMode(newChat.id, 'HUMAN_TAKEOVER', 'manual_reply_detected');

    const actions = await workspaceService.getNextBestActions(businessId);
    expect(actions.map((a) => a.priority)).toEqual(['action_needed', 'action_needed', 'suggestion']);
    expect(actions[0]?.title).toContain('Older Chat');
    expect(actions[1]?.title).toContain('Newer Chat');
    expect(actions[2]?.type).toBe('approval_pattern_suggestion');

    delete process.env.APPROVAL_PATTERN_THRESHOLD;
  });

  it('never leaks another business\'s actions', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAccountId = await createTestAccount(otherBusinessId, '15550005555@s.whatsapp.net');
    const otherChat = await chatRepo.upsertFromWhatsApp({ businessId: otherBusinessId, whatsappAccountId: otherAccountId, chatJid: '15550005555@s.whatsapp.net', jidKind: 'individual', chatType: 'individual' });
    await chatRepo.setAiMode(otherChat.id, 'HUMAN_TAKEOVER', 'manual_reply_detected');

    expect(await workspaceService.getNextBestActions(businessId)).toEqual([]);
  });
});
