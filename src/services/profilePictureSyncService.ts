import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { whatsappConnectionService } from './whatsappConnectionService.js';
import { WhatsAppMediaRepository } from '../repositories/whatsappMediaRepository.js';
import { WhatsAppContactRepository } from '../repositories/whatsappContactRepository.js';
import { WhatsAppAccountRepository } from '../repositories/whatsappAccountRepository.js';
import { storeMedia } from '../media/localEncryptedMediaStorage.js';

// WhatsApp's own profile pictures are small (well under 1MB in practice) -
// this is a generous ceiling, never a reason to trust an unbounded download
// from a URL WhatsApp itself handed us.
const MAX_PROFILE_PICTURE_BYTES = 5 * 1024 * 1024;

const mediaRepository = new WhatsAppMediaRepository(pool);
const contactRepository = new WhatsAppContactRepository(pool);
const accountRepository = new WhatsAppAccountRepository(pool);

/**
 * Profile pictures aren't E2E-encrypted WhatsApp media messages - they're a
 * plain HTTPS image WhatsApp's own CDN serves once fetchProfilePictureUrl
 * hands back a real URL. A real download, real checksum, real encrypted-at-
 * rest storage (the same storeMedia() every other real media in this app
 * uses) - never a fabricated success, and never a placeholder image.
 */
async function downloadAndStore(
  businessId: string,
  url: string,
): Promise<{ sha256Hex: string; storageReference: string; fileSize: number } | null> {
  let buffer: Buffer;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error('[ProfilePictureSync] Download failed:', error instanceof Error ? error.message : error);
    return null;
  }

  if (buffer.length === 0 || buffer.length > MAX_PROFILE_PICTURE_BYTES) return null;

  const sha256Hex = createHash('sha256').update(buffer).digest('hex');
  const storageReference = await storeMedia(businessId, sha256Hex, buffer);
  return { sha256Hex, storageReference, fileSize: buffer.length };
}

/**
 * Fetches, downloads, and attaches a real profile picture for a WhatsApp
 * contact - best-effort and silent on any failure (no photo set, privacy
 * blocked, download failed): the contact simply keeps showing initials,
 * never a broken image or a fabricated one. Only ever fetches once per
 * contact in this version - an already-attached photo is left alone rather
 * than being silently refreshed on every call.
 */
export async function syncContactProfilePicture(
  businessId: string,
  whatsappAccountId: string,
  contactId: string,
  jid: string,
): Promise<void> {
  try {
    const contact = await contactRepository.findById(contactId);
    if (!contact || contact.profilePictureMediaId) return;

    const url = await whatsappConnectionService.fetchProfilePictureUrl(jid);
    if (!url) return;

    const downloaded = await downloadAndStore(businessId, url);
    if (!downloaded) return;

    const media = await mediaRepository.insert({
      businessId,
      whatsappAccountId,
      contactId,
      mediaType: 'image',
      mimeType: 'image/jpeg',
      fileSize: downloaded.fileSize,
    });
    await mediaRepository.setDownloadResult(media.id, 'downloaded', downloaded.storageReference, downloaded.sha256Hex, downloaded.fileSize);
    await contactRepository.attachProfilePicture(contactId, media.id);
  } catch (error) {
    console.error(`[ProfilePictureSync] Failed to sync contact ${contactId} profile picture:`, error);
  }
}

/** Same real fetch/download/encrypt flow as syncContactProfilePicture, for the connected account's own ("my profile photo") picture. */
export async function syncAccountProfilePicture(
  businessId: string,
  whatsappAccountId: string,
  jid: string,
): Promise<void> {
  try {
    const account = await accountRepository.findById(whatsappAccountId);
    if (!account || account.profilePictureMediaId) return;

    const url = await whatsappConnectionService.fetchProfilePictureUrl(jid);
    if (!url) return;

    const downloaded = await downloadAndStore(businessId, url);
    if (!downloaded) return;

    const media = await mediaRepository.insert({
      businessId,
      whatsappAccountId,
      accountId: whatsappAccountId,
      mediaType: 'image',
      mimeType: 'image/jpeg',
      fileSize: downloaded.fileSize,
    });
    await mediaRepository.setDownloadResult(media.id, 'downloaded', downloaded.storageReference, downloaded.sha256Hex, downloaded.fileSize);
    await accountRepository.attachProfilePicture(whatsappAccountId, media.id);
  } catch (error) {
    console.error(`[ProfilePictureSync] Failed to sync account ${whatsappAccountId} profile picture:`, error);
  }
}
