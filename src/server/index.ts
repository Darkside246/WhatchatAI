import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import path from 'node:path';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from '../realtime/wsServer.js';
import { publishRealtimeEvent } from '../realtime/pubsub.js';
import { whatsappConnectionService } from '../services/whatsappConnectionService.js';
import { whatsappMessageIngestionService } from '../services/whatsappMessageIngestionService.js';
import * as gooseService from '../services/gooseService.js';
import { globalSearch } from '../services/globalSearchService.js';
import { isInlineSafeMime } from '../domain/whatsapp/mediaCompatibility.js';
import { suggestReplies } from '../services/replySuggestionService.js';
import { routeInboundMessage } from '../services/agentRoutingService.js';
import {
  workspaceService,
  isChatNotFoundError,
  isEntitlementDeniedError,
  isCrmContactNotFoundError,
  isLeadNotFoundError,
} from '../services/workspaceService.js';
import { whatsappOutboundMessageService, isChatNotFoundError as isOutboundChatNotFoundError } from '../services/whatsappOutboundMessageService.js';
import { WhatsAppOutboundMessageRepository } from '../repositories/whatsappOutboundMessageRepository.js';
import { checkDatabaseHealth, pool } from '../db/pool.js';
import { ensureDefaultBusinessProvisioned } from '../services/businessBootstrapService.js';
import { syncContactProfilePicture } from '../services/profilePictureSyncService.js';
import { WhatsAppMediaRepository } from '../repositories/whatsappMediaRepository.js';
import { retrieveMedia } from '../media/localEncryptedMediaStorage.js';
import {
  getLockStatus,
  getUnlockChallenge,
  setupLock,
  attemptUnlock,
  InvalidArgon2ParamsError,
  LockAlreadyConfiguredError,
  LockNotConfiguredError,
} from '../services/securityLockService.js';
import { listHumanTakeoverAlerts } from '../services/securityAlertService.js';
import {
  listNotifications,
  markNotificationRead,
  markNotificationDismissed,
  markAllNotificationsRead,
  isNotificationNotFoundError,
} from '../services/notificationService.js';
import {
  createTeam,
  listTeams,
  updateTeam,
  deleteTeam,
  addTeamMember,
  removeTeamMember,
  getMyCapacity,
  updateMyCapacity,
  listCapacity,
  isTeamNotFoundError,
  isDuplicateTeamNameError,
  isUserNotBusinessMemberError,
} from '../services/teamService.js';
import { isCapacityExceededError, isInvalidAssignmentError } from '../services/workspaceService.js';
import {
  createCampaign,
  listCampaigns,
  getCampaign,
  updateDraftCampaign,
  submitCampaignForReview,
  approveCampaign,
  sendCampaign,
  cancelCampaign,
  listEligibleCampaignRecipients,
  isCampaignNotFoundError,
  isInvalidCampaignStatusError,
  isNoEligibleRecipientsError,
  isTooManyRecipientsError,
} from '../services/campaignService.js';
import {
  isRegistrationOpen,
  register,
  login,
  logout,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  isEmailAlreadyRegisteredError,
  isRegistrationClosedError,
  isInvalidCredentialsError,
  isRateLimitedError,
  isWeakPasswordError,
  isSessionNotFoundError,
} from '../services/authService.js';
import {
  listMembers,
  createMember,
  updateMemberRole,
  removeMember,
  isEmailAlreadyRegisteredError as isMemberEmailAlreadyRegisteredError,
  isMembershipNotFoundError,
  isCannotModifyOwnerError,
} from '../services/workspaceMemberService.js';
import { requireAuth, requirePermission, setSessionCookie, clearSessionCookie, readSessionToken, type AuthContext } from './authMiddleware.js';
import { BUSINESS_ROLES, isBusinessRole } from '../domain/auth/permissions.js';
// Runs the real outbound-send BullMQ worker in this process, not the
// separate incomingMessagesWorker.ts process - the live Baileys socket
// only exists here, wherever whatsappConnectionService.connect() actually
// runs. Importing this starts it as a side effect (see the file itself).
import { outboundMessagesWorker } from '../queue/workers/outboundDispatchWorker.js';
// Same reasoning as outboundMessagesWorker above - real status@broadcast
// publishing needs the live socket that only exists in this process.
import { scheduledStatusPublishWorker } from '../queue/workers/scheduledStatusPublishWorker.js';
// Same process affinity as the workers above: revoking a message needs the
// live Baileys socket, which only exists in whichever process connected.
import { messageRevocationWorker } from '../queue/workers/messageRevocationWorker.js';
import { emailSendWorker } from '../queue/workers/emailSendWorker.js';
// Same reasoning - a WAIT-node resume may itself send a real WhatsApp message.
import { funnelAdvanceWorker } from '../queue/workers/funnelAdvanceWorker.js';
import {
  createFunnel,
  listFunnels,
  getFunnel,
  updateFunnelMeta,
  deleteFunnel,
  setFunnelActive,
  replaceFunnelSteps,
  enrollContact,
  cancelFunnelInstance,
  isFunnelNotFoundError,
  isInvalidFunnelStepError,
  isFunnelInstanceNotFoundError,
  isAlreadyEnrolledError,
} from '../services/funnelService.js';
import { suggestMarketingCopy } from '../services/marketingAiService.js';
import {
  createScheduledStatus,
  listScheduledStatuses,
  getScheduledStatus,
  scheduleStatus,
  cancelScheduledStatus,
  isScheduledStatusNotFoundError,
  isInvalidScheduledStatusError,
} from '../services/scheduledStatusService.js';
import { getAiEngineStatus } from '../services/aiEngineStatusService.js';
import {
  createDraft as createEmailDraft,
  listEmails,
  getEmail,
  updateDraft as updateEmailDraft,
  approveAndSend as approveAndSendEmail,
  cancelEmail,
  getEmailCapabilities,
  getSettings as getEmailSettings,
  updateSettings as updateEmailSettings,
  draftWithAi as draftEmailWithAi,
  isEmailNotFoundError,
  isInvalidEmailError,
  isEmailNotApprovableError,
} from '../services/emailService.js';
import { EMAIL_KINDS } from '../repositories/emailMessageRepository.js';
import {
  revokeMessage,
  recallCampaign,
  revokeScheduledStatus,
  isRevocationNotFoundError,
  isNotRevocableError,
} from '../services/messageRevocationService.js';
import type { Request, Response, NextFunction } from 'express';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.disable('x-powered-by');

/**
 * Real security headers on every response. The CSP is deliberately strict:
 * this app serves its own bundled JS/CSS and never loads third-party
 * scripts, so 'self' is the whole allowlist. connectSrc keeps ws:/wss: for
 * the real-time bridge; imgSrc keeps blob:/data: for locally-previewed
 * outbound attachments before they upload.
 *
 * crossOriginEmbedderPolicy is left off: it would break the media endpoint's
 * range requests without adding anything here.
 */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Vite injects styles inline at runtime; unsafe-inline is required
        // for style only, never for script.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

/**
 * A real global ceiling on API traffic per IP. Deliberately generous - this
 * is an abuse/runaway brake, not a product limit. Auth has its own, much
 * tighter, per-account brute-force lockout in authService.
 */
app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: 'Too many requests. Slow down and try again shortly.' },
  }),
);

/**
 * A much tighter brake on the endpoints where a single request costs real
 * money or sends something irreversible to a real person (Gemini calls,
 * WhatsApp sends). Layered on top of the global limiter above.
 */
const expensiveActionLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many requests for this action. Try again shortly.' },
});
app.use('/api/workspace/marketing/ai-suggest', expensiveActionLimiter);
app.use('/api/workspace/campaigns', expensiveActionLimiter);

// 20mb (not the old 2mb) to fit base64-encoded outbound media uploads -
// this is one global parser, so every route's real ceiling moved with it.
app.use(express.json({ limit: '20mb' }));

app.get('/api/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'whatchatai',
    environment: process.env.NODE_ENV ?? 'development',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health/ai', (_req, res) => {
  const configured = Boolean(process.env.GEMINI_API_KEY);
  res.status(configured ? 200 : 503).json({
    status: configured ? 'configured' : 'not_configured',
    provider: 'google-gemini',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
    apiKeyConfigured: configured,
  });
});

app.get('/api/health/goose', async (_req, res) => {
  const capabilities = gooseService.getCapabilities();
  if (!capabilities.configured) {
    res.status(200).json({ status: 'not_configured', reason: 'GOOSE_SERVICE_URL is not configured' });
    return;
  }
  const health = await gooseService.healthCheck();
  res.status(health.status === 'available' ? 200 : 503).json(health);
});

app.get('/api/health/database', async (_req, res) => {
  const health = await checkDatabaseHealth();
  res.status(health.available ? 200 : 503).json({
    status: health.available ? 'CONNECTED' : 'DATABASE_UNAVAILABLE',
    ...health,
  });
});

app.get('/api/health/whatsapp', (_req, res) => {
  const snapshot = whatsappConnectionService.getSnapshot();
  res.status(snapshot.connected ? 200 : 503).json(snapshot);
});

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function deviceContextFrom(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

app.get('/api/auth/bootstrap-status', async (_req, res) => {
  const registrationOpen = await isRegistrationOpen();
  return res.status(200).json({ registrationOpen });
});

const registerSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
  displayName: z.string().trim().min(1).max(200),
});

