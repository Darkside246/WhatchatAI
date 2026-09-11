import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { BusinessRepository } from '../src/repositories/businessRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { NotificationRepository } from '../src/repositories/notificationRepository.js';
import { notifyBusiness } from '../src/services/notificationService.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { whatsappConnectionManager } from '../src/services/whatsappConnectionManager.js';
import { createTestAccount, createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

describe('WhatsApp Channels', () => {
  let businessId: string;
  let accountId: string;
  const chatRepository = new WhatsAppChatRepository(pool);

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('lists newsletter chats as channels - the ones the conversation list deliberately excludes', async () => {
    const channel = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '120363000000000000@newsletter',
      jidKind: 'newsletter',
      chatType: 'newsletter',
      name: 'Barbados Weather',
    });
    await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '12465551234@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });

    const channels = await workspaceService.listChannels(businessId, accountId);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe(channel.id);
    expect(channels[0]!.displayName).toBe('Barbados Weather');

    // And the conversation list still excludes it - the two views stay disjoint.
    const chats = await workspaceService.listChats(businessId, accountId);
    expect(chats.some((chat) => chat.id === channel.id)).toBe(false);
  });

  it('never shows a raw newsletter JID as a channel name when WhatsApp has not sent one', async () => {
    // The real symptom, seen in the running app: a channel with no name yet
    // rendered as "120363151346599421@newsletter". That is an internal
    // address, not a name - the same mistake as showing a raw LID instead of
    // a contact's name. WhatsApp simply has not sent the metadata for that
    // channel, and saying so is more honest than showing the identifier.
    await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '120363151346599421@newsletter',
      jidKind: 'newsletter',
      chatType: 'newsletter',
    });

    const channels = await workspaceService.listChannels(businessId, accountId);
    const unnamed = channels.find((channel) => channel.chatJid === '120363151346599421@newsletter');
    expect(unnamed).toBeDefined();
    expect(unnamed!.displayName).not.toContain('@newsletter');
    // No live connection in this test, so there is no one to ask - the
    // generic label is what is left. See the backfill tests below for what
    // happens when WhatsApp can be reached.
    expect(unnamed!.displayName).toBe('WhatsApp Channel');
  });

  /**
   * "Why do some have names and some do not": a channel whose metadata never
   * arrived on the ingestion path had nothing but a generic label, which
   * reads like a name and is not one. There is nothing to fix upstream - the
   * data was not sent - so the name is asked of WhatsApp directly the first
   * time someone opens the list, and written to the row.
   */
  describe('asks WhatsApp for a channel name it was never sent', () => {
    let fetchName: ReturnType<typeof vi.spyOn> | null = null;
    afterEach(() => {
      // Restores only this spy. vi.restoreAllMocks() would reach past this
      // describe and undo setup other tests in the file rely on.
      fetchName?.mockRestore();
      fetchName = null;
    });

    it('uses the real name and records it, so it is never asked for twice', async () => {
      const chat = await chatRepository.upsertFromWhatsApp({
        businessId,
        whatsappAccountId: accountId,
        chatJid: '120363151346599421@newsletter',
        jidKind: 'newsletter',
        chatType: 'newsletter',
      });

      fetchName = vi.spyOn(whatsappConnectionManager, 'fetchChannelName').mockResolvedValue('Barbados Today News');

      const first = await workspaceService.listChannels(businessId, accountId);
      expect(first[0]!.displayName).toBe('Barbados Today News');
      expect(fetchName).toHaveBeenCalledTimes(1);

      // Persisted, so the second view reads the row instead of asking again.
      const stored = await chatRepository.findByIdForBusiness(chat.id, businessId);
      expect(stored?.name).toBe('Barbados Today News');

      const second = await workspaceService.listChannels(businessId, accountId);
      expect(second[0]!.displayName).toBe('Barbados Today News');
      expect(fetchName).toHaveBeenCalledTimes(1); // not asked a second time
    });

    it('never asks for a channel that already has a name', async () => {
      await chatRepository.upsertFromWhatsApp({
        businessId,
        whatsappAccountId: accountId,
        chatJid: '120363000000000001@newsletter',
        jidKind: 'newsletter',
        chatType: 'newsletter',
        name: 'Premier League',
      });

      fetchName = vi.spyOn(whatsappConnectionManager, 'fetchChannelName').mockResolvedValue('Something Else');

      const channels = await workspaceService.listChannels(businessId, accountId);
      expect(channels[0]!.displayName).toBe('Premier League');
      expect(fetchName).not.toHaveBeenCalled();
    });

    it('still renders the list when WhatsApp cannot be asked', async () => {
      await chatRepository.upsertFromWhatsApp({
        businessId,
        whatsappAccountId: accountId,
        chatJid: '120363151346599422@newsletter',
        jidKind: 'newsletter',
        chatType: 'newsletter',
      });

      // Offline, or WhatsApp declines. A missing name is cosmetic; failing
      // the whole list over it would not be.
      fetchName = vi.spyOn(whatsappConnectionManager, 'fetchChannelName').mockRejectedValue(new Error('not connected'));

      const channels = await workspaceService.listChannels(businessId, accountId);
      expect(channels).toHaveLength(1);
      expect(channels[0]!.displayName).toBe('WhatsApp Channel');
    });
  });

  it('never lists another tenant\'s channels', async () => {
    const otherBusinessId = await createTestBusiness();
    const otherAccountId = await createTestAccount(otherBusinessId, '15559998888@s.whatsapp.net');
    await chatRepository.upsertFromWhatsApp({
      businessId: otherBusinessId,
      whatsappAccountId: otherAccountId,
      chatJid: '120363999999999999@newsletter',
      jidKind: 'newsletter',
      chatType: 'newsletter',
      name: 'Theirs',
    });

    expect(await workspaceService.listChannels(businessId, accountId)).toEqual([]);
  });
});

describe('channel notifications are off unless a business turns them on', () => {
  let businessId: string;
  const businessRepository = new BusinessRepository(pool);

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    await createTestUser(businessId);
  });

  it('defaults to off, so an existing business never suddenly starts getting a new class of notification', async () => {
    const business = await businessRepository.findById(businessId);
    expect(business?.channelNotificationsEnabled).toBe(false);
  });

  it('drops a channel-targeted notification while the setting is off', async () => {
    const created = await notifyBusiness({
      businessId,
      type: 'SYSTEM',
      severity: 'info',
      title: 'New post in a channel',
      targetType: 'channel',
      targetId: randomUUID(),
    });

    expect(created).toEqual([]);
    // Nothing was written - not merely hidden.
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM notifications WHERE business_id = $1',
      [businessId],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('delivers it once the business turns the setting on', async () => {
    await businessRepository.setChannelNotificationsEnabled(businessId, true);

    const created = await notifyBusiness({
      businessId,
      type: 'SYSTEM',
      severity: 'info',
      title: 'New post in a channel',
      targetType: 'channel',
      targetId: randomUUID(),
    });

    expect(created.length).toBeGreaterThan(0);
  });

  it('never suppresses a real conversation notification - the gate is channel-specific', async () => {
    const created = await notifyBusiness({
      businessId,
      type: 'HUMAN_HANDOFF',
      severity: 'warning',
      title: 'A conversation needs a human',
      targetType: 'chat',
      targetId: randomUUID(),
    });

    expect(created.length).toBeGreaterThan(0);
    expect(await new NotificationRepository(pool).countUnread(businessId, created[0]!.userId)).toBeGreaterThan(0);
  });
});
