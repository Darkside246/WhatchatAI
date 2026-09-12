import { Router } from 'express';
import { requireAuth, requireActiveSubscription, type AuthContext } from './authMiddleware.js';
import {
  initiateOAuth,
  handleOAuthCallback,
  listConnectedAccounts,
  disconnectAccount,
} from '../services/emailOAuthService.js';
import {
  syncAccount,
  getFolders,
  getFolderMessages,
  deleteOAuthMessage,
  getOAuthMessageForBusiness,
} from '../services/emailSyncService.js';
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

/**
 * Serves one email's HTML body as its own document, with its own
 * Content-Security-Policy.
 *
 * WHY THIS ROUTE EXISTS AT ALL. The viewer rendered the body with srcDoc,
 * and a srcdoc iframe inherits the embedding page's CSP. This app's CSP has
 * `img-src 'self' blob: data:` - correct for the app, and it silently broke
 * every remote image in every email, which is what the broken-image boxes
 * in a marketing email were. A document loaded from a real URL gets the CSP
 * of ITS OWN response instead, so the email can be given a policy that
 * suits an email without loosening the app's.
 *
 * WHY IMAGES ARE STILL OFF BY DEFAULT. The obvious fix - adding https: to
 * the app's img-src - would have worked and been wrong. A remote image in
 * an email is routinely a tracking pixel: fetching it tells the sender the
 * message was opened, when, how often, and from which IP address. Loading
 * them automatically would turn every operator's inbox into a read-receipt
 * feed for every marketer who mails them, silently. Every serious email
 * client blocks remote images until asked, and so does this: ?images=1 is
 * that request, made per message, by the person reading it.
 *
 * The policy is otherwise as closed as it can be. No scripts, no plugins,
 * no nested frames, no form submissions - an email body is arbitrary HTML
 * from a stranger, and the only thing it is allowed to do here is describe
 * how it looks.
 */
router.get('/messages/single/:id/body', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const message = await getOAuthMessageForBusiness(req.params['id']!, auth.businessId);
  if (!message) return res.status(404).type('text/plain').send('Not found');

  const showImages = req.query['images'] === '1';
  const imgSrc = showImages ? "img-src https: data:" : "img-src 'none'";

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      imgSrc,
      "font-src 'none'",
      "script-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ].join('; '),
  );
  // Belt and braces against a body that tries to be treated as anything
  // other than the HTML it claims to be.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Never cached: the same URL returns different content depending on
  // ?images, and it is one person's private mail.
  res.setHeader('Cache-Control', 'no-store');

  return res.type('text/html').send(message.bodyHtml ?? '');
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
