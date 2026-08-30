import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { whatsappConnectionManager } from './whatsappConnectionManager.js';
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

async function checksumAndStore(
  businessId: string,
  buffer: Buffer,
): Promise<{ sha256Hex: string; storageReference: string; fileSize: number } | null> {
  if (buffer.length === 0 || buffer.length > MAX_PROFILE_PICTURE_BYTES) return null;
  const sha256Hex = createHash('sha256').update(buffer).digest('hex');
  const storageReference = await storeMedia(businessId, sha256Hex, buffer);
  return { sha256Hex, storageReference, fileSize: buffer.length };
}

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

  return checksumAndStore(businessId, buffer);
}

/**
 * Stores the exact bytes just pushed to WhatsApp as this account's own
 * local copy - no redundant round-trip back through WhatsApp's CDN. Always
 * overwrites any prior photo (unlike syncAccountProfilePicture's
 * once-ever guard): this is a real, human-initiated replace, not a
 * best-effort background backfill.
 */
export async function storeAndAttachAccountProfilePicture(
  businessId: string,
  whatsappAccountId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<void> {
  const stored = await checksumAndStore(businessId, buffer);
  if (!stored) throw new Error('Profile picture is empty or exceeds the size limit');

  const media = await mediaRepository.insert({
    businessId,
    whatsappAccountId,
    accountId: whatsappAccountId,
    mediaType: 'image',
    mimeType,
    fileSize: stored.fileSize,
  });
  await mediaRepository.setDownloadResult(media.id, 'downloaded', stored.storageReference, stored.sha256Hex, stored.fileSize);
  await accountRepository.attachProfilePicture(whatsappAccountId, media.id);
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

    const url = await whatsappConnectionManager.fetchProfilePictureUrl(businessId, jid);
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

// Real per-request delay between queued fetches - mass concurrent
// profilePictureUrl() calls across a whole chat list would hit Meta's own
// CDN rate limits (429s), turning a background convenience into a real
// failure mode. One real request in flight at a time, spaced out, is how
// every contact eventually gets a real photo without ever being throttled.
const QUEUE_DELAY_MS = 250;
const queue: (() => Promise<void>)[] = [];
const queuedContactIds = new Set<string>();
let draining = false;

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) continue;
      await job();
      if (queue.length > 0) await new Promise((resolve) => setTimeout(resolve, QUEUE_DELAY_MS));
    }
  } finally {
    draining = false;
  }
}

/**
 * Non-blocking entry point for background enrichment (e.g. the chat list
 * rendering before any single chat has been opened) - queues a real sync
 * job rather than firing it immediately, and skips a contact already
 * queued so a fast poll loop can't pile up duplicate jobs for the same
 * contact while one is still in flight.
 */
export function enqueueContactProfilePictureSync(
  businessId: string,
  whatsappAccountId: string,
  contactId: string,
  jid: string,
): void {
  if (queuedContactIds.has(contactId)) return;
  queuedContactIds.add(contactId);
  queue.push(async () => {
    try {
      await syncContactProfilePicture(businessId, whatsappAccountId, contactId, jid);
    } finally {
      queuedContactIds.delete(contactId);
    }
  });
  void drainQueue();
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

    const url = await whatsappConnectionManager.fetchProfilePictureUrl(businessId, jid);
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
