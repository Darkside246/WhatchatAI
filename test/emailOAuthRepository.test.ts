import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { EmailOAuthRepository } from '../src/repositories/emailOAuthRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Real regression coverage for the same class of live crash fixed in
 * userConsentRepository.ts: mapAccount()/mapMessage() used to call
 * .toISOString() on values the pool's global TIMESTAMPTZ type parser
 * (src/db/pool.ts) already converts to plain ISO strings.
 */
describe('EmailOAuthRepository (real Postgres) - the real timestamp-parsing crash', () => {
  it('upserts a real account without throwing, and returns real ISO date strings', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new EmailOAuthRepository(pool);

    const account = await repo.upsertAccount({
      businessId,
      provider: 'gmail',
      emailAddress: 'ops@example.com',
      accessToken: 'real-access-token',
      refreshToken: 'real-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      scopes: 'https://mail.google.com/',
    });

    expect(account.id).toBeTruthy();
    expect(typeof account.createdAt).toBe('string');
    expect(typeof account.updatedAt).toBe('string');
    expect(typeof account.tokenExpiresAt).toBe('string');
    expect(() => new Date(account.createdAt)).not.toThrow();
    expect(new Date(account.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('upserts a real account with no token expiry (null path) without throwing', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new EmailOAuthRepository(pool);

    const account = await repo.upsertAccount({
      businessId,
      provider: 'outlook',
      emailAddress: 'ops2@example.com',
      accessToken: 'real-access-token-2',
    });

    expect(account.tokenExpiresAt).toBeNull();
    expect(account.lastSyncedAt).toBeNull();
    expect(typeof account.createdAt).toBe('string');
  });
});

describe('EmailOAuthRepository - Email Redesign Phase A (real folder discovery + per-folder messages)', () => {
  it('getByIdForBusiness returns null for an account belonging to a different business (the cross-tenant read this fixes)', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness('Owner Business');
    const otherBusinessId = await createTestBusiness('Attacker Business');
    const repo = new EmailOAuthRepository(pool);
    const account = await repo.upsertAccount({ businessId, provider: 'gmail', emailAddress: 'real@example.com', accessToken: 'tok' });

    expect(await repo.getByIdForBusiness(account.id, businessId)).not.toBeNull();
    expect(await repo.getByIdForBusiness(account.id, otherBusinessId)).toBeNull();
  });

  it('upsertFolder is idempotent per (account, providerFolderId), updating display name in place', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new EmailOAuthRepository(pool);
    const account = await repo.upsertAccount({ businessId, provider: 'gmail', emailAddress: 'a@example.com', accessToken: 'tok' });

    const first = await repo.upsertFolder(account.id, businessId, { providerFolderId: 'INBOX', displayName: 'Inbox', wellKnownType: 'inbox' });
    const second = await repo.upsertFolder(account.id, businessId, { providerFolderId: 'INBOX', displayName: 'Inbox (renamed)', wellKnownType: 'inbox' });

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe('Inbox (renamed)');
    expect(await repo.listFolders(account.id)).toHaveLength(1);
  });

  it('the same provider message can exist in two different real folders as distinct rows (Gmail multi-label reality)', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new EmailOAuthRepository(pool);
    const account = await repo.upsertAccount({ businessId, provider: 'gmail', emailAddress: 'a@example.com', accessToken: 'tok' });
    const inbox = await repo.upsertFolder(account.id, businessId, { providerFolderId: 'INBOX', displayName: 'Inbox', wellKnownType: 'inbox' });
    const custom = await repo.upsertFolder(account.id, businessId, { providerFolderId: 'Label_1', displayName: 'Work', wellKnownType: 'other' });

    await repo.upsertMessage(account.id, businessId, { providerMessageId: 'msg-1', folderId: inbox.id, subject: 'Hello' });
    await repo.upsertMessage(account.id, businessId, { providerMessageId: 'msg-1', folderId: custom.id, subject: 'Hello' });

    expect(await repo.listMessages(account.id, { folderId: inbox.id })).toHaveLength(1);
    expect(await repo.listMessages(account.id, { folderId: custom.id })).toHaveLength(1);
    expect(await repo.listMessages(account.id)).toHaveLength(2);
  });

  it('re-upserting the same (account, folder, providerMessageId) updates read/starred state rather than duplicating', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new EmailOAuthRepository(pool);
    const account = await repo.upsertAccount({ businessId, provider: 'gmail', emailAddress: 'a@example.com', accessToken: 'tok' });
    const inbox = await repo.upsertFolder(account.id, businessId, { providerFolderId: 'INBOX', displayName: 'Inbox', wellKnownType: 'inbox' });

    await repo.upsertMessage(account.id, businessId, { providerMessageId: 'msg-1', folderId: inbox.id, subject: 'Hello', isRead: false });
    await repo.upsertMessage(account.id, businessId, { providerMessageId: 'msg-1', folderId: inbox.id, subject: 'Hello', isRead: true });

    const messages = await repo.listMessages(account.id, { folderId: inbox.id });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.isRead).toBe(true);
  });

  it('refreshFolderCounts reflects the real, current message counts, not an estimate', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new EmailOAuthRepository(pool);
    const account = await repo.upsertAccount({ businessId, provider: 'gmail', emailAddress: 'a@example.com', accessToken: 'tok' });
    const inbox = await repo.upsertFolder(account.id, businessId, { providerFolderId: 'INBOX', displayName: 'Inbox', wellKnownType: 'inbox' });

    await repo.upsertMessage(account.id, businessId, { providerMessageId: 'msg-1', folderId: inbox.id, isRead: false });
    await repo.upsertMessage(account.id, businessId, { providerMessageId: 'msg-2', folderId: inbox.id, isRead: true });
    await repo.refreshFolderCounts(inbox.id);

    const refreshed = await repo.getFolderById(inbox.id);
    expect(refreshed?.totalCount).toBe(2);
    expect(refreshed?.unreadCount).toBe(1);
  });

  it('listDistinctSenders returns real, deduped senders ordered by message count, never a fabricated address book', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new EmailOAuthRepository(pool);
    const account = await repo.upsertAccount({ businessId, provider: 'gmail', emailAddress: 'a@example.com', accessToken: 'tok' });
    const inbox = await repo.upsertFolder(account.id, businessId, { providerFolderId: 'INBOX', displayName: 'Inbox', wellKnownType: 'inbox' });

    await repo.upsertMessage(account.id, businessId, { providerMessageId: 'm1', folderId: inbox.id, fromAddress: 'frequent@example.com', fromName: 'Frequent Sender' });
    await repo.upsertMessage(account.id, businessId, { providerMessageId: 'm2', folderId: inbox.id, fromAddress: 'frequent@example.com', fromName: 'Frequent Sender' });
    await repo.upsertMessage(account.id, businessId, { providerMessageId: 'm3', folderId: inbox.id, fromAddress: 'rare@example.com', fromName: 'Rare Sender' });

    const senders = await repo.listDistinctSenders(account.id);
    expect(senders).toHaveLength(2);
    expect(senders[0]?.address).toBe('frequent@example.com');
  });
});

