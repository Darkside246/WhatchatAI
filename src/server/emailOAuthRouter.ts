import { Router } from 'express';
import { requireAuth, requireActiveSubscription, type AuthContext } from './authMiddleware.js';
import {
  initiateOAuth,
  handleOAuthCallback,
  listConnectedAccounts,
  disconnectAccount,
} from '../services/emailOAuthService.js';
import { syncAccount, getFolders, getFolderMessages, deleteOAuthMessage } from '../services/emailSyncService.js';
import type { OAuthProvider } from '../repositories/emailOAuthRepository.js';

const router = Router();

/**
 * A provider's OAuth redirect always lands the real browser back on
 * whatever origin actually served the page that started the flow. In
 * production that's this same API server (it also serves the built
 * frontend from the same origin, so a relative "/" redirect is correct).
 * In dev, the frontend is Vite's own separate origin (port 5173) - a bare
 * "/" redirect here instead lands on THIS server's port 3000, which falls
 * through to its own static-fallback serving of dist/web/index.html if
 * that directory happens to exist (a stale build from any prior `npm run
 * build`), showing a frozen, potentially very outdated snapshot of the
 * app instead of the live dev frontend. Real bug, found via a user report
 * of "signing in redirects me to the old app."
 */
function frontendOrigin(): string {
  return (process.env.NODE_ENV ?? 'development') === 'production' ? '' : 'http://localhost:5173';
}

// All routes require authentication except the OAuth callback (it carries state).
router.use('/accounts', requireAuth);
router.use('/sync', requireAuth);
router.use('/messages', requireAuth);

/** List connected OAuth email accounts for the authenticated business. */
router.get('/accounts', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const accounts = await listConnectedAccounts(auth.businessId);
  res.json({ accounts: accounts.map(({ id, provider, emailAddress, displayName, lastSyncedAt, syncEnabled }) => ({
    id, provider, emailAddress, displayName, lastSyncedAt, syncEnabled,
  })) });
});

/** Begin OAuth flow — redirects the browser to the provider's consent screen. */
router.get('/connect/:provider', requireAuth, requireActiveSubscription, (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const provider = req.params['provider'] as OAuthProvider;
  if (provider !== 'gmail' && provider !== 'outlook') {
    res.status(400).json({ error: 'Unknown provider. Supported: gmail, outlook.' });
    return;
  }

  const result = initiateOAuth(auth.businessId, provider);
  if (result.status === 'not_configured') {
    res.status(503).json({ error: result.reason });
    return;
  }
  res.redirect(result.redirectUrl);
});

/** OAuth callback — called by the provider after user grants access. */
router.get('/callback/:provider', async (req, res) => {
  const provider = req.params['provider'] as OAuthProvider;
  const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
  const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
  const error = typeof req.query['error'] === 'string' ? req.query['error'] : '';

  if (error || !code) {
    const msg = encodeURIComponent(error || 'Authorization was denied or cancelled.');
    res.redirect(`${frontendOrigin()}/?oauth_error=${msg}`);
    return;
  }

  const result = await handleOAuthCallback(provider, code, state);

  if (result.status === 'connected') {
    res.redirect(`${frontendOrigin()}/?oauth_success=${provider}&email=${encodeURIComponent(result.emailAddress)}`);
  } else {
    res.redirect(`${frontendOrigin()}/?oauth_error=${encodeURIComponent(result.reason)}`);
  }
});

/** Disconnect a linked email account. */
router.delete('/accounts/:id', requireAuth, async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const removed = await disconnectAccount(String(req.params['id'] ?? ''), auth.businessId);
  res.json({ ok: removed });
});

/** Trigger a manual sync for one account. */
router.post('/sync/:accountId', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  try {
    await syncAccount(req.params['accountId']!, auth.businessId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Sync failed.' });
  }
});

/** List this account's real, provider-discovered folders (Inbox/Sent/Spam/Trash/custom labels, etc). */
router.get('/accounts/:accountId/folders', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const folders = await getFolders(req.params['accountId']!, auth.businessId);
  res.json({ folders });
});

/** Get synced messages for one account, optionally scoped to a real folder. */
router.get('/messages/:accountId', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const limit = Math.min(parseInt(typeof req.query['limit'] === 'string' ? req.query['limit'] : '50', 10) || 50, 200);
  const unreadOnly = req.query['unread'] === 'true';
  const folderId = typeof req.query['folderId'] === 'string' ? req.query['folderId'] : undefined;
  const messages = await getFolderMessages(req.params['accountId']!, auth.businessId, { limit, unreadOnly, ...(folderId ? { folderId } : {}) });
  res.json({ messages });
});

/** Trashes the real message in the person's actual mailbox (Gmail trash / Outlook Deleted Items - reversible, never a permanent delete), then removes AURA's own local copy. */
router.delete('/messages/single/:id', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const result = await deleteOAuthMessage(auth.businessId, req.params['id']!);
  if (result.status === 'not_found') {
    return res
      .status(404)
      .json({ error: 'MESSAGE_NOT_FOUND', message: 'This email could not be found — it may already have been deleted or moved.' });
  }
  if (result.status === 'provider_error') return res.status(502).json({ error: 'PROVIDER_ERROR', message: result.reason });
  return res.status(200).json({ ok: true });
});

export { router as emailOAuthRouter };
