import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import { whatsappConnectionService } from '../services/whatsappConnectionService.js';

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

void whatsappConnectionService.connect().catch((error) => {
  console.error('[WhatsApp] Initial connection failed:', error);
});

app.listen(port, () => {
  console.log(`[WhatchatAI] API listening on http://localhost:${port}`);
});
