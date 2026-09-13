import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * What the operator decided about a conversation, inside AURA.
 *
 * The load-bearing assertion in this file is the first one: these must not
 * share columns with the history sync. is_archived and is_pinned are
 * WhatsApp's own view, overwritten on every sync, and an archive that
 * silently un-archives itself the next time WhatsApp says otherwise is worse
 * than no archive at all.
 */
describe('workspace chat flags', () => {
  let businessId: string;
  let accountId: string;
  let repo: WhatsAppChatRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, '15550003333@s.whatsapp.net');
    repo = new WhatsAppChatRepository(pool);
  });

  async function aChat(jid = '15550004444@s.whatsapp.net') {
    return repo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: jid,
      jidKind: 'individual',
      chatType: 'individual',
    });
  }

  it('keeps the operator\'s archive apart from WhatsApp\'s own', async () => {
    const chat = await aChat();
    await repo.setArchived(businessId, chat.id, true);

    // A sync arrives saying WhatsApp does not consider this archived.
    await repo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: chat.chatJid,
      jidKind: 'individual',
      chatType: 'individual',
      isArchived: false,
    });

    const after = await repo.findByIdForBusiness(chat.id, businessId);
    expect(after?.isArchived).toBe(false);
    // The operator's decision survives, which is the whole point.
    expect(after?.workspaceArchivedAt).not.toBeNull();
  });

  it('takes an archived chat out of the inbox and puts it on its own list', async () => {
    const kept = await aChat('15550001111@s.whatsapp.net');
    const filed = await aChat('15550002222@s.whatsapp.net');
    await repo.setArchived(businessId, filed.id, true);

    const inbox = await repo.listByAccount(businessId, accountId);
    expect(inbox.map((chat) => chat.id)).toEqual([kept.id]);

    const archived = await repo.listByAccount(businessId, accountId, { archived: true });
    expect(archived.map((chat) => chat.id)).toEqual([filed.id]);
  });

  it('puts pinned conversations first, newest pin leading', async () => {
    const older = await aChat('15550001111@s.whatsapp.net');
    const newer = await aChat('15550002222@s.whatsapp.net');
    const unpinned = await aChat('15550003333@s.whatsapp.net');
    await repo.setPinned(businessId, older.id, true);
    await repo.setPinned(businessId, newer.id, true);

    const inbox = await repo.listByAccount(businessId, accountId);
    expect(inbox.slice(0, 2).map((chat) => chat.id)).toEqual([newer.id, older.id]);
    expect(inbox[2]?.id).toBe(unpinned.id);
  });

  it('un-pins and un-archives back to nothing', async () => {
    const chat = await aChat();
    await repo.setPinned(businessId, chat.id, true);
    await repo.setPinned(businessId, chat.id, false);

    expect((await repo.findByIdForBusiness(chat.id, businessId))?.workspacePinnedAt).toBeNull();
  });

  it('clears a deliberate mark-as-unread the moment the chat is actually opened', async () => {
    // A dot that survives opening the thread is a dot people stop believing.
    const chat = await aChat();
    await repo.setMarkedUnread(businessId, chat.id, true);
    await repo.resetUnreadCount(chat.id);

    expect((await repo.findByIdForBusiness(chat.id, businessId))?.workspaceMarkedUnreadAt).toBeNull();
  });

  it('stores "mute until I say otherwise" as one value, not a second flag', async () => {
    const chat = await aChat();
    const forever = new Date('9999-12-31T00:00:00Z');
    await repo.setMutedUntil(businessId, chat.id, forever);

    const muted = await repo.findByIdForBusiness(chat.id, businessId);
    expect(new Date(muted!.workspaceMutedUntil!).getUTCFullYear()).toBe(9999);

    await repo.setMutedUntil(businessId, chat.id, null);
    expect((await repo.findByIdForBusiness(chat.id, businessId))?.workspaceMutedUntil).toBeNull();
  });

  it('never changes another business\'s chat', async () => {
    const other = await createTestBusiness('Someone Else');
    const chat = await aChat();

    expect(await repo.setArchived(other, chat.id, true)).toBeNull();
    expect((await repo.findByIdForBusiness(chat.id, businessId))?.workspaceArchivedAt).toBeNull();
  });

  describe('clearing and deleting', () => {
    it('clears messages without destroying them', async () => {
      // Soft, so an owner who clears the wrong thread has not destroyed the
      // record of what a customer actually said.
      const chat = await aChat();
      await pool.query(
        `INSERT INTO whatsapp_messages
           (business_id, whatsapp_account_id, chat_id, whatsapp_message_id, remote_jid, sender_jid,
            direction, from_me, message_type, status, timestamp)
         VALUES ($1, $2, $3, 'm1', '15550004444@s.whatsapp.net', '15550004444@s.whatsapp.net',
                 'inbound', false, 'text', 'delivered', now())`,
        [businessId, accountId, chat.id],
      );

      expect(await repo.clearMessages(businessId, chat.id)).toBe(1);

      const { rows } = await pool.query('SELECT deleted_at FROM whatsapp_messages WHERE chat_id = $1', [chat.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].deleted_at).not.toBeNull();
    });

    it('clears nothing twice', async () => {
      const chat = await aChat();
      expect(await repo.clearMessages(businessId, chat.id)).toBe(0);
    });

    it('deletes a chat without emptying it, so a restore is a real restore', async () => {
      const chat = await aChat();
      await pool.query(
        `INSERT INTO whatsapp_messages
           (business_id, whatsapp_account_id, chat_id, whatsapp_message_id, remote_jid, sender_jid,
            direction, from_me, message_type, status, timestamp)
         VALUES ($1, $2, $3, 'm1', '15550004444@s.whatsapp.net', '15550004444@s.whatsapp.net',
                 'inbound', false, 'text', 'delivered', now())`,
        [businessId, accountId, chat.id],
      );

      expect(await repo.softDelete(businessId, chat.id)).toBe(true);

      const { rows } = await pool.query('SELECT deleted_at FROM whatsapp_messages WHERE chat_id = $1', [chat.id]);
      expect(rows[0].deleted_at).toBeNull();
    });

    it('reports a delete of something already gone rather than claiming success', async () => {
      const chat = await aChat();
      await repo.softDelete(businessId, chat.id);

      expect(await repo.softDelete(businessId, chat.id)).toBe(false);
    });

    it('never deletes another business\'s chat', async () => {
      const other = await createTestBusiness('Someone Else');
      const chat = await aChat();

      expect(await repo.softDelete(other, chat.id)).toBe(false);
      expect((await repo.findByIdForBusiness(chat.id, businessId))?.deletedAt).toBeNull();
    });
  });
});
