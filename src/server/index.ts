import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import path from 'node:path';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from '../realtime/wsServer.js';
import { publishRealtimeEvent } from '../realtime/pubsub.js';
import { whatsappConnectionService } from '../services/whatsappConnectionService.js';
import { whatsappMessageIngestionService } from '../services/whatsappMessageIngestionService.js';
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
import type { Request, Response, NextFunction } from 'express';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.disable('x-powered-by');
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
app.post('/api/workspace/chats/:chatId/messages', requireWorkspaceContext, async (req, res) => {
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

app.patch('/api/workspace/chats/:chatId/ai-mode', requireWorkspaceContext, async (req, res) => {
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

const reactionSchema = z.object({ emoji: z.string().max(8) });

/**
 * A real reaction send over the live socket - see
 * workspaceService.sendReaction's own doc comment for why no reaction row
 * is written here: Baileys' messages.reaction event does that once this
 * send actually lands, the same real path an incoming reaction takes.
 */
app.post('/api/workspace/messages/:messageId/reactions', requireWorkspaceContext, async (req, res) => {
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

app.patch('/api/workspace/business', requireWorkspaceContext, async (req, res) => {
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
app.put('/api/workspace/account/profile-picture', requireWorkspaceContext, async (req, res) => {
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
});

app.post('/api/workspace/agents', requireWorkspaceContext, async (req, res) => {
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
app.patch('/api/workspace/agents/:agentId/status', requireWorkspaceContext, async (req, res) => {
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

app.patch('/api/workspace/crm-contacts/:id', requireWorkspaceContext, async (req, res) => {
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

app.post('/api/workspace/leads', requireWorkspaceContext, async (req, res) => {
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

app.patch('/api/workspace/leads/:id', requireWorkspaceContext, async (req, res) => {
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

app.patch('/api/workspace/leads/:id/status', requireWorkspaceContext, async (req, res) => {
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
  res.setHeader('Content-Type', media.mimeType ?? 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  if (media.fileName) {
    res.setHeader('Content-Disposition', `inline; filename="${media.fileName.replace(/[\r\n"]/g, '')}"`);
  }

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
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