app.post('/api/auth/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REGISTER_PAYLOAD', details: parsed.error.flatten() });

  try {
    const result = await register(parsed.data, deviceContextFrom(req));
    setSessionCookie(req, res, result.token, SESSION_MAX_AGE_SECONDS);
    return res.status(201).json({ user: result.user, business: result.business, role: result.membership.role });
  } catch (error) {
    if (isRegistrationClosedError(error)) return res.status(403).json({ error: 'REGISTRATION_CLOSED', message: error.message });
    if (isEmailAlreadyRegisteredError(error)) return res.status(409).json({ error: 'EMAIL_ALREADY_REGISTERED', message: error.message });
    if (isWeakPasswordError(error)) return res.status(400).json({ error: 'WEAK_PASSWORD', message: error.message });
    throw error;
  }
});

const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1) });

app.post('/api/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_LOGIN_PAYLOAD' });

  try {
    const result = await login(parsed.data.email, parsed.data.password, deviceContextFrom(req));
    setSessionCookie(req, res, result.token, SESSION_MAX_AGE_SECONDS);
    return res.status(200).json({ user: result.user, business: result.business, role: result.membership.role });
  } catch (error) {
    if (isRateLimitedError(error)) return res.status(429).json({ error: 'RATE_LIMITED', message: error.message });
    if (isInvalidCredentialsError(error)) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: error.message });
    throw error;
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = readSessionToken(req);
  if (token) await logout(token);
  clearSessionCookie(req, res);
  return res.status(200).json({ status: 'logged_out' });
});

app.get('/api/auth/me', requireAuth, async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  const business = await ensureDefaultBusinessProvisioned();
  return res.status(200).json({ user: auth.user, business, role: auth.role });
});

app.get('/api/auth/sessions', requireAuth, async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  const sessions = await listSessions(auth.userId, auth.sessionId);
  return res.status(200).json({ sessions });
});

app.delete('/api/auth/sessions/:sessionId', requireAuth, async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  try {
    await revokeSession(auth.userId, String(req.params.sessionId ?? ''));
    return res.status(200).json({ status: 'revoked' });
  } catch (error) {
    if (isSessionNotFoundError(error)) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    throw error;
  }
});

app.post('/api/auth/sessions/revoke-others', requireAuth, async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  const revokedCount = await revokeOtherSessions(auth.userId, auth.sessionId);
  return res.status(200).json({ revokedCount });
});

const createMemberSchema = z.object({
  email: z.string().trim().email(),
  displayName: z.string().trim().min(1).max(200),
  role: z.enum(BUSINESS_ROLES.filter((role) => role !== 'OWNER') as [string, ...string[]]),
});

app.get('/api/workspace/members', requireAuth, async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  const members = await listMembers(auth.businessId);
  return res.status(200).json({ members });
});

app.post('/api/workspace/members', requireAuth, requirePermission('users.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = createMemberSchema.safeParse(req.body);
  if (!parsed.success || !isBusinessRole(parsed.data.role)) {
    return res.status(400).json({ error: 'INVALID_MEMBER', details: parsed.success ? undefined : parsed.error.flatten() });
  }
  try {
    const result = await createMember(auth.businessId, auth.userId, { email: parsed.data.email, displayName: parsed.data.displayName, role: parsed.data.role as Exclude<(typeof BUSINESS_ROLES)[number], 'OWNER'> });
    return res.status(201).json(result);
  } catch (error) {
    if (isMemberEmailAlreadyRegisteredError(error)) return res.status(409).json({ error: 'EMAIL_ALREADY_REGISTERED', message: error.message });
    throw error;
  }
});

const updateMemberRoleSchema = z.object({
  role: z.enum(BUSINESS_ROLES.filter((role) => role !== 'OWNER') as [string, ...string[]]),
});

app.patch('/api/workspace/members/:membershipId/role', requireAuth, requirePermission('users.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = updateMemberRoleSchema.safeParse(req.body);
  if (!parsed.success || !isBusinessRole(parsed.data.role)) return res.status(400).json({ error: 'INVALID_ROLE' });
  try {
    const member = await updateMemberRole(auth.businessId, String(req.params.membershipId ?? ''), parsed.data.role as Exclude<(typeof BUSINESS_ROLES)[number], 'OWNER'>);
    return res.status(200).json({ member });
  } catch (error) {
    if (isMembershipNotFoundError(error)) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
    if (isCannotModifyOwnerError(error)) return res.status(403).json({ error: 'CANNOT_MODIFY_OWNER', message: error.message });
    throw error;
  }
});

app.delete('/api/workspace/members/:membershipId', requireAuth, requirePermission('users.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  try {
    await removeMember(auth.businessId, String(req.params.membershipId ?? ''));
    return res.status(200).json({ status: 'removed' });
  } catch (error) {
    if (isMembershipNotFoundError(error)) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
    if (isCannotModifyOwnerError(error)) return res.status(403).json({ error: 'CANNOT_MODIFY_OWNER', message: error.message });
    throw error;
  }
});

const createTeamSchema = z.object({ name: z.string().trim().min(1).max(200), description: z.string().trim().max(2000).nullish() });

app.get('/api/workspace/teams', requireAuth, async (_req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  const teams = await listTeams(businessId);
  return res.status(200).json({ teams });
});

app.post('/api/workspace/teams', requireAuth, requirePermission('team.manage'), async (req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  const parsed = createTeamSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_TEAM', details: parsed.error.flatten() });
  try {
    const team = await createTeam(businessId, parsed.data.name, parsed.data.description ?? null);
    return res.status(201).json({ team });
  } catch (error) {
    if (isDuplicateTeamNameError(error)) return res.status(409).json({ error: 'DUPLICATE_TEAM_NAME', message: error.message });
    throw error;
  }
});

const updateTeamSchema = z.object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().trim().max(2000).nullish() });

app.patch('/api/workspace/teams/:teamId', requireAuth, requirePermission('team.manage'), async (req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  const parsed = updateTeamSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_TEAM' });
  try {
    const team = await updateTeam(businessId, String(req.params.teamId ?? ''), { name: parsed.data.name, description: parsed.data.description ?? null });
    return res.status(200).json({ team });
  } catch (error) {
    if (isTeamNotFoundError(error)) return res.status(404).json({ error: 'TEAM_NOT_FOUND' });
    if (isDuplicateTeamNameError(error)) return res.status(409).json({ error: 'DUPLICATE_TEAM_NAME', message: error.message });
    throw error;
  }
});

app.delete('/api/workspace/teams/:teamId', requireAuth, requirePermission('team.manage'), async (req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  try {
    await deleteTeam(businessId, String(req.params.teamId ?? ''));
    return res.status(200).json({ status: 'deleted' });
  } catch (error) {
    if (isTeamNotFoundError(error)) return res.status(404).json({ error: 'TEAM_NOT_FOUND' });
    throw error;
  }
});

const addTeamMemberSchema = z.object({ userId: z.string().uuid() });

app.post('/api/workspace/teams/:teamId/members', requireAuth, requirePermission('team.manage'), async (req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  const parsed = addTeamMemberSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_TEAM_MEMBER' });
  try {
    const members = await addTeamMember(businessId, String(req.params.teamId ?? ''), parsed.data.userId);
    return res.status(200).json({ members });
  } catch (error) {
    if (isTeamNotFoundError(error)) return res.status(404).json({ error: 'TEAM_NOT_FOUND' });
    if (isUserNotBusinessMemberError(error)) return res.status(400).json({ error: 'NOT_A_BUSINESS_MEMBER', message: error.message });
    throw error;
  }
});

app.delete('/api/workspace/teams/:teamId/members/:userId', requireAuth, requirePermission('team.manage'), async (req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  try {
    const members = await removeTeamMember(businessId, String(req.params.teamId ?? ''), String(req.params.userId ?? ''));
    return res.status(200).json({ members });
  } catch (error) {
    if (isTeamNotFoundError(error)) return res.status(404).json({ error: 'TEAM_NOT_FOUND' });
    throw error;
  }
});

app.get('/api/workspace/capacity', requireAuth, async (_req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  const capacity = await listCapacity(businessId);
  return res.status(200).json({ capacity });
});

app.get('/api/workspace/capacity/me', requireAuth, async (_req, res) => {
  const { businessId, userId } = res.locals.auth as AuthContext;
  const capacity = await getMyCapacity(businessId, userId);
  return res.status(200).json({ capacity });
});

const updateCapacitySchema = z.object({
  maxActiveConversations: z.number().int().min(1).max(1000).optional(),
  availability: z.enum(['available', 'busy', 'offline']).optional(),
});

app.patch('/api/workspace/capacity/me', requireAuth, async (req, res) => {
  const { businessId, userId } = res.locals.auth as AuthContext;
  const parsed = updateCapacitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_CAPACITY' });
  const capacity = await updateMyCapacity(businessId, userId, parsed.data);
  return res.status(200).json({ capacity });
});

// Every /api/whatsapp/* route below requires a real, valid session - see
// authMiddleware.ts. WhatsApp connection status/QR/phone number are
// business-sensitive, not public diagnostics (those live under
// /api/health/whatsapp instead, which stays open).
app.use('/api/whatsapp', requireAuth);

