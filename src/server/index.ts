import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import path from 'node:path';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from '../realtime/wsServer.js';
import { whatsappConnectionService } from '../services/whatsappConnectionService.js';
import { whatsappMessageIngestionService } from '../services/whatsappMessageIngestionService.js';
import { workspaceService, isChatNotFoundError } from '../services/workspaceService.js';
import { checkDatabaseHealth, pool } from '../db/pool.js';
import { BusinessRepository } from '../repositories/businessRepository.js';
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
import type { Request, Response, NextFunction } from 'express';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

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
  res.locals.workspaceContext = context;
  next();
}

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

app.get('/api/workspace/agents', requireWorkspaceContext, async (_req, res) => {
  const { businessId } = res.locals.workspaceContext as { businessId: string; whatsappAccountId: string };
  const agents = await workspaceService.listAgents(businessId);
  return res.status(200).json({ agents });
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

async function resolveDefaultBusinessId(): Promise<string> {
  const business = await new BusinessRepository(pool).ensureDefault();
  return business.id;
}

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

app.get('/api/security/lock/status', async (_req, res) => {
  const businessId = await resolveDefaultBusinessId();
  const status = await getLockStatus(businessId);
  return res.status(200).json(status);
});

app.get('/api/security/lock/challenge', async (_req, res) => {
  const businessId = await resolveDefaultBusinessId();
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

app.post('/api/security/lock/setup', async (req, res) => {
  const parsed = setupLockSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_SETUP_PAYLOAD' });
  }

  const businessId = await resolveDefaultBusinessId();
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

app.post('/api/security/lock/unlock', async (req, res) => {
  const parsed = unlockSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_UNLOCK_PAYLOAD' });
  }

  const businessId = await resolveDefaultBusinessId();
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

app.get('/api/security/alerts/human-takeover', async (_req, res) => {
  const businessId = await resolveDefaultBusinessId();
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
