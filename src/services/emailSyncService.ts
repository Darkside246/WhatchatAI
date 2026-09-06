/**
 * Syncs messages from connected Gmail and Outlook accounts into
 * email_oauth_messages, organized under real, provider-discovered folders
 * (email_oauth_folders) - not a fixed Inbox/Sent guess. Each account's
 * real folder/label list is discovered first (discoverFolders), then each
 * folder is synced independently with its own cursor (syncFolder) -
 * replacing the previous single hardcoded `in:inbox` Gmail query, which
 * had a real, silent bug: it tagged a message 'SENT' when its labelIds
 * included SENT, but the query itself only ever returned Inbox mail, so
 * that branch could never actually fire. Sent (and every other folder)
 * simply wasn't synced before this file's Email Redesign Phase A rework.
 *
 * Every exported function below constructs its own tenant-scoped
 * EmailOAuthRepository via queryAsTenant(businessId) rather than sharing
 * one module-level instance on the bare pool - these tables are RLS'd
 * (migration 993), so a bare-pool query would silently see zero rows.
 * The one deliberate exception is sweepEmailOAuthSync's own listing,
 * which genuinely needs every business's accounts at once.
 */

import { pool, queryAsTenant } from '../db/pool.js';
import { EmailOAuthRepository, type EmailOAuthFolderRecord, type WellKnownFolderType } from '../repositories/emailOAuthRepository.js';
import { getValidAccessToken } from './emailOAuthService.js';

/** Per-folder sync stays bounded regardless of mailbox size - a stated, tunable default, not a hard architectural limit. */
const MAX_MESSAGES_PER_FOLDER_PER_RUN = 200;

// ── Gmail ─────────────────────────────────────────────────────────────────

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

type GmailLabel = { id: string; name: string; type: 'system' | 'user' };
type GmailLabelListResponse = { labels?: GmailLabel[] };

type GmailMessageHeader = { name: string; value: string };
interface GmailMessagePart {
  mimeType: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}
export type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    mimeType?: string;
    headers?: GmailMessageHeader[];
    body?: { data?: string };
    parts?: GmailMessagePart[];
  };
  internalDate?: string;
};
type GmailListResponse = { messages?: Array<{ id: string }>; nextPageToken?: string };