app.get('/api/whatsapp/status', (_req, res) => {
  res.status(200).json(whatsappConnectionService.getSnapshot());
});

app.get('/api/whatsapp/qr', (_req, res) => {
  const snapshot = whatsappConnectionService.getSnapshot();
  if (!snapshot.qrDataUrl) {
    return res.status(404).json({
      available: false,
      status: snapshot.status,
      message: 'No current WhatsApp QR code is available.',
    });
  }

  return res.status(200).json({
    available: true,
    status: snapshot.status,
    qrDataUrl: snapshot.qrDataUrl,
  });
});

app.post('/api/whatsapp/connect', async (_req, res) => {
  try {
    const snapshot = await whatsappConnectionService.connect();
    return res.status(202).json(snapshot);
  } catch (error) {
    return res.status(500).json({
      status: 'ERROR',
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/api/whatsapp/disconnect', async (_req, res) => {
  await whatsappConnectionService.disconnect();
  return res.status(200).json(whatsappConnectionService.getSnapshot());
});

app.post('/api/whatsapp/logout', async (_req, res) => {
  await whatsappConnectionService.logout();
  return res.status(200).json(whatsappConnectionService.getSnapshot());
});

app.get('/api/whatsapp/messages/recent', (req, res) => {
  const limitParam = Number(req.query.limit);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;

  return res.status(200).json({
    note: 'In-memory ingestion buffer used for fast inspection. Durable storage is the whatsapp_messages table (Phase 2C) - see /api/health/database for DB status.',
    messages: whatsappMessageIngestionService.getRecent(limit),
  });
});

app.get('/api/whatsapp/messages/stats', (_req, res) => {
  return res.status(200).json(whatsappMessageIngestionService.getStats());
});

function requireWorkspaceContext(_req: Request, res: Response, next: NextFunction): void {
  const context = whatsappConnectionService.getPersistedContext();
  if (!context) {
    res.status(409).json({
      error: 'WHATSAPP_NOT_CONNECTED',
      message: 'No WhatsApp account is connected and persisted yet.',
    });
    return;
  }
  // This process holds exactly one live Baileys socket, so it can only ever
  // serve the one business it's connected to. An authenticated session for
  // a different business (schema-valid, since a user can belong to more
  // than one business) is refused here rather than silently served against
  // the wrong tenant's WhatsApp account.
  const auth = res.locals.auth as AuthContext | undefined;
  if (auth && auth.businessId !== context.businessId) {
    res.status(403).json({ error: 'BUSINESS_MISMATCH', message: 'This session belongs to a different business than the one currently connected.' });
    return;
  }
  res.locals.workspaceContext = context;
  next();
}

// Every /api/workspace/* route below requires a real, valid session first -
// see authMiddleware.ts. Individual routes then layer requirePermission()
// where the action is sensitive enough to need more than "any authenticated
// member of this business."
app.use('/api/workspace', requireAuth);

/**
 * Which engine can actually answer a customer right now. Workspace-scoped
 * because it is operator-facing status, not a public liveness probe.
 */
app.get('/api/workspace/billing/plans', requireWorkspaceContext, async (_req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  return res.status(200).json(await workspaceService.getPlanCatalogue(businessId));
});

app.get('/api/workspace/ai-engines', requireWorkspaceContext, async (_req, res) => {
  return res.status(200).json(await getAiEngineStatus());
});


app.get('/api/workspace/sync-status', requireWorkspaceContext, async (_req, res) => {
  const { whatsappAccountId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const status = await workspaceService.getSyncStatus(whatsappAccountId);
  return res.status(200).json(status);
});

app.get('/api/workspace/chats', requireWorkspaceContext, async (_req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as {
    businessId: string;
    whatsappAccountId: string;
  };
  const chats = await workspaceService.listChats(businessId, whatsappAccountId);
  return res.status(200).json({ chats });
});

app.get('/api/workspace/chats/:chatId', requireWorkspaceContext, async (req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as {
    businessId: string;
    whatsappAccountId: string;
  };
  try {
    const detail = await workspaceService.getChatDetail(businessId, whatsappAccountId, String(req.params.chatId ?? ''));
    // A human is genuinely looking at this chat right now - the real
    // protocol trigger for WhatsApp to start pushing this contact's live
    // presence and status updates. Best-effort: never blocks or fails the
    // response over it.
    if (detail.chat.chatType === 'individual') {
      void whatsappConnectionService.subscribePresence(detail.chat.chatJid);
      if (detail.contact) {
        void syncContactProfilePicture(businessId, whatsappAccountId, detail.contact.id, detail.chat.chatJid);
      }
    }
    return res.status(200).json(detail);
  } catch (error) {
    if (isChatNotFoundError(error)) return res.status(404).json({ error: 'CHAT_NOT_FOUND' });
    throw error;
  }
});

app.get('/api/workspace/chats/:chatId/messages', requireWorkspaceContext, async (req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as {
    businessId: string;
    whatsappAccountId: string;
  };
  const limitParam = Number(req.query.limit);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;
  try {
    const messages = await workspaceService.listMessages(businessId, whatsappAccountId, String(req.params.chatId ?? ''), limit);
    return res.status(200).json({ messages });
  } catch (error) {
    if (isChatNotFoundError(error)) return res.status(404).json({ error: 'CHAT_NOT_FOUND' });
    throw error;
  }
});

const sendMessageSchema = z.discriminatedUnion('messageType', [
  z.object({
    messageType: z.literal('text'),
    text: z.string().min(1).max(10000),
    idempotencyKey: z.string().min(1).max(200).optional(),
  }),
  z.object({
    messageType: z.enum(['image', 'video', 'audio', 'document']),
    mediaBase64: z.string().min(1),
    mediaMimeType: z.string().min(1),
    mediaFileName: z.string().min(1).max(255).optional(),
    caption: z.string().max(4000).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  }),
]);

/**
 * The only route in this phase that can put a message on the wire, and it
 * only ever fires from an explicit, human-initiated API call - nothing in
 * the AI/automation layer (which doesn't exist yet) has a path here. See
 * whatsappOutboundMessageService for the real idempotency/retry contract.
 */
app.post('/api/workspace/chats/:chatId/messages', requireWorkspaceContext, requirePermission('whatsapp.send'), async (req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as {
    businessId: string;
    whatsappAccountId: string;
  };
  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_SEND_PAYLOAD', details: parsed.error.flatten() });
  }

  const input = parsed.data;
  try {
    const outboundMessage = await whatsappOutboundMessageService.send({
      businessId,
      whatsappAccountId,
      chatId: String(req.params.chatId ?? ''),
      ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
      messageType: input.messageType,
      ...(input.messageType === 'text'
        ? { text: input.text }
        : {
            mediaBase64: input.mediaBase64,
            mediaMimeType: input.mediaMimeType,
            ...(input.mediaFileName !== undefined && { mediaFileName: input.mediaFileName }),
            ...(input.caption !== undefined && { caption: input.caption }),
          }),
    });
    return res.status(202).json({ outboundMessage });
  } catch (error) {
    if (isOutboundChatNotFoundError(error)) return res.status(404).json({ error: 'CHAT_NOT_FOUND' });
    return res.status(400).json({
      error: 'SEND_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * The send endpoint above returns 202 the instant a send is queued, not
 * once it actually succeeds or fails - dispatch happens asynchronously in
 * outboundDispatchWorker.ts. Without this, a genuine failure (WhatsApp
 * disconnected, a rejected send) would be invisible in the UI: the
 * composer would clear and the message would just never appear, with no
 * error shown anywhere. The frontend polls this after sending so a real
 * failure surfaces instead of silently vanishing.
 */
app.get('/api/workspace/outbound-messages/:id', requireWorkspaceContext, async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const outboundMessage = await new WhatsAppOutboundMessageRepository(pool).findById(String(req.params.id ?? ''));
  if (!outboundMessage || outboundMessage.businessId !== businessId) {
    return res.status(404).json({ error: 'OUTBOUND_MESSAGE_NOT_FOUND' });
  }
  return res.status(200).json({
    id: outboundMessage.id,
    status: outboundMessage.status,
    lastError: outboundMessage.lastError,
  });
});

const aiModeSchema = z.object({ aiMode: z.enum(['AI_ACTIVE', 'AI_PAUSED', 'HUMAN_TAKEOVER']) });

app.patch('/api/workspace/chats/:chatId/ai-mode', requireWorkspaceContext, requirePermission('ai.activate'), async (req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as {
    businessId: string;
    whatsappAccountId: string;
  };
  const parsed = aiModeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_AI_MODE' });
  }
  try {
    const chat = await workspaceService.setAiMode(businessId, whatsappAccountId, String(req.params.chatId ?? ''), parsed.data.aiMode);
    return res.status(200).json({ chat });
  } catch (error) {
    if (isChatNotFoundError(error)) return res.status(404).json({ error: 'CHAT_NOT_FOUND' });
    throw error;
  }
});

const assignChatSchema = z.object({
  assigneeUserId: z.string().uuid().nullable(),
  assigneeTeamId: z.string().uuid().nullable(),
});

app.patch('/api/workspace/chats/:chatId/assignment', requireWorkspaceContext, requirePermission('whatsapp.manage'), async (req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = assignChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_ASSIGNMENT_PAYLOAD' });
  try {
    const chat = await workspaceService.assignChat(businessId, whatsappAccountId, String(req.params.chatId ?? ''), parsed.data);
    return res.status(200).json({ chat });
  } catch (error) {
    if (isChatNotFoundError(error)) return res.status(404).json({ error: 'CHAT_NOT_FOUND' });
    if (isInvalidAssignmentError(error)) return res.status(400).json({ error: 'INVALID_ASSIGNMENT', message: error.message });
    if (isCapacityExceededError(error)) {
      return res.status(409).json({ error: 'CAPACITY_EXCEEDED', message: error.message, limit: error.limit, current: error.current });
    }
    throw error;
  }
});

app.get('/api/workspace/campaigns/eligible-recipients', requireWorkspaceContext, async (_req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const recipients = await listEligibleCampaignRecipients(businessId, whatsappAccountId);
  return res.status(200).json({ recipients });
});

app.get('/api/workspace/campaigns', requireWorkspaceContext, async (_req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const campaigns = await listCampaigns(businessId);
  return res.status(200).json({ campaigns });
});

const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  messageText: z.string().trim().min(1).max(4000),
  crmContactIds: z.array(z.string().uuid()).min(1),
});

app.post('/api/workspace/campaigns', requireWorkspaceContext, requirePermission('marketing.create'), async (req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const auth = res.locals.auth as AuthContext;
  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_CAMPAIGN', details: parsed.error.flatten() });
  try {
    const result = await createCampaign(businessId, whatsappAccountId, auth.userId, parsed.data);
    return res.status(201).json(result);
  } catch (error) {
    if (isNoEligibleRecipientsError(error)) return res.status(400).json({ error: 'NO_ELIGIBLE_RECIPIENTS', message: error.message });
    if (isTooManyRecipientsError(error)) return res.status(400).json({ error: 'TOO_MANY_RECIPIENTS', message: error.message });
    if (isEntitlementDeniedError(error)) {
      const message =
        error.reason === 'NO_ACTIVE_SUBSCRIPTION'
          ? 'This business has no active subscription.'
          : error.reason === 'ENTITLEMENT_DISABLED'
            ? 'Campaigns are not enabled on this plan.'
            : `Active campaign limit reached for this plan (${error.current}/${error.limit}).`;
      return res
        .status(403)
        .json({ error: 'ENTITLEMENT_DENIED', reason: error.reason, limit: error.limit, current: error.current, message });
    }
    throw error;
  }
});

app.get('/api/workspace/campaigns/:campaignId', requireWorkspaceContext, async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  try {
    const detail = await getCampaign(businessId, String(req.params.campaignId ?? ''));
    return res.status(200).json(detail);
  } catch (error) {
    if (isCampaignNotFoundError(error)) return res.status(404).json({ error: 'CAMPAIGN_NOT_FOUND' });
    throw error;
  }
});

const updateCampaignSchema = z.object({ name: z.string().trim().min(1).max(200), messageText: z.string().trim().min(1).max(4000) });

app.patch('/api/workspace/campaigns/:campaignId', requireWorkspaceContext, requirePermission('marketing.create'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = updateCampaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_CAMPAIGN' });
  try {
    const campaign = await updateDraftCampaign(businessId, String(req.params.campaignId ?? ''), parsed.data);
    return res.status(200).json({ campaign });
  } catch (error) {
    if (isCampaignNotFoundError(error)) return res.status(404).json({ error: 'CAMPAIGN_NOT_FOUND' });
    if (isInvalidCampaignStatusError(error)) return res.status(409).json({ error: 'INVALID_CAMPAIGN_STATUS', message: error.message });
    throw error;
  }
});

function campaignActionHandler(action: (businessId: string, campaignId: string) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
    try {
      const campaign = await action(businessId, String(req.params.campaignId ?? ''));
      return res.status(200).json({ campaign });
    } catch (error) {
      if (isCampaignNotFoundError(error)) return res.status(404).json({ error: 'CAMPAIGN_NOT_FOUND' });
      if (isInvalidCampaignStatusError(error)) return res.status(409).json({ error: 'INVALID_CAMPAIGN_STATUS', message: error.message });
      if (isNoEligibleRecipientsError(error)) return res.status(400).json({ error: 'NO_ELIGIBLE_RECIPIENTS', message: error.message });
      throw error;
    }
  };
}

app.post(
  '/api/workspace/campaigns/:campaignId/submit-review',
  requireWorkspaceContext,
  requirePermission('marketing.create'),
  campaignActionHandler((businessId, campaignId) => submitCampaignForReview(businessId, campaignId)),
);

app.post('/api/workspace/campaigns/:campaignId/approve', requireWorkspaceContext, requirePermission('marketing.send'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const auth = res.locals.auth as AuthContext;
  try {
    const campaign = await approveCampaign(businessId, String(req.params.campaignId ?? ''), auth.userId);
    return res.status(200).json({ campaign });
  } catch (error) {
    if (isCampaignNotFoundError(error)) return res.status(404).json({ error: 'CAMPAIGN_NOT_FOUND' });
    if (isInvalidCampaignStatusError(error)) return res.status(409).json({ error: 'INVALID_CAMPAIGN_STATUS', message: error.message });
    throw error;
  }
});

app.post(
  '/api/workspace/campaigns/:campaignId/send',
  requireWorkspaceContext,
  requirePermission('marketing.send'),
  campaignActionHandler((businessId, campaignId) => sendCampaign(businessId, campaignId)),
);

app.post(
  '/api/workspace/campaigns/:campaignId/cancel',
  requireWorkspaceContext,
  requirePermission('marketing.create'),
  campaignActionHandler((businessId, campaignId) => cancelCampaign(businessId, campaignId)),
);

app.get('/api/workspace/scheduled-statuses', requireWorkspaceContext, async (_req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const statuses = await listScheduledStatuses(businessId);
  return res.status(200).json({ statuses });
});

const createScheduledStatusSchema = z.object({
  statusType: z.enum(['text', 'image', 'video']),
  textContent: z.string().trim().min(1).max(700).optional(),
  caption: z.string().trim().max(700).optional(),
  backgroundColor: z.string().trim().max(9).optional(),
  mediaBase64: z.string().min(1).optional(),
  mediaMimeType: z.string().min(1).optional(),
  scheduledAt: z.string().min(1),
});

app.post('/api/workspace/scheduled-statuses', requireWorkspaceContext, requirePermission('marketing.create'), async (req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const auth = res.locals.auth as AuthContext;
  const parsed = createScheduledStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_SCHEDULED_STATUS', details: parsed.error.flatten() });
  try {
    const status = await createScheduledStatus(businessId, whatsappAccountId, auth.userId, parsed.data);
    return res.status(201).json({ status });
  } catch (error) {
    if (isInvalidScheduledStatusError(error)) return res.status(400).json({ error: 'INVALID_SCHEDULED_STATUS', message: error.message });
    throw error;
  }
});

app.get('/api/workspace/scheduled-statuses/:id', requireWorkspaceContext, async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  try {
    const status = await getScheduledStatus(businessId, String(req.params.id ?? ''));
    return res.status(200).json({ status });
  } catch (error) {
    if (isScheduledStatusNotFoundError(error)) return res.status(404).json({ error: 'SCHEDULED_STATUS_NOT_FOUND' });
    throw error;
  }
});

function scheduledStatusActionHandler(action: (businessId: string, id: string) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
    try {
      const status = await action(businessId, String(req.params.id ?? ''));
      return res.status(200).json({ status });
    } catch (error) {
      if (isScheduledStatusNotFoundError(error)) return res.status(404).json({ error: 'SCHEDULED_STATUS_NOT_FOUND' });
      if (isInvalidScheduledStatusError(error)) return res.status(409).json({ error: 'INVALID_SCHEDULED_STATUS', message: error.message });
      throw error;
    }
  };
}