describe('emailSyncService - cross-tenant reads are refused end-to-end (the real bug found and fixed)', () => {
  it('getFolders/getFolderMessages/getDistinctSenders all return empty for a real account when called with a different business', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness('Owner Business');
    const businessB = await createTestBusiness('Attacker Business');
    const repo = new EmailOAuthRepository(pool);
    const account = await repo.upsertAccount({ businessId: businessA, provider: 'gmail', emailAddress: 'real@example.com', accessToken: 'tok' });
    const folder = await repo.upsertFolder(account.id, businessA, { providerFolderId: 'INBOX', displayName: 'Inbox', wellKnownType: 'inbox' });
    await repo.upsertMessage(account.id, businessA, { providerMessageId: 'msg-1', folderId: folder.id, subject: 'Private subject' });

    const { getFolders, getFolderMessages, getDistinctSenders } = await import('../src/services/emailSyncService.js');

    // The real account's own business sees everything.
    expect(await getFolders(account.id, businessA)).toHaveLength(1);
    expect(await getFolderMessages(account.id, businessA)).toHaveLength(1);

    // A different business passing the same real accountId gets nothing -
    // this is exactly the cross-tenant plaintext-email read that was found
    // and fixed (getByIdForBusiness + RLS), not just a coincidentally
    // empty result.
    expect(await getFolders(account.id, businessB)).toEqual([]);
    expect(await getFolderMessages(account.id, businessB)).toEqual([]);
    expect(await getDistinctSenders(account.id, businessB)).toEqual([]);
  });

  it('listAllSyncEnabled (the scheduled sweep\'s own listing) sees every business\'s sync-enabled accounts, and only those', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness('Business A');
    const businessB = await createTestBusiness('Business B');
    const repo = new EmailOAuthRepository(pool);
    await repo.upsertAccount({ businessId: businessA, provider: 'gmail', emailAddress: 'a@example.com', accessToken: 'tok' });
    const disabled = await repo.upsertAccount({ businessId: businessB, provider: 'outlook', emailAddress: 'b@example.com', accessToken: 'tok' });
    await pool.query(`UPDATE email_oauth_accounts SET sync_enabled = false WHERE id = $1`, [disabled.id]);

    const accounts = await repo.listAllSyncEnabled();
    expect(accounts.map((a) => a.emailAddress)).toEqual(['a@example.com']);
  });
});
