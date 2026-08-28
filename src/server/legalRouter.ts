import { Router } from 'express';
import { z } from 'zod';
import {
  getActiveDocuments,
  recordConsent,
  confirmConsent,
  ConsentValidationError,
  LegalDocumentNotFoundError,
} from '../services/legalConsentService.js';

const router = Router();

const consentBodySchema = z.object({
  fullName: z.string().min(1).max(200).trim(),
  email: z.string().email().max(320).trim(),
  phone: z.string().min(5).max(30).trim(),
  termsVersion: z.string().min(1),
  privacyVersion: z.string().min(1),
  marketingOptIn: z.boolean().default(false),
});

/** Returns both active legal documents in one call. */
router.get('/documents', async (_req, res) => {
  const docs = await getActiveDocuments();
  res.json(docs);
});

/** Records consent + returns the QR code data URL and sends confirmation email. */
router.post('/consent', async (req, res) => {
  const parsed = consentBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input.', issues: parsed.error.issues });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? null;
  const userAgent = req.headers['user-agent'] ?? null;

  try {
    const result = await recordConsent({ ...parsed.data, ipAddress: ip, userAgent });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof ConsentValidationError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof LegalDocumentNotFoundError) {
      res.status(503).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/** Confirms a consent record via email link or QR scan. */
router.get('/consent/confirm', async (req, res) => {
  const token = typeof req.query['token'] === 'string' ? req.query['token'] : '';
  if (!token) {
    res.status(400).json({ error: 'token is required.' });
    return;
  }

  const result = await confirmConsent(token);
  res.json(result);
});

export { router as legalRouter };