app.post(
  '/api/workspace/scheduled-statuses/:id/schedule',
  requireWorkspaceContext,
  requirePermission('marketing.schedule'),
  scheduledStatusActionHandler((businessId, id) => scheduleStatus(businessId, id)),
);

app.post(
  '/api/workspace/scheduled-statuses/:id/cancel',
  requireWorkspaceContext,
  requirePermission('marketing.create'),
  scheduledStatusActionHandler((businessId, id) => cancelScheduledStatus(businessId, id)),
);

/**
 * Delete-from-WhatsApp. These issue WhatsApp's real "delete for everyone",
 * the same action the phone offers. A 202 means the instruction was queued
 * and WhatsApp will be asked - it is deliberately not a claim that every
 * recipient device has already dropped the message.
 */
function revocationErrorResponse(error: unknown, res: Response): Response | null {
  if (isRevocationNotFoundError(error)) return res.status(404).json({ error: 'NOT_FOUND' });
  if (isNotRevocableError(error)) return res.status(409).json({ error: 'NOT_REVOCABLE', message: error.message });
  return null;
}

app.post(
  '/api/workspace/messages/:messageId/revoke',
  requireWorkspaceContext,
  requirePermission('whatsapp.send'),
  async (req, res) => {
    const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
    const auth = res.locals.auth as AuthContext;
    try {
      await revokeMessage(businessId, String(req.params.messageId ?? ''), auth.userId);
      return res.status(202).json({ status: 'requested' });
    } catch (error) {
      const handled = revocationErrorResponse(error, res);
      if (handled) return handled;
      throw error;
    }
  },
);

