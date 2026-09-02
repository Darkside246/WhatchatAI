import { Router } from 'express';
import { requireAuth, requireActiveSubscription, type AuthContext } from './authMiddleware.js';
import {
  initiateOAuth,
  handleOAuthCallback,
  listConnectedAccounts,
  disconnectAccount,
} from '../services/emailOAuthService.js';
import { syncAccount, getInboxMessages } from '../services/emailSyncService.js';
import type { OAuthProvider } from '../repositories/emailOAuthRepository.js';

const router = Router();

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
    res.redirect(`/?oauth_error=${msg}`);
    return;
  }

  const result = await handleOAuthCallback(provider, code, state);

  if (result.status === 'connected') {
    res.redirect(`/?oauth_success=${provider}&email=${encodeURIComponent(result.emailAddress)}`);
  } else {
    res.redirect(`/?oauth_error=${encodeURIComponent(result.reason)}`);
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

/** Get synced inbox messages for one account. */
router.get('/messages/:accountId', async (req, res) => {
  const limit = Math.min(parseInt(typeof req.query['limit'] === 'string' ? req.query['limit'] : '50', 10) || 50, 200);
  const unreadOnly = req.query['unread'] === 'true';
  const messages = await getInboxMessages(req.params['accountId']!, { limit, unreadOnly });
  res.json({ messages });
});

export { router as emailOAuthRouter };