function decodeBase64(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/**
 * Gmail's `parts` array is genuinely recursive - a message with an
 * attachment (or any multipart/mixed wrapping a multipart/alternative)
 * nests the real text/plain and text/html parts one or more levels deep,
 * not at the top level. A flat, one-level find() silently finds nothing
 * for those messages.
 */
function findPartByMimeType(parts: GmailMessagePart[], mimeType: string): GmailMessagePart | undefined {
  for (const part of parts) {
    if (part.mimeType === mimeType && part.body?.data) return part;
    if (part.parts) {
      const found = findPartByMimeType(part.parts, mimeType);
      if (found) return found;
    }
  }
  return undefined;
}

export function extractGmailBody(msg: GmailMessage): { html: string | null; text: string | null } {
  const htmlPart = findPartByMimeType(msg.payload?.parts ?? [], 'text/html');
  const textPart = findPartByMimeType(msg.payload?.parts ?? [], 'text/plain');
  if (htmlPart || textPart) {
    return {
      html: htmlPart?.body?.data ? decodeBase64(htmlPart.body.data) : null,
      text: textPart?.body?.data ? decodeBase64(textPart.body.data) : null,
    };
  }

  // No multipart structure at all (no `parts` array) - the top-level
  // payload itself IS the whole body, and only ITS OWN mimeType says
  // whether that's real HTML or plain text. Real bug this fixes: the
  // previous code assigned this direct body to `text` unconditionally,
  // regardless of its real mimeType - every single-part HTML email (no
  // multipart/alternative wrapper, e.g. many automated notification
  // emails) put raw HTML source into the plain-text field, which every
  // client then rendered as literal <html><body>...</body></html> text
  // instead of formatted content.
  const directBody = msg.payload?.body?.data;
  if (!directBody) return { html: null, text: null };
  return msg.payload?.mimeType === 'text/html'
    ? { html: decodeBase64(directBody), text: null }
    : { html: null, text: decodeBase64(directBody) };
}

function header(msg: GmailMessage, name: string): string | null {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

async function gmailFetch<T>(token: string, path: string): Promise<T> {
  const resp = await fetch(`${GMAIL_BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Gmail API ${path} → ${resp.status}`);
  return (await resp.json()) as T;
}

/** System labels that are flags/tabs, not real folders a person browses - never surfaced as a folder. */
const GMAIL_NON_FOLDER_LABELS = new Set([
  'UNREAD', 'STARRED', 'IMPORTANT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
]);

const GMAIL_WELL_KNOWN: Record<string, WellKnownFolderType> = {
  INBOX: 'inbox', SENT: 'sent', DRAFT: 'drafts', SPAM: 'spam', TRASH: 'trash',
};

async function discoverGmailFolders(repo: EmailOAuthRepository, accountId: string, businessId: string, token: string): Promise<EmailOAuthFolderRecord[]> {
  const { labels } = await gmailFetch<GmailLabelListResponse>(token, '/labels');
  const folders: EmailOAuthFolderRecord[] = [];
  for (const label of labels ?? []) {
    if (GMAIL_NON_FOLDER_LABELS.has(label.id)) continue;
    const wellKnownType = GMAIL_WELL_KNOWN[label.id] ?? 'other';
    folders.push(
      await repo.upsertFolder(accountId, businessId, {
        providerFolderId: label.id,
        displayName: label.name,
        wellKnownType,
      }),
    );
  }
  return folders;
}

async function syncGmailFolder(repo: EmailOAuthRepository, accountId: string, businessId: string, token: string, folder: EmailOAuthFolderRecord): Promise<void> {
  let pageToken: string | undefined;
  const messageIds: string[] = [];

  do {
    // newer_than:30d bounds a first sync of a large, years-old mailbox -
    // same recency window the pre-rework sync already used.
    const qs = new URLSearchParams({ labelIds: folder.providerFolderId, q: 'newer_than:30d', maxResults: '50' });
    if (pageToken) qs.set('pageToken', pageToken);
    const list = await gmailFetch<GmailListResponse>(token, `/messages?${qs}`);
    for (const m of list.messages ?? []) messageIds.push(m.id);
    pageToken = list.nextPageToken;
  } while (pageToken && messageIds.length < MAX_MESSAGES_PER_FOLDER_PER_RUN);

  for (const id of messageIds) {
    try {
      const msg = await gmailFetch<GmailMessage>(token, `/messages/${id}?format=full`);
      const from = header(msg, 'from') ?? '';
      const fromMatch = from.match(/^(?:"?([^"]*)"?\s*)?<?([^>]+)>?$/);
      const body = extractGmailBody(msg);

      await repo.upsertMessage(accountId, businessId, {
        providerMessageId: msg.id,
        providerThreadId: msg.threadId ?? null,
        folderId: folder.id,
        subject: header(msg, 'subject'),
        fromAddress: fromMatch?.[2]?.trim() ?? null,
        fromName: fromMatch?.[1]?.trim() ?? null,
        toAddresses: header(msg, 'to'),
        snippet: msg.snippet ?? null,
        bodyHtml: body.html,
        bodyText: body.text,
        isRead: !(msg.labelIds ?? []).includes('UNREAD'),
        isStarred: (msg.labelIds ?? []).includes('STARRED'),
        labels: msg.labelIds ?? [],
        receivedAt: msg.internalDate ? new Date(parseInt(msg.internalDate, 10)) : null,
      });
    } catch (err) {
      console.warn(`[emailSyncService] Failed to sync Gmail message ${id} in folder ${folder.displayName}:`, err);
    }
  }

  await repo.updateFolderSyncCursor(folder.id, new Date().toISOString());
  await repo.refreshFolderCounts(folder.id);
}

// ── Outlook ───────────────────────────────────────────────────────────────

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me';

type GraphFolder = { id: string; displayName: string; parentFolderId?: string; childFolderCount?: number };
type GraphFolderListResponse = { value?: GraphFolder[]; '@odata.nextLink'?: string };

type GraphMessage = {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string; name?: string } }>;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  isRead?: boolean;
  flag?: { flagStatus?: string };
  categories?: string[];
  receivedDateTime?: string;
};
type GraphListResponse = { value?: GraphMessage[]; '@odata.nextLink'?: string };