app.post(
  '/api/workspace/campaigns/:campaignId/recall',
  requireWorkspaceContext,
  requirePermission('marketing.send'),
  async (req, res) => {
    const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
    const auth = res.locals.auth as AuthContext;
    try {
      const outcome = await recallCampaign(businessId, String(req.params.campaignId ?? ''), auth.userId);
      return res.status(202).json(outcome);
    } catch (error) {
      const handled = revocationErrorResponse(error, res);
      if (handled) return handled;
      throw error;
    }
  },
);

app.post(
  '/api/workspace/scheduled-statuses/:id/revoke',
  requireWorkspaceContext,
  requirePermission('marketing.send'),
  async (req, res) => {
    const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
    const auth = res.locals.auth as AuthContext;
    try {
      await revokeScheduledStatus(businessId, String(req.params.id ?? ''), auth.userId);
      return res.status(202).json({ status: 'requested' });
    } catch (error) {
      const handled = revocationErrorResponse(error, res);
      if (handled) return handled;
      throw error;
    }
  },
);

/**
 * Email. Every route here sits AFTER the `app.use('/api/workspace',
 * requireAuth)` mount above - see test/aiEngineStatus.test.ts, which fails
 * if one is ever added before it.
 *
 * The approval boundary is deliberate: drafting needs 'email.draft',
 * releasing to a real customer needs 'email.send'. An AGENT role holds the
 * former and not the latter.
 */
function emailErrorResponse(error: unknown, res: Response): Response | null {
  if (isEmailNotFoundError(error)) return res.status(404).json({ error: 'EMAIL_NOT_FOUND' });
  if (isInvalidEmailError(error)) return res.status(400).json({ error: 'INVALID_EMAIL', message: error.message });
  if (isEmailNotApprovableError(error)) return res.status(409).json({ error: 'EMAIL_NOT_APPROVABLE', message: error.message });
  return null;
}

app.get('/api/workspace/email/capabilities', requirePermission('email.view'), async (_req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  return res.status(200).json(await getEmailCapabilities(businessId));
});

app.get('/api/workspace/email/settings', requirePermission('email.view'), async (_req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  return res.status(200).json({ settings: await getEmailSettings(businessId) });
});

const emailSettingsSchema = z.object({
  fromEmail: z.string().trim().min(3).max(320),
  fromName: z.string().trim().max(200).nullish(),
  replyToEmail: z.string().trim().max(320).nullish(),
});

app.put('/api/workspace/email/settings', requirePermission('settings.manage'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = emailSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_EMAIL_SETTINGS', details: parsed.error.flatten() });
  try {
    const settings = await updateEmailSettings(auth.businessId, auth.userId, parsed.data);
    return res.status(200).json({ settings });
  } catch (error) {
    const handled = emailErrorResponse(error, res);
    if (handled) return handled;
    throw error;
  }
});

app.get('/api/workspace/email', requirePermission('email.view'), async (req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
  const status = statusParam && ['draft', 'approved', 'sending', 'sent', 'failed', 'cancelled'].includes(statusParam)
    ? (statusParam as 'draft' | 'approved' | 'sending' | 'sent' | 'failed' | 'cancelled')
    : undefined;
  return res.status(200).json({ emails: await listEmails(businessId, status) });
});

app.get('/api/workspace/email/:id', requirePermission('email.view'), async (req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  try {
    return res.status(200).json({ email: await getEmail(businessId, String(req.params.id ?? '')) });
  } catch (error) {
    const handled = emailErrorResponse(error, res);
    if (handled) return handled;
    throw error;
  }
});

const createEmailSchema = z.object({
  kind: z.enum(EMAIL_KINDS),
  toEmail: z.string().trim().min(3).max(320),
  toName: z.string().trim().max(200).nullish(),
  subject: z.string().trim().min(1).max(200),
  bodyText: z.string().min(1).max(5000),
  chatId: z.string().uuid().nullish(),
  crmContactId: z.string().uuid().nullish(),
});

app.post('/api/workspace/email', requirePermission('email.draft'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = createEmailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_EMAIL', details: parsed.error.flatten() });
  try {
    const email = await createEmailDraft(auth.businessId, auth.userId, parsed.data);
    return res.status(201).json({ email });
  } catch (error) {
    const handled = emailErrorResponse(error, res);
    if (handled) return handled;
    throw error;
  }
});

const aiDraftSchema = z.object({
  agentId: z.string().uuid(),
  kind: z.enum(EMAIL_KINDS),
  toEmail: z.string().trim().min(3).max(320),
  toName: z.string().trim().max(200).nullish(),
  instruction: z.string().trim().min(1).max(2000),
  facts: z.string().trim().max(4000).nullish(),
  chatId: z.string().uuid().nullish(),
  crmContactId: z.string().uuid().nullish(),
});

app.post('/api/workspace/email/ai-draft', expensiveActionLimiter, requirePermission('email.draft'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = aiDraftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_EMAIL', details: parsed.error.flatten() });
  try {
    // Always returns a DRAFT. There is deliberately no "draft and send".
    const result = await draftEmailWithAi(auth.businessId, auth.userId, parsed.data);
    return res.status(result.status === 'drafted' ? 201 : 200).json(result);
  } catch (error) {
    const handled = emailErrorResponse(error, res);
    if (handled) return handled;
    throw error;
  }
});

const updateEmailSchema = z.object({
  toEmail: z.string().trim().min(3).max(320),
  toName: z.string().trim().max(200).nullish(),
  subject: z.string().trim().min(1).max(200),
  bodyText: z.string().min(1).max(5000),
});

app.patch('/api/workspace/email/:id', requirePermission('email.draft'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const parsed = updateEmailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_EMAIL', details: parsed.error.flatten() });
  try {
    const email = await updateEmailDraft(auth.businessId, String(req.params.id ?? ''), parsed.data);
    return res.status(200).json({ email });
  } catch (error) {
    const handled = emailErrorResponse(error, res);
    if (handled) return handled;
    throw error;
  }
});

app.post('/api/workspace/email/:id/approve', requirePermission('email.send'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  try {
    const email = await approveAndSendEmail(auth.businessId, String(req.params.id ?? ''), auth.userId);
    return res.status(202).json({ email });
  } catch (error) {
    const handled = emailErrorResponse(error, res);
    if (handled) return handled;
    throw error;
  }
});

app.post('/api/workspace/email/:id/cancel', requirePermission('email.draft'), async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  try {
    const email = await cancelEmail(auth.businessId, String(req.params.id ?? ''), auth.userId);
    return res.status(200).json({ email });
  } catch (error) {
    const handled = emailErrorResponse(error, res);
    if (handled) return handled;
    throw error;
  }
});

app.get('/api/workspace/funnels', requireWorkspaceContext, async (_req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const funnels = await listFunnels(businessId);
  return res.status(200).json({ funnels });
});

const createFunnelSchema = z.object({ name: z.string().trim().min(1).max(200), description: z.string().trim().max(2000).nullish() });

app.post('/api/workspace/funnels', requireWorkspaceContext, requirePermission('automation.create'), async (req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const auth = res.locals.auth as AuthContext;
  const parsed = createFunnelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_FUNNEL', details: parsed.error.flatten() });
  const funnel = await createFunnel(businessId, whatsappAccountId, auth.userId, parsed.data.name, parsed.data.description ?? null);
  return res.status(201).json({ funnel });
});

app.get('/api/workspace/funnels/:funnelId', requireWorkspaceContext, async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  try {
    const detail = await getFunnel(businessId, String(req.params.funnelId ?? ''));
    return res.status(200).json(detail);
  } catch (error) {
    if (isFunnelNotFoundError(error)) return res.status(404).json({ error: 'FUNNEL_NOT_FOUND' });
    throw error;
  }
});

const updateFunnelSchema = z.object({ name: z.string().trim().min(1).max(200), description: z.string().trim().max(2000).nullable() });

app.patch('/api/workspace/funnels/:funnelId', requireWorkspaceContext, requirePermission('automation.edit'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = updateFunnelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_FUNNEL' });
  try {
    const funnel = await updateFunnelMeta(businessId, String(req.params.funnelId ?? ''), parsed.data.name, parsed.data.description);
    return res.status(200).json({ funnel });
  } catch (error) {
    if (isFunnelNotFoundError(error)) return res.status(404).json({ error: 'FUNNEL_NOT_FOUND' });
    throw error;
  }
});

app.delete('/api/workspace/funnels/:funnelId', requireWorkspaceContext, requirePermission('automation.edit'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  try {
    await deleteFunnel(businessId, String(req.params.funnelId ?? ''));
    return res.status(200).json({ status: 'deleted' });
  } catch (error) {
    if (isFunnelNotFoundError(error)) return res.status(404).json({ error: 'FUNNEL_NOT_FOUND' });
    throw error;
  }
});

