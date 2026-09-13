import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

/**
 * Starring and pinning are the operator's own marks on a message, and they
 * stay inside AURA - see migration 1044. Nothing here is pushed to
 * WhatsApp, and nothing the ingestion path writes can overwrite them.
 */
describe('what the operator marks on a message', () => {
  let businessId: string;
  let otherBusinessId: string;
  let accountId: string;
  let chatId: string;
  let userId: string;
  let messages: WhatsAppMessageRepository;

  async function addMessage(text: string, when = '2026-09-13T12:00:00.000Z'): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO whatsapp_messages
         (business_id, whatsapp_account_id, chat_id, whatsapp_message_id, remote_jid, sender_jid,
          direction, message_type, text_content, "timestamp", from_me, status)
       VALUES ($1, $2, $3, $4, '15550001111@s.whatsapp.net', '15550001111@s.whatsapp.net',
               'inbound', 'text', $5, $6, false, 'delivered')
       RETURNING id`,
      [businessId, accountId, chatId, `wamid-${text}-${when}`, text, when],
    );
    return rows[0]!.id;
  }

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    otherBusinessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId, whatsappAccountId: accountId,
      chatJid: '15550001111@s.whatsapp.net', jidKind: 'individual', chatType: 'individual',
    });
    chatId = chat.id;
    userId = await createTestUser(businessId);
    messages = new WhatsAppMessageRepository(pool);
  });

  describe('starring', () => {
    it('records when it was starred, not merely that it was', async () => {
      const id = await addMessage('keep this');
      const starred = await messages.setStarred(id, businessId, true);
      expect(starred?.workspaceStarredAt).not.toBeNull();
    });

    it('keeps the original time when the same message is starred again', async () => {
      const id = await addMessage('keep this');
      const first = await messages.setStarred(id, businessId, true);
      const again = await messages.setStarred(id, businessId, true);
      expect(again?.workspaceStarredAt).toBe(first?.workspaceStarredAt);
    });

    it('clears it on unstar', async () => {
      const id = await addMessage('keep this');
      await messages.setStarred(id, businessId, true);
      const cleared = await messages.setStarred(id, businessId, false);
      expect(cleared?.workspaceStarredAt).toBeNull();
    });

    it('will not touch another business’s message, and says so as a miss rather than an error', async () => {
      const id = await addMessage('keep this');
      expect(await messages.setStarred(id, otherBusinessId, true)).toBeNull();

      const untouched = await messages.findById(id);
      expect(untouched?.workspaceStarredAt).toBeNull();
    });

    it('lists everything kept, newest first, across the whole workspace', async () => {
      const older = await addMessage('older');
      const newer = await addMessage('newer');
      await messages.setStarred(older, businessId, true);
      // A distinct instant, so "newest first" is a real ordering rather than
      // whatever the two rows happened to come back as.
      await pool.query(`UPDATE whatsapp_messages SET workspace_starred_at = now() + interval '1 minute' WHERE id = $1`, [newer]);

      const starred = await messages.listStarred(businessId);
      expect(starred.map((message) => message.id)).toEqual([newer, older]);
    });

    it('lists nothing for a business that has starred nothing', async () => {
      await addMessage('unstarred');
      expect(await messages.listStarred(businessId)).toEqual([]);
    });
  });

  describe('pinning', () => {
    it('records who pinned it, so a pin has somebody to ask about it', async () => {
      const id = await addMessage('the address');
      const pinned = await messages.setPinned(id, businessId, true, userId);
      expect(pinned?.workspacePinnedAt).not.toBeNull();
      expect(pinned?.workspacePinnedBy).toBe(userId);
    });

    it('does not reassign the pinner when somebody else re-pins it', async () => {
      const id = await addMessage('the address');
      await messages.setPinned(id, businessId, true, userId);
      const again = await messages.setPinned(id, businessId, true, null);
      expect(again?.workspacePinnedBy).toBe(userId);
    });

    it('clears both the time and the pinner on unpin', async () => {
      const id = await addMessage('the address');
      await messages.setPinned(id, businessId, true, userId);
      const cleared = await messages.setPinned(id, businessId, false, userId);
      expect(cleared?.workspacePinnedAt).toBeNull();
      expect(cleared?.workspacePinnedBy).toBeNull();
    });

    it('lists the pins for one conversation only', async () => {
      const pinned = await addMessage('the address');
      await addMessage('chatter');
      await messages.setPinned(pinned, businessId, true, userId);

      const inChat = await messages.listPinnedForChat(businessId, chatId);
      expect(inChat.map((message) => message.id)).toEqual([pinned]);
    });
  });
});
