import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { BusinessRepository } from '../src/repositories/businessRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { NotificationRepository } from '../src/repositories/notificationRepository.js';
import { notifyBusiness } from '../src/services/notificationService.js';
import { workspaceService } from '../src/services/workspaceService.js';
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
    expect(unnamed!.displayName).toBe('WhatsApp Channel');
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