async function graphFetch<T>(token: string, path: string): Promise<T> {
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
  const resp = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Graph API ${path} → ${resp.status}`);
  return (await resp.json()) as T;
}

/** Graph doesn't tag well-known-ness in the generic folder list - matched by display name, a pragmatic heuristic, not guaranteed for a renamed folder. */
const OUTLOOK_WELL_KNOWN: Record<string, WellKnownFolderType> = {
  inbox: 'inbox', 'sent items': 'sent', drafts: 'drafts', 'junk email': 'spam', 'deleted items': 'trash', archive: 'archive',
};

async function discoverOutlookFoldersRecursive(token: string, parentPath: string, parentProviderFolderId: string | null): Promise<GraphFolder[]> {
  const all: GraphFolder[] = [];
  let nextUrl: string | undefined = `${parentPath}?$top=100`;
  while (nextUrl) {
    const page: GraphFolderListResponse = await graphFetch<GraphFolderListResponse>(token, nextUrl);
    for (const folder of page.value ?? []) {
      all.push(parentProviderFolderId ? { ...folder, parentFolderId: parentProviderFolderId } : folder);
      if ((folder.childFolderCount ?? 0) > 0) {
        all.push(...(await discoverOutlookFoldersRecursive(token, `/mailFolders/${folder.id}/childFolders`, folder.id)));
      }
    }
    nextUrl = page['@odata.nextLink'];
  }
  return all;
}

async function discoverOutlookFolders(repo: EmailOAuthRepository, accountId: string, businessId: string, token: string): Promise<EmailOAuthFolderRecord[]> {
  const graphFolders = await discoverOutlookFoldersRecursive(token, '/mailFolders', null);
  const folders: EmailOAuthFolderRecord[] = [];
  for (const folder of graphFolders) {
    const wellKnownType = OUTLOOK_WELL_KNOWN[folder.displayName.toLowerCase()] ?? 'other';
    folders.push(
      await repo.upsertFolder(accountId, businessId, {
        providerFolderId: folder.id,
        displayName: folder.displayName,
        wellKnownType,
        parentProviderFolderId: folder.parentFolderId ?? null,
      }),
    );
  }
  return folders;
}

async function syncOutlookFolder(repo: EmailOAuthRepository, accountId: string, businessId: string, token: string, folder: EmailOAuthFolderRecord): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let nextUrl: string | undefined =
    folder.syncCursor ??
    `${GRAPH_BASE}/mailFolders/${folder.providerFolderId}/messages?$top=50&$select=id,conversationId,subject,from,toRecipients,bodyPreview,body,isRead,flag,categories,receivedDateTime&$filter=receivedDateTime ge ${thirtyDaysAgo}`;

  let syncedCount = 0;
  do {
    const list: GraphListResponse = await graphFetch<GraphListResponse>(token, nextUrl);
    for (const msg of list.value ?? []) {
      try {
        const from = msg.from?.emailAddress;
        const toList = (msg.toRecipients ?? [])
          .map((r) => r.emailAddress?.address)
          .filter(Boolean)
          .join(', ');
        const isHtml = msg.body?.contentType?.toLowerCase() === 'html';

        await repo.upsertMessage(accountId, businessId, {
          providerMessageId: msg.id,
          providerThreadId: msg.conversationId ?? null,
          folderId: folder.id,
          subject: msg.subject ?? null,
          fromAddress: from?.address ?? null,
          fromName: from?.name ?? null,
          toAddresses: toList || null,
          snippet: msg.bodyPreview ?? null,
          bodyHtml: isHtml ? (msg.body?.content ?? null) : null,
          bodyText: !isHtml ? (msg.body?.content ?? null) : null,
          isRead: msg.isRead ?? false,
          isStarred: msg.flag?.flagStatus === 'flagged',
          labels: msg.categories ?? [],
          receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null,
        });
        syncedCount += 1;
      } catch (err) {
        console.warn(`[emailSyncService] Failed to sync Outlook message ${msg.id} in folder ${folder.displayName}:`, err);
      }
    }
    nextUrl = list['@odata.nextLink'];
  } while (nextUrl && syncedCount < MAX_MESSAGES_PER_FOLDER_PER_RUN);

  await repo.updateFolderSyncCursor(folder.id, nextUrl ?? null);
  await repo.refreshFolderCounts(folder.id);
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Discovers this account's real folders/labels from the provider, without syncing any messages yet. */
export async function discoverFolders(accountId: string, businessId: string): Promise<EmailOAuthFolderRecord[]> {
  const repo = new EmailOAuthRepository(queryAsTenant(businessId));
  const account = await repo.getByIdForBusiness(accountId, businessId);
  if (!account) return [];
  const token = await getValidAccessToken(accountId, businessId, account.provider);
  if (!token) return [];
  return account.provider === 'gmail' ? discoverGmailFolders(repo, accountId, businessId, token) : discoverOutlookFolders(repo, accountId, businessId, token);
}

/** Discovers folders, then syncs every one of them - the real work behind both the manual "Sync" button and the scheduled sweep below. */
export async function syncAccount(accountId: string, businessId: string): Promise<void> {
  const repo = new EmailOAuthRepository(queryAsTenant(businessId));
  const account = await repo.getByIdForBusiness(accountId, businessId);
  if (!account) return;

  const token = await getValidAccessToken(accountId, businessId, account.provider);
  if (!token) { console.warn(`[emailSyncService] No valid token for account ${accountId}`); return; }

  const folders = account.provider === 'gmail' ? await discoverGmailFolders(repo, accountId, businessId, token) : await discoverOutlookFolders(repo, accountId, businessId, token);

  for (const folder of folders) {
    try {
      if (account.provider === 'gmail') await syncGmailFolder(repo, accountId, businessId, token, folder);
      else await syncOutlookFolder(repo, accountId, businessId, token, folder);
    } catch (err) {
      console.warn(`[emailSyncService] Failed to sync folder ${folder.displayName} (${folder.id}):`, err);
    }
  }

  await repo.updateSyncCursor(accountId, new Date().toISOString());
}

export async function getFolders(accountId: string, businessId: string): Promise<EmailOAuthFolderRecord[]> {
  const repo = new EmailOAuthRepository(queryAsTenant(businessId));
  const account = await repo.getByIdForBusiness(accountId, businessId);
  if (!account) return [];
  return repo.listFolders(accountId);
}

export async function getFolderMessages(accountId: string, businessId: string, opts?: { limit?: number; unreadOnly?: boolean; folderId?: string }) {
  const repo = new EmailOAuthRepository(queryAsTenant(businessId));
  const account = await repo.getByIdForBusiness(accountId, businessId);
  if (!account) return [];
  return repo.listMessages(accountId, opts);
}

export async function getDistinctSenders(accountId: string, businessId: string, limit?: number) {
  const repo = new EmailOAuthRepository(queryAsTenant(businessId));
  const account = await repo.getByIdForBusiness(accountId, businessId);
  if (!account) return [];
  return repo.listDistinctSenders(accountId, limit);
}

export type DeleteOAuthMessageResult = { status: 'deleted' } | { status: 'not_found' } | { status: 'provider_error'; reason: string };

/**
 * Trashes the real message in the person's actual Gmail/Outlook mailbox
 * FIRST, and only removes AURA's own local copy once that succeeds - a
 * failed provider call must never leave this app quietly hiding a message
 * that's actually still sitting there, unread, in their real inbox. Uses
 * each provider's own trash/move-to-Deleted-Items action rather than a
 * permanent delete - reversible from within Gmail/Outlook itself,
 * matching this app's own "no unnecessarily destructive action" posture
 * elsewhere (WhatsApp number change, account deletion's own grace period).
 */
export async function deleteOAuthMessage(businessId: string, messageId: string): Promise<DeleteOAuthMessageResult> {
  const repo = new EmailOAuthRepository(queryAsTenant(businessId));
  const message = await repo.getMessageByIdForBusiness(messageId, businessId);
  if (!message) return { status: 'not_found' };

  const account = await repo.getByIdForBusiness(message.accountId, businessId);
  if (!account) return { status: 'not_found' };

  const token = await getValidAccessToken(message.accountId, businessId, account.provider);
  if (!token) return { status: 'provider_error', reason: 'No valid access token for this account - try reconnecting it.' };

  try {
    if (account.provider === 'gmail') {
      const resp = await fetch(`${GMAIL_BASE}/messages/${message.providerMessageId}/trash`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return { status: 'provider_error', reason: `Gmail API trash → ${resp.status}` };
    } else {
      const resp = await fetch(`${GRAPH_BASE}/messages/${message.providerMessageId}/move`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ destinationId: 'deleteditems' }),
      });
      if (!resp.ok) return { status: 'provider_error', reason: `Graph API move → ${resp.status}` };
    }
  } catch (error) {
    return { status: 'provider_error', reason: error instanceof Error ? error.message : 'Network error reaching the provider.' };
  }

  // Removes every local row for this real message, not just the one
  // clicked - see deleteMessagesByProviderMessage's own doc comment for why
  // more than one can legitimately exist (one real email labeled into more
  // than one synced folder).
  const affectedFolderIds = await repo.deleteMessagesByProviderMessage(message.accountId, businessId, message.providerMessageId);
  for (const folderId of affectedFolderIds) {
    await repo.refreshFolderCounts(folderId);
  }
  return { status: 'deleted' };
}

/**
 * The scheduled counterpart to the manual "Sync" button
 * (POST /api/email-oauth/sync/:accountId) - every other real external
 * sync in this app (WhatsApp, Writing Twin's retention sweep) already
 * runs on a schedule; this connected-inbox sync previously only ever
 * ran when a person clicked a button, so a mailbox nobody opened
 * Settings for could silently go stale indefinitely. One account's
 * failure (an expired refresh token, a provider outage) never stops the
 * sweep from reaching the rest.
 *
 * The one deliberately tenant-agnostic listing in this file (same
 * reasoning as writingTwinRepository.ts's own sweepExpiredRawEvents) -
 * a scheduled sweep genuinely needs every business's accounts at once,
 * so this is the sole caller allowed to construct EmailOAuthRepository
 * on the bare pool rather than a tenant-scoped one.
 */
export async function sweepEmailOAuthSync(): Promise<void> {
  const sweepRepo = new EmailOAuthRepository(pool);
  const accounts = await sweepRepo.listAllSyncEnabled();
  for (const account of accounts) {
    try {
      await syncAccount(account.id, account.businessId);
    } catch (err) {
      console.warn(`[emailSyncService] Scheduled sync failed for account ${account.id} (${account.provider}):`, err);
    }
  }
}
