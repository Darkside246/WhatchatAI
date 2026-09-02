import { Router } from 'express';
import { requireAuth, type AuthContext } from './authMiddleware.js';
import * as googleMeetingOAuthService from '../services/googleMeetingOAuthService.js';
import * as zoomMeetingOAuthService from '../services/zoomMeetingOAuthService.js';
import type { MeetingProvider } from '../services/meeting/meetingProvider.js';

const router = Router();

function isMeetingProvider(value: string): value is MeetingProvider {
  return value === 'google_meet' || value === 'zoom';
}

// All routes require authentication except the OAuth callback (it carries state).
router.use('/connection', requireAuth);

/** The one connection for this business+provider, or null. */
router.get('/connection/:provider', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const provider = typeof req.params['provider'] === 'string' ? req.params['provider'] : '';
  if (!isMeetingProvider(provider)) {
    res.status(400).json({ error: 'Unknown provider. Supported: google_meet, zoom.' });
    return;
  }

  const connection =
    provider === 'google_meet'
      ? await googleMeetingOAuthService.getConnection(auth.businessId)
      : await zoomMeetingOAuthService.getConnection(auth.businessId);

  res.json({
    connection: connection
      ? {
          id: connection.id,
          email: provider === 'google_meet' ? (connection as { googleEmail: string }).googleEmail : (connection as { zoomEmail: string }).zoomEmail,
          displayName: connection.displayName,
          createdAt: connection.createdAt,
        }
      : null,
  });
});

/** Begin OAuth flow — redirects the browser to the provider's consent screen. */
router.get('/connect/:provider', requireAuth, (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const provider = typeof req.params['provider'] === 'string' ? req.params['provider'] : '';
  if (!isMeetingProvider(provider)) {
    res.status(400).json({ error: 'Unknown provider. Supported: google_meet, zoom.' });
    return;
  }

  const result =
    provider === 'google_meet'
      ? googleMeetingOAuthService.initiateOAuth(auth.businessId, auth.userId)
      : zoomMeetingOAuthService.initiateOAuth(auth.businessId, auth.userId);

  if (result.status === 'not_configured') {
    res.status(503).json({ error: result.reason });
    return;
  }
  res.redirect(result.redirectUrl);
});

/** OAuth callback — called by the provider after the user grants (or denies) access. */
router.get('/callback/:provider', async (req, res) => {
  const provider = typeof req.params['provider'] === 'string' ? req.params['provider'] : '';
  const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
  const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
  const error = typeof req.query['error'] === 'string' ? req.query['error'] : '';

  if (!isMeetingProvider(provider)) {
    res.redirect(`/?meeting_oauth_error=${encodeURIComponent('Unknown provider.')}`);
    return;
  }

  if (error || !code) {
    const msg = encodeURIComponent(error || 'Authorization was denied or cancelled.');
    res.redirect(`/?meeting_oauth_error=${msg}`);
    return;
  }

  const result =
    provider === 'google_meet'
      ? await googleMeetingOAuthService.handleOAuthCallback(code, state)
      : await zoomMeetingOAuthService.handleOAuthCallback(code, state);

  if (result.status === 'connected') {
    const email = 'googleEmail' in result ? result.googleEmail : result.zoomEmail;
    res.redirect(`/?meeting_oauth_success=${provider}&email=${encodeURIComponent(email)}`);
  } else {
    res.redirect(`/?meeting_oauth_error=${encodeURIComponent(result.reason)}`);
  }
});

/** Disconnect a linked meeting-provider connection. */
router.delete('/connection/:provider', requireAuth, async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const provider = typeof req.params['provider'] === 'string' ? req.params['provider'] : '';
  if (!isMeetingProvider(provider)) {
    res.status(400).json({ error: 'Unknown provider. Supported: google_meet, zoom.' });
    return;
  }

  const removed =
    provider === 'google_meet'
      ? await googleMeetingOAuthService.disconnectConnection(auth.businessId)
      : await zoomMeetingOAuthService.disconnectConnection(auth.businessId);
  res.json({ ok: removed });
});

export { router as meetingOAuthRouter };