const funnelStepSchema = z.object({
  nodeType: z.enum(['MESSAGE', 'WAIT', 'CONDITION', 'ASSIGN_HUMAN', 'ASSIGN_TEAM', 'ADD_TAG', 'REMOVE_TAG', 'UPDATE_STAGE', 'NOTIFY_USER']),
  config: z.record(z.string(), z.unknown()),
});
const replaceStepsSchema = z.object({ steps: z.array(funnelStepSchema) });

app.put('/api/workspace/funnels/:funnelId/steps', requireWorkspaceContext, requirePermission('automation.edit'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = replaceStepsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_STEPS', details: parsed.error.flatten() });
  try {
    const steps = await replaceFunnelSteps(businessId, String(req.params.funnelId ?? ''), parsed.data.steps);
    return res.status(200).json({ steps });
  } catch (error) {
    if (isFunnelNotFoundError(error)) return res.status(404).json({ error: 'FUNNEL_NOT_FOUND' });
    if (isInvalidFunnelStepError(error)) return res.status(400).json({ error: 'INVALID_STEP', message: error.message });
    throw error;
  }
});

app.post('/api/workspace/funnels/:funnelId/activate', requireWorkspaceContext, requirePermission('automation.edit'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  try {
    const funnel = await setFunnelActive(businessId, String(req.params.funnelId ?? ''), true);
    return res.status(200).json({ funnel });
  } catch (error) {
    if (isFunnelNotFoundError(error)) return res.status(404).json({ error: 'FUNNEL_NOT_FOUND' });
    if (isInvalidFunnelStepError(error)) return res.status(400).json({ error: 'INVALID_STEP', message: error.message });
    if (isEntitlementDeniedError(error)) {
      const message =
        error.reason === 'NO_ACTIVE_SUBSCRIPTION'
          ? 'This business has no active subscription.'
          : error.reason === 'ENTITLEMENT_DISABLED'
            ? 'Funnels are not enabled on this plan.'
            : `Active funnel limit reached for this plan (${error.current}/${error.limit}).`;
      return res
        .status(403)
        .json({ error: 'ENTITLEMENT_DENIED', reason: error.reason, limit: error.limit, current: error.current, message });
    }
    throw error;
  }
});

app.post('/api/workspace/funnels/:funnelId/deactivate', requireWorkspaceContext, requirePermission('automation.edit'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  try {
    const funnel = await setFunnelActive(businessId, String(req.params.funnelId ?? ''), false);
    return res.status(200).json({ funnel });
  } catch (error) {
    if (isFunnelNotFoundError(error)) return res.status(404).json({ error: 'FUNNEL_NOT_FOUND' });
    throw error;
  }
});

const enrollSchema = z.object({ crmContactId: z.string().uuid() });

app.post('/api/workspace/funnels/:funnelId/enroll', requireWorkspaceContext, requirePermission('automation.execute'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = enrollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_ENROLL' });
  try {
    const instance = await enrollContact(businessId, String(req.params.funnelId ?? ''), parsed.data.crmContactId);
    return res.status(201).json({ instance });
  } catch (error) {
    if (isFunnelNotFoundError(error)) return res.status(404).json({ error: 'FUNNEL_NOT_FOUND' });
    if (isAlreadyEnrolledError(error)) return res.status(409).json({ error: 'ALREADY_ENROLLED', message: error.message });
    if (isInvalidFunnelStepError(error)) return res.status(400).json({ error: 'INVALID_ENROLL', message: error.message });
    throw error;
  }
});

app.post('/api/workspace/funnels/:funnelId/instances/:instanceId/cancel', requireWorkspaceContext, requirePermission('automation.execute'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  try {
    const instance = await cancelFunnelInstance(businessId, String(req.params.funnelId ?? ''), String(req.params.instanceId ?? ''));
    return res.status(200).json({ instance });
  } catch (error) {
    if (isFunnelNotFoundError(error)) return res.status(404).json({ error: 'FUNNEL_NOT_FOUND' });
    if (isFunnelInstanceNotFoundError(error)) return res.status(404).json({ error: 'FUNNEL_INSTANCE_NOT_FOUND' });
    throw error;
  }
});

const suggestCopySchema = z.object({
  kind: z.enum(['campaign_message', 'status_caption', 'follow_up']),
  businessContext: z.string().trim().min(1).max(500),
  count: z.number().int().min(1).max(5).optional(),
});

app.post('/api/workspace/marketing/ai-suggest', requireWorkspaceContext, requirePermission('marketing.create'), async (req, res) => {
  const parsed = suggestCopySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_SUGGEST_REQUEST', details: parsed.error.flatten() });
  // Always 200 - "unavailable" (e.g. Gemini not configured) is an honest,
  // expected outcome the frontend reads from result.status, not a transport error.
  const result = await suggestMarketingCopy(parsed.data);
  return res.status(200).json(result);
});

const reactionSchema = z.object({ emoji: z.string().max(8) });

/**
 * A real reaction send over the live socket - see
 * workspaceService.sendReaction's own doc comment for why no reaction row
 * is written here: Baileys' messages.reaction event does that once this
 * send actually lands, the same real path an incoming reaction takes.
 */
app.post('/api/workspace/messages/:messageId/reactions', requireWorkspaceContext, requirePermission('whatsapp.send'), async (req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as {
    businessId: string;
    whatsappAccountId: string;
  };
  const parsed = reactionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_REACTION' });
  }
  try {
    await workspaceService.sendReaction(businessId, whatsappAccountId, String(req.params.messageId ?? ''), parsed.data.emoji);
    return res.status(202).json({ status: 'sent' });
  } catch (error) {
    if (isChatNotFoundError(error)) return res.status(404).json({ error: 'MESSAGE_NOT_FOUND' });
    return res.status(502).json({ error: 'REACTION_SEND_FAILED', message: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/workspace/chats/:chatId/read', requireWorkspaceContext, async (req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as {
    businessId: string;
    whatsappAccountId: string;
  };
  try {
    const chat = await workspaceService.markChatRead(businessId, whatsappAccountId, String(req.params.chatId ?? ''));
    if (chat) await publishRealtimeEvent({ type: 'chat.updated', businessId, chatId: chat.id });
    return res.status(200).json({ chat });
  } catch (error) {
    if (isChatNotFoundError(error)) return res.status(404).json({ error: 'CHAT_NOT_FOUND' });
    throw error;
  }
});

/**
 * Real Gemini-drafted reply suggestions for the agent to pick from. Always
 * 200: `status` carries the honest outcome so the UI can simply hide the
 * bar when suggestions are genuinely unavailable, rather than surfacing an
 * error for something that is only ever an optional assist.
 */
app.get(
  '/api/workspace/chats/:chatId/reply-suggestions',
  requireWorkspaceContext,
  requirePermission('whatsapp.send'),
  expensiveActionLimiter,
  async (req, res) => {
    const { businessId, whatsappAccountId } = res.locals.workspaceContext as {
      businessId: string;
      whatsappAccountId: string;
    };
    try {
      const result = await suggestReplies(businessId, whatsappAccountId, String(req.params.chatId ?? ''));
      return res.status(200).json(result);
    } catch (error) {
      if (isChatNotFoundError(error)) return res.status(404).json({ error: 'CHAT_NOT_FOUND' });
      throw error;
    }
  },
);

app.get('/api/workspace/search', requireWorkspaceContext, async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  const results = await globalSearch(businessId, query);
  return res.status(200).json({ results });
});

app.get('/api/workspace/dashboard', requireWorkspaceContext, async (_req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as {
    businessId: string;
    whatsappAccountId: string;
  };
  const dashboard = await workspaceService.getDashboardOverview(businessId, whatsappAccountId);
  return res.status(200).json(dashboard);
});

app.get('/api/workspace/business', requireWorkspaceContext, async (_req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const business = await workspaceService.getBusinessProfile(businessId);
  return res.status(200).json({ business });
});

const updateBusinessSchema = z.object({ name: z.string().trim().min(1).max(200) });

app.patch('/api/workspace/business', requireWorkspaceContext, requirePermission('settings.manage'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = updateBusinessSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_BUSINESS' });
  }
  const business = await workspaceService.updateBusinessName(businessId, parsed.data.name);
  return res.status(200).json({ business });
});

const updateProfilePictureSchema = z.object({
  imageBase64: z.string().min(1),
  mimeType: z.string().min(1),
});

/**
 * A real profile picture change on the connected WhatsApp account -
 * see workspaceService.updateAccountProfilePicture's own doc comment for
 * why the WhatsApp push happens before anything is stored locally.
 */
