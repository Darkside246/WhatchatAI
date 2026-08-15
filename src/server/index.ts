import 'dotenv/config';
import express from 'express';
import { z } from 'zod';

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
  // Deliberately reports the real integration state only after the WhatsApp service
  // is wired. No simulated CONNECTED/ONLINE state is allowed here.
  res.status(503).json({
    status: 'not_connected',
    connected: false,
    reason: 'WhatsApp connection service has not been initialised yet.',
  });
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

app.listen(port, () => {
  console.log(`[WhatchatAI] API listening on http://localhost:${port}`);
});
