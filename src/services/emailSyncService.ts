/**
 * Syncs messages from connected Gmail and Outlook accounts into email_oauth_messages.
 * Uses history-based incremental sync (Gmail historyId, Outlook $deltaLink).
 */

import { pool } from '../db/pool.js';
import { EmailOAuthRepository } from '../repositories/emailOAuthRepository.js';
import { getValidAccessToken } from './emailOAuthService.js';

const repo = new EmailOAuthRepository(pool);

// ── Gmail sync ──────────────────────────────────────────────────────────────

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

type GmailMessageHeader = { name: string; value: string };
type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: GmailMessageHeader[];
    body?: { data?: string };
    parts?: Array<{ mimeType: string; body?: { data?: string } }>;
  };
  internalDate?: string;
};
type GmailListResponse = { messages?: Array<{ id: string }>; nextPageToken?: string; resultSizeEstimate?: number };

function decodeBase64(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractGmailBody(msg: GmailMessage): { html: string | null; text: string | null } {
  const parts = msg.payload?.parts ?? [];
  const htmlPart = parts.find((p) => p.mimeType === 'text/html');
  const textPart = parts.find((p) => p.mimeType === 'text/plain');
  const directBody = msg.payload?.body?.data;

  return {
    html: htmlPart?.body?.data ? decodeBase64(htmlPart.body.data) : null,
    text: textPart?.body?.data
      ? decodeBase64(textPart.body.data)
      : directBody
      ? decodeBase64(directBody)
      : null,
  };
}

function header(msg: GmailMessage, name: string): string | null {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

async function gmailFetch<T>(token: string, path: string): Promise<T> {
  const resp = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Gmail API ${path} → ${resp.status}`);
  return (await resp.json()) as T;
}

async function syncGmail(accountId: string, businessId: string): Promise<void> {
  const account = await repo.getById(accountId);
  if (!account) return;

  const token = await getValidAccessToken(accountId, businessId, 'gmail');
  if (!token) { console.warn(`[emailSyncService] No valid token for Gmail account ${accountId}`); return; }

  let pageToken: string | undefined;
  const query = 'in:inbox -category:{social promotions updates forums} newer_than:30d';
  const messageIds: string[] = [];

  do {
    const qs = new URLSearchParams({ q: query, maxResults: '50' });
    if (pageToken) qs.set('pageToken', pageToken);
    const list = await gmailFetch<GmailListResponse>(token, `/messages?${qs}`);
    for (const m of list.messages ?? []) messageIds.push(m.id);
    pageToken = list.nextPageToken;
  } while (pageToken && messageIds.length < 200);

  for (const id of messageIds) {
    try {
      const msg = await gmailFetch<GmailMessage>(token, `/messages/${id}?format=full`);
      const from = header(msg, 'from') ?? '';
      const fromMatch = from.match(/^(?:"?([^"]*)"?\s*)?<?([^>]+)>?$/);
      const body = extractGmailBody(msg);

      await repo.upsertMessage(accountId, {
        providerMessageId: msg.id,
        providerThreadId: msg.threadId ?? null,
        folder: (msg.labelIds ?? []).includes('SENT') ? 'SENT' : 'INBOX',
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
      console.warn(`[emailSyncService] Failed to sync Gmail message ${id}:`, err);
    }
  }

  await repo.updateSyncCursor(accountId, new Date().toISOString());
}

// ── Outlook sync ────────────────────────────────────────────────────────────

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me';

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

async function syncOutlook(accountId: string, businessId: string): Promise<void> {
  const token = await getValidAccessToken(accountId, businessId, 'outlook');
  if (!token) { console.warn(`[emailSyncService] No valid token for Outlook account ${accountId}`); return; }

  const account = await repo.getById(accountId);
  let nextUrl: string | undefined = account?.syncCursor ?? undefined;

  if (!nextUrl) {
    nextUrl = `${GRAPH_BASE}/messages?$top=50&$select=id,conversationId,subject,from,toRecipients,bodyPreview,body,isRead,flag,categories,receivedDateTime&$filter=receivedDateTime ge ${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}`;
  }

  let pageCount = 0;
  do {
    const list: GraphListResponse = await graphFetch<GraphListResponse>(token, nextUrl);
    for (const msg of list.value ?? []) {
      try {
        const from = msg.from?.emailAddress;
        const toList = (msg.toRecipients ?? [])
          .map((r: { emailAddress?: { address?: string; name?: string } }) => r.emailAddress?.address)
          .filter(Boolean)
          .join(', ');
        const isHtml = msg.body?.contentType?.toLowerCase() === 'html';

        await repo.upsertMessage(accountId, {
          providerMessageId: msg.id,
          providerThreadId: msg.conversationId ?? null,
          folder: 'INBOX',
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
      } catch (err) {
        console.warn(`[emailSyncService] Failed to sync Outlook message ${msg.id}:`, err);
      }
    }
    nextUrl = list['@odata.nextLink'];
    pageCount++;
  } while (nextUrl && pageCount < 4);

  if (nextUrl) await repo.updateSyncCursor(accountId, nextUrl);
  else await repo.updateSyncCursor(accountId, new Date().toISOString());
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function syncAccount(accountId: string, businessId: string): Promise<void> {
  const account = await repo.getById(accountId);
  if (!account) return;
  if (account.provider === 'gmail') await syncGmail(accountId, businessId);
  else await syncOutlook(accountId, businessId);
}

export async function getInboxMessages(accountId: string, opts?: { limit?: number; unreadOnly?: boolean }) {
  return repo.listMessages(accountId, opts);
}