app.put('/api/workspace/account/profile-picture', requireWorkspaceContext, requirePermission('whatsapp.manage'), async (req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as {
    businessId: string;
    whatsappAccountId: string;
  };
  const parsed = updateProfilePictureSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_PROFILE_PICTURE' });
  }
  try {
    const buffer = Buffer.from(parsed.data.imageBase64, 'base64');
    await workspaceService.updateAccountProfilePicture(businessId, whatsappAccountId, buffer, parsed.data.mimeType);
    return res.status(200).json({ status: 'updated' });
  } catch (error) {
    if (isChatNotFoundError(error)) return res.status(404).json({ error: 'ACCOUNT_NOT_FOUND' });
    return res
      .status(502)
      .json({ error: 'PROFILE_PICTURE_UPDATE_FAILED', message: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/workspace/billing', requireWorkspaceContext, async (_req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const billing = await workspaceService.getBillingOverview(businessId);
  return res.status(200).json(billing);
});

app.get('/api/workspace/agents', requireWorkspaceContext, async (_req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const agents = await workspaceService.listAgents(businessId);
  return res.status(200).json({ agents });
});

const AGENT_CATEGORY_VALUES = [
  'general', 'sales', 'support', 'billing', 'bookings', 'logistics',
  'plumbing', 'electrical', 'mechanical', 'hvac', 'construction',
  'cleaning', 'landscaping', 'it_services', 'beauty', 'hospitality',
] as const;

const createAgentSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).nullish(),
  persona: z.string().trim().min(1).nullish(),
  tone: z.string().trim().min(1).nullish(),
  language: z.string().trim().min(1).nullish(),
  systemInstruction: z.string().trim().min(1).nullish(),
  greeting: z.string().trim().min(1).nullish(),
  businessContext: z.string().trim().min(1).nullish(),
  responseStyle: z.string().trim().min(1).nullish(),
  humanTakeoverPolicy: z.string().trim().min(1).nullish(),
  category: z.enum(AGENT_CATEGORY_VALUES).optional(),
  specialization: z.string().trim().min(1).nullish(),
  triggerKeywords: z.array(z.string().trim().min(1)).max(50).optional(),
  blockedKeywords: z.array(z.string().trim().min(1)).max(50).optional(),
  responseDelaySeconds: z.number().int().min(0).max(300).optional(),
  parentAgentId: z.string().uuid().nullish(),
  escalateToAgentId: z.string().uuid().nullish(),
  priority: z.number().int().min(0).max(1000).optional(),
});

app.post('/api/workspace/agents', requireWorkspaceContext, requirePermission('ai.create'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = createAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_AGENT', details: parsed.error.flatten() });
  }
  try {
    const agent = await workspaceService.createAgent(businessId, parsed.data);
    return res.status(201).json({ agent });
  } catch (error) {
    if (isEntitlementDeniedError(error)) {
      const message =
        error.reason === 'NO_ACTIVE_SUBSCRIPTION'
          ? 'This business has no active subscription.'
          : error.reason === 'ENTITLEMENT_DISABLED'
            ? 'AI agents are not enabled on this plan.'
            : `Agent limit reached for this plan (${error.current}/${error.limit}).`;
      return res
        .status(403)
        .json({ error: 'ENTITLEMENT_DENIED', reason: error.reason, limit: error.limit, current: error.current, message });
    }
    throw error;
  }
});

/**
 * A real full edit of an existing agent. Separate from the status route
 * below on purpose: changing configuration and flipping the AI kill switch
 * are different actions with different permissions, and the kill switch
 * stays independently audited.
 */
app.patch('/api/workspace/agents/:agentId', requireWorkspaceContext, requirePermission('ai.edit'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = createAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_AGENT', details: parsed.error.flatten() });
  }
  try {
    const agent = await workspaceService.updateAgent(businessId, String(req.params.agentId ?? ''), parsed.data);
    return res.status(200).json({ agent });
  } catch (error) {
    if (isChatNotFoundError(error)) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    throw error;
  }
});

const agentPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

/**
 * Persists a real drag on the org canvas. Position only - deliberately a
 * separate route from the config edit so moving a tile can never alter
 * routing behaviour, and so it does not need the heavier ai.edit permission.
 */
app.patch('/api/workspace/agents/:agentId/position', requireWorkspaceContext, requirePermission('ai.edit'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = agentPositionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_POSITION' });
  try {
    await workspaceService.updateAgentPosition(businessId, String(req.params.agentId ?? ''), parsed.data.x, parsed.data.y);
    return res.status(204).end();
  } catch (error) {
    if (isChatNotFoundError(error)) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    throw error;
  }
});

const routingPreviewSchema = z.object({ text: z.string().trim().min(1).max(2000) });

/**
 * A real dry run of the routing engine. Calls the exact same
 * routeInboundMessage the worker uses, so what the canvas highlights is what
 * would genuinely happen - not a separate simulation that could drift. Sends
 * nothing and writes nothing.
 */
app.post('/api/workspace/agents/routing-preview', requireWorkspaceContext, requirePermission('ai.view'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = routingPreviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PREVIEW_TEXT' });

  const decision = await routeInboundMessage(businessId, parsed.data.text);
  return res.status(200).json({
    outcome: decision.outcome,
    reason: decision.reason,
    agentId: decision.outcome === 'no_agent' ? null : decision.agent.id,
    matchedKeyword: decision.outcome === 'no_agent' ? null : decision.matchedKeyword,
  });
});

const updateAgentStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']),
});

/**
 * The real AI kill switch - pausing (or archiving) an agent here is what
 * actually stops findActiveForBusiness() from returning it, which is what
 * the incoming-message worker checks before generating any reply. Not a
 * separate "enabled" flag layered on top - the same status this business's
 * whole auto-reply pipeline already gates on.
 */
app.patch('/api/workspace/agents/:agentId/status', requireWorkspaceContext, requirePermission('ai.activate'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = updateAgentStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_AGENT_STATUS', details: parsed.error.flatten() });
  }
  try {
    const agent = await workspaceService.updateAgentStatus(businessId, String(req.params.agentId ?? ''), parsed.data.status);
    return res.status(200).json({ agent });
  } catch (error) {
    if (isChatNotFoundError(error)) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    throw error;
  }
});

app.get('/api/workspace/crm-contacts', requireWorkspaceContext, async (_req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const crmContacts = await workspaceService.listCrmContacts(businessId);
  return res.status(200).json({ crmContacts });
});

const updateCrmContactSchema = z.object({
  stage: z.string().trim().min(1).nullable(),
  leadStatus: z.string().trim().min(1).nullable(),
  notes: z.string().trim().nullable(),
  tags: z.array(z.string().trim().min(1)),
});

app.patch('/api/workspace/crm-contacts/:id', requireWorkspaceContext, requirePermission('crm.edit'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = updateCrmContactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_CRM_CONTACT', details: parsed.error.flatten() });
  }
  try {
    const crmContact = await workspaceService.updateCrmContact(businessId, String(req.params.id ?? ''), parsed.data);
    return res.status(200).json({ crmContact });
  } catch (error) {
    if (isCrmContactNotFoundError(error)) return res.status(404).json({ error: 'CRM_CONTACT_NOT_FOUND' });
    throw error;
  }
});

app.get('/api/workspace/leads', requireWorkspaceContext, async (_req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const leads = await workspaceService.listLeads(businessId);
  return res.status(200).json({ leads });
});

const createLeadSchema = z.object({
  crmContactId: z.string().uuid(),
  source: z.string().trim().min(1).nullish(),
  stage: z.string().trim().min(1).nullish(),
  score: z.number().nullish(),
  value: z.number().nullish(),
  nextAction: z.string().trim().min(1).nullish(),
  notes: z.string().trim().min(1).nullish(),
});

app.post('/api/workspace/leads', requireWorkspaceContext, requirePermission('leads.edit'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = createLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_LEAD', details: parsed.error.flatten() });
  }
  try {
    const lead = await workspaceService.createLead(businessId, parsed.data);
    return res.status(201).json({ lead });
  } catch (error) {
    if (isCrmContactNotFoundError(error)) return res.status(404).json({ error: 'CRM_CONTACT_NOT_FOUND' });
    throw error;
  }
});

const updateLeadSchema = z.object({
  stage: z.string().trim().min(1).nullable(),
  score: z.number().nullable(),
  value: z.number().nullable(),
  nextAction: z.string().trim().nullable(),
  notes: z.string().trim().nullable(),
});

app.patch('/api/workspace/leads/:id', requireWorkspaceContext, requirePermission('leads.edit'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = updateLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_LEAD', details: parsed.error.flatten() });
  }
  try {
    const lead = await workspaceService.updateLead(businessId, String(req.params.id ?? ''), parsed.data);
    return res.status(200).json({ lead });
  } catch (error) {
    if (isLeadNotFoundError(error)) return res.status(404).json({ error: 'LEAD_NOT_FOUND' });
    throw error;
  }
});

const updateLeadStatusSchema = z.object({ status: z.enum(['NEW', 'QUALIFIED', 'ENGAGED', 'WON', 'LOST']) });

app.patch('/api/workspace/leads/:id/status', requireWorkspaceContext, requirePermission('leads.edit'), async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const parsed = updateLeadStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_LEAD_STATUS' });
  }
  try {
    const lead = await workspaceService.updateLeadStatus(businessId, String(req.params.id ?? ''), parsed.data.status);
    return res.status(200).json({ lead });
  } catch (error) {
    if (isLeadNotFoundError(error)) return res.status(404).json({ error: 'LEAD_NOT_FOUND' });
    throw error;
  }
});

app.get('/api/workspace/calls', requireWorkspaceContext, async (_req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as {
    businessId: string;
    whatsappAccountId: string;
  };
  const calls = await workspaceService.listCalls(businessId, whatsappAccountId);
  return res.status(200).json({ calls });
});

