import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppMediaRepository } from '../src/repositories/whatsappMediaRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppAccountRepository } from '../src/repositories/whatsappAccountRepository.js';
import { syncContactProfilePicture, syncAccountProfilePicture } from '../src/services/profilePictureSyncService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const mediaRepository = new WhatsAppMediaRepository(pool);
const contactRepository = new WhatsAppContactRepository(pool);
const accountRepository = new WhatsAppAccountRepository(pool);

describe('whatsapp_media owner exclusivity (contact/account owners)', () => {
  it('accepts a contact-owned media row with no message/status/account', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const contact = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
    });

    const media = await mediaRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      contactId: contact.id,
      mediaType: 'image',
      mimeType: 'image/jpeg',
      fileSize: 1024,
    });

    expect(media.contactId).toBe(contact.id);
    expect(media.messageId).toBeNull();
    expect(media.statusId).toBeNull();
    expect(media.accountId).toBeNull();
  });

  it('accepts an account-owned media row with no message/status/contact', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);

    const media = await mediaRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      accountId,
      mediaType: 'image',
      mimeType: 'image/jpeg',
      fileSize: 2048,
    });

    expect(media.accountId).toBe(accountId);
    expect(media.messageId).toBeNull();
    expect(media.statusId).toBeNull();
    expect(media.contactId).toBeNull();
  });

  it('rejects a media row with zero owners', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);

    await expect(
      mediaRepository.insert({
        businessId,
        whatsappAccountId: accountId,
        mediaType: 'image',
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it('rejects a media row claiming both a contact and an account owner', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const contact = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550003333@s.whatsapp.net',
      jidKind: 'individual',
    });

    await expect(
      mediaRepository.insert({
        businessId,
        whatsappAccountId: accountId,
        contactId: contact.id,
        accountId,
        mediaType: 'image',
      }),
    ).rejects.toThrow(/exactly one/);
  });
});

describe('profile picture attach methods', () => {
  it('points a contact at its real, downloaded profile picture media row', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const contact = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550004444@s.whatsapp.net',
      jidKind: 'individual',
    });
    expect(contact.profilePictureMediaId).toBeNull();

    const media = await mediaRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      contactId: contact.id,
      mediaType: 'image',
    });
    await contactRepository.attachProfilePicture(contact.id, media.id);

    const reloaded = await contactRepository.findById(contact.id);
    expect(reloaded?.profilePictureMediaId).toBe(media.id);
  });

  it('points an account at its real, downloaded profile picture media row', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const account = await accountRepository.findById(accountId);
    expect(account?.profilePictureMediaId).toBeNull();

    const media = await mediaRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      accountId,
      mediaType: 'image',
    });
    await accountRepository.attachProfilePicture(accountId, media.id);

    const reloaded = await accountRepository.findById(accountId);
    expect(reloaded?.profilePictureMediaId).toBe(media.id);
  });
});

describe('profilePictureSyncService (no live Baileys socket in tests - honest no-op path)', () => {
  it('syncContactProfilePicture leaves the contact untouched when there is no live connection to fetch from', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const contact = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550005555@s.whatsapp.net',
      jidKind: 'individual',
    });

    await syncContactProfilePicture(businessId, accountId, contact.id, contact.whatsappJid);

    const reloaded = await contactRepository.findById(contact.id);
    expect(reloaded?.profilePictureMediaId).toBeNull();
  });

  it('syncContactProfilePicture is a no-op when the contact already has a profile picture attached', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    const contact = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550006666@s.whatsapp.net',
      jidKind: 'individual',
    });
    const media = await mediaRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      contactId: contact.id,
      mediaType: 'image',
    });
    await contactRepository.attachProfilePicture(contact.id, media.id);

    // Should return immediately without throwing, and without touching the existing attachment.
    await syncContactProfilePicture(businessId, accountId, contact.id, contact.whatsappJid);

    const reloaded = await contactRepository.findById(contact.id);
    expect(reloaded?.profilePictureMediaId).toBe(media.id);
  });

  it('syncAccountProfilePicture leaves the account untouched when there is no live connection to fetch from', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);

    await syncAccountProfilePicture(businessId, accountId, '15550001111@s.whatsapp.net');

    const reloaded = await accountRepository.findById(accountId);
    expect(reloaded?.profilePictureMediaId).toBeNull();
  });
});