app.get('/api/workspace/statuses', requireWorkspaceContext, async (_req, res) => {
  const { businessId, whatsappAccountId } = res.locals.workspaceContext as {
    businessId: string;
    whatsappAccountId: string;
  };
  const statuses = await workspaceService.listStatuses(businessId, whatsappAccountId);
  return res.status(200).json({ statuses });
});

// Notifications don't require an active WhatsApp connection (requireWorkspaceContext) -
// a signed-in user should still see e.g. a stale HUMAN_HANDOFF notification while
// reconnecting - so these sit directly behind the blanket /api/workspace requireAuth only.
app.get('/api/workspace/notifications', async (_req, res) => {
  const { businessId, userId } = res.locals.auth as AuthContext;
  const limitParam = Number(_req.query.limit);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;
  const result = await listNotifications(businessId, userId, limit);
  return res.status(200).json(result);
});

app.patch('/api/workspace/notifications/:id/read', async (req, res) => {
  const { userId } = res.locals.auth as AuthContext;
  try {
    const notification = await markNotificationRead(userId, String(req.params.id ?? ''));
    return res.status(200).json({ notification });
  } catch (error) {
    if (isNotificationNotFoundError(error)) return res.status(404).json({ error: 'NOTIFICATION_NOT_FOUND' });
    throw error;
  }
});

app.patch('/api/workspace/notifications/:id/dismiss', async (req, res) => {
  const { userId } = res.locals.auth as AuthContext;
  try {
    const notification = await markNotificationDismissed(userId, String(req.params.id ?? ''));
    return res.status(200).json({ notification });
  } catch (error) {
    if (isNotificationNotFoundError(error)) return res.status(404).json({ error: 'NOTIFICATION_NOT_FOUND' });
    throw error;
  }
});

app.post('/api/workspace/notifications/read-all', async (_req, res) => {
  const { businessId, userId } = res.locals.auth as AuthContext;
  const updatedCount = await markAllNotificationsRead(businessId, userId);
  return res.status(200).json({ updatedCount });
});

/**
 * The only route that ever reads media bytes off disk. Requires the same
 * connected-workspace context as every other workspace route, and re-checks
 * that the media row actually belongs to this business before decrypting
 * anything - no raw filesystem path is ever exposed to the client.
 *
 * Supports HTTP Range so <video>/<audio> elements can seek. The file is
 * decrypted (AES-256-GCM, single auth tag - can't be partially decrypted)
 * into memory once per request, then the requested byte range is sliced
 * from that plaintext; this is a real, correct implementation, not
 * disk-level zero-copy streaming.
 */
app.get('/api/media/:mediaId', requireAuth, requireWorkspaceContext, async (req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const mediaId = String(req.params.mediaId ?? '');
  const media = await new WhatsAppMediaRepository(pool).findById(mediaId);

  if (!media || media.businessId !== businessId) {
    return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
  }
  if (media.downloadStatus === 'pending' || media.downloadStatus === 'downloading') {
    return res.status(202).json({ error: 'MEDIA_NOT_READY', downloadStatus: media.downloadStatus });
  }
  if (media.downloadStatus === 'unavailable') {
    return res.status(404).json({
      error: 'MEDIA_UNAVAILABLE',
      message: 'This media is no longer available from WhatsApp (expired, or the sender deleted it before it could be downloaded).',
    });
  }
  if (media.downloadStatus === 'failed' || !media.storageReference) {
    return res.status(502).json({ error: 'MEDIA_DOWNLOAD_FAILED' });
  }

  let plaintext: Buffer;
  try {
    plaintext = await retrieveMedia(businessId, media.storageReference);
  } catch (error) {
    console.error(`[API] Failed to retrieve stored media ${mediaId}:`, error);
    return res.status(500).json({ error: 'MEDIA_STORAGE_ERROR' });
  }

  const totalSize = plaintext.length;

  // A WhatsApp sender controls the MIME type on media they send us. Echoing
  // an arbitrary one back with `inline` disposition would let a hostile
  // sender get script (text/html, image/svg+xml) executed in this app's own
  // origin the moment an authenticated agent opened the media URL. Anything
  // outside the inline-safe allowlist is still served in full - just as a
  // neutral-typed download the browser will never render.
  const inlineSafe = isInlineSafeMime(media.mimeType);
  const safeFileName = media.fileName?.replace(/[\r\n"]/g, '');
  res.setHeader('Content-Type', inlineSafe ? (media.mimeType as string) : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader(
    'Content-Disposition',
    `${inlineSafe ? 'inline' : 'attachment'}${safeFileName ? `; filename="${safeFileName}"` : ''}`,
  );

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const hasStart = Boolean(match?.[1]);
    const hasEnd = Boolean(match?.[2]);
    let start = 0;
    let end = totalSize - 1;
    if (match && (hasStart || hasEnd)) {
      if (hasStart) {
        start = Number(match[1]);
        end = hasEnd ? Number(match[2]) : totalSize - 1;
      } else {
        // Suffix range ("bytes=-500"): last N bytes.
        start = Math.max(0, totalSize - Number(match[2]));
      }
    }

    if (!match || start > end || end >= totalSize || start < 0) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).end();
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', String(end - start + 1));
    return res.end(plaintext.subarray(start, end + 1));
  }

  res.setHeader('Content-Length', String(totalSize));
  return res.end(plaintext);
});

const messageSchema = z.object({
  text: z.string().min(1).max(10000),
});

app.post('/api/diagnostics/validate-message', (req, res) => {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ valid: false, error: 'Invalid message payload.' });
  }

  return res.status(200).json({ valid: true });
});

const argon2ParamsSchema = z.object({
  memoryCostKib: z.number().int().positive(),
  timeCost: z.number().int().positive(),
  parallelism: z.number().int().positive(),
  hashLengthBytes: z.number().int().positive(),
});

// PIN hashing happens client-side (Argon2id, WASM) - the server only ever sees hex-encoded hashes/salts, never a raw PIN.
const setupLockSchema = z.object({
  salt: z.string().min(16),
  pinHash: z.string().regex(/^[0-9a-f]+$/i).min(32),
  argon2Params: argon2ParamsSchema,
});

const unlockSchema = z.object({
  pinHash: z.string().regex(/^[0-9a-f]+$/i).min(32),
});

app.get('/api/security/lock/status', requireAuth, async (_req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  const status = await getLockStatus(businessId);
  return res.status(200).json(status);
});

app.get('/api/security/lock/challenge', requireAuth, async (_req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  try {
    const challenge = await getUnlockChallenge(businessId);
    return res.status(200).json(challenge);
  } catch (error) {
    if (error instanceof LockNotConfiguredError) {
      return res.status(404).json({ error: 'LOCK_NOT_CONFIGURED', message: error.message });
    }
    throw error;
  }
});

app.post('/api/security/lock/setup', requireAuth, async (req, res) => {
  const parsed = setupLockSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_SETUP_PAYLOAD' });
  }

  const { businessId } = res.locals.auth as AuthContext;
  try {
    await setupLock(businessId, parsed.data);
    return res.status(201).json({ configured: true });
  } catch (error) {
    if (error instanceof LockAlreadyConfiguredError) {
      return res.status(409).json({ error: 'LOCK_ALREADY_CONFIGURED', message: error.message });
    }
    if (error instanceof InvalidArgon2ParamsError) {
      return res.status(400).json({ error: 'WEAK_ARGON2_PARAMS', message: error.message });
    }
    throw error;
  }
});

app.post('/api/security/lock/unlock', requireAuth, async (req, res) => {
  const parsed = unlockSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_UNLOCK_PAYLOAD' });
  }

  const { businessId } = res.locals.auth as AuthContext;
  try {
    const result = await attemptUnlock(businessId, parsed.data.pinHash);
    if (result.revoked) return res.status(423).json(result);
    return res.status(result.unlocked ? 200 : 401).json(result);
  } catch (error) {
    if (error instanceof LockNotConfiguredError) {
      return res.status(404).json({ error: 'LOCK_NOT_CONFIGURED', message: error.message });
    }
    throw error;
  }
});

app.get('/api/security/alerts/human-takeover', requireAuth, async (_req, res) => {
  const { businessId } = res.locals.auth as AuthContext;
  const alerts = await listHumanTakeoverAlerts(businessId);
  return res.status(200).json({ alerts });
});

// Serves the built frontend as one process in production. In dev, the Vite dev
// server (npm run dev:web) proxies /api here instead - this block only applies
// when a real production build actually exists, never a placeholder page.
const webBuildDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web');
if (existsSync(webBuildDir)) {
  app.use(express.static(webBuildDir));
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(webBuildDir, 'index.html'));
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[API] Unhandled route error:', error);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) });
});

void whatsappConnectionService.connect().catch((error) => {
  console.error('[WhatsApp] Initial connection failed:', error);
});

const httpServer = createServer(app);
attachWebSocketServer(httpServer);

httpServer.listen(port, () => {
  console.log(`[WhatchatAI] API listening on http://localhost:${port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[WhatchatAI] Received ${signal}, closing outbound dispatch worker...`);
  await outboundMessagesWorker.close();
  await scheduledStatusPublishWorker.close();
  await messageRevocationWorker.close();
  await emailSendWorker.close();
  await funnelAdvanceWorker.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
