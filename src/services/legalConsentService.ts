import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { pool } from '../db/pool.js';
import { LegalDocumentRepository, type LegalDocumentType } from '../repositories/legalDocumentRepository.js';
import { UserConsentRepository } from '../repositories/userConsentRepository.js';
import * as emailProvider from './emailProviderService.js';

const legalDocRepo = new LegalDocumentRepository(pool);
const consentRepo = new UserConsentRepository(pool);

/** 48-hour token lifetime for consent confirmation. */
const TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

function appBaseUrl(): string {
  const url = process.env['APP_URL'];
  return url && url.trim().length > 0 ? url.trim().replace(/\/$/, '') : 'http://localhost:3000';
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export type ActiveDocumentsDto = {
  terms: { version: string; title: string; contentHtml: string; effectiveAt: string } | null;
  privacy: { version: string; title: string; contentHtml: string; effectiveAt: string } | null;
};

export async function getActiveDocuments(): Promise<ActiveDocumentsDto> {
  const [terms, privacy] = await Promise.all([
    legalDocRepo.getActive('TERMS'),
    legalDocRepo.getActive('PRIVACY'),
  ]);
  return {
    terms: terms ? { version: terms.version, title: terms.title, contentHtml: terms.contentHtml, effectiveAt: terms.effectiveAt } : null,
    privacy: privacy ? { version: privacy.version, title: privacy.title, contentHtml: privacy.contentHtml, effectiveAt: privacy.effectiveAt } : null,
  };
}

export type RecordConsentInput = {
  fullName: string;
  email: string;
  phone: string;
  termsVersion: string;
  privacyVersion: string;
  ipAddress: string | null;
  userAgent: string | null;
  marketingOptIn: boolean;
};

export type RecordConsentResult = {
  consentId: string;
  qrCodeDataUrl: string;
};

export class ConsentValidationError extends Error {}
export class LegalDocumentNotFoundError extends Error {}

export async function recordConsent(input: RecordConsentInput): Promise<RecordConsentResult> {
  const [terms, privacy] = await Promise.all([
    legalDocRepo.getActive('TERMS'),
    legalDocRepo.getActive('PRIVACY'),
  ]);

  if (!terms) throw new LegalDocumentNotFoundError('No active Terms of Service.');
  if (!privacy) throw new LegalDocumentNotFoundError('No active Privacy Policy.');

  if (input.termsVersion !== terms.version) {
    throw new ConsentValidationError('Terms version mismatch — please reload the page and agree again.');
  }
  if (input.privacyVersion !== privacy.version) {
    throw new ConsentValidationError('Privacy Policy version mismatch — please reload the page and agree again.');
  }

  const consent = await consentRepo.create(input);

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const emailToken = generateToken();
  const qrToken = generateToken();

  await Promise.all([
    consentRepo.createConfirmation({ consentId: consent.id, token: emailToken, method: 'email', expiresAt }),
    consentRepo.createConfirmation({ consentId: consent.id, token: qrToken, method: 'qr', expiresAt }),
  ]);

  const qrUrl = `${appBaseUrl()}/consent/confirm?token=${qrToken}`;
  const emailUrl = `${appBaseUrl()}/consent/confirm?token=${emailToken}`;

  const qrCodeDataUrl = await QRCode.toDataURL(qrUrl, {
    width: 256,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });

  await sendConfirmationEmail(consent.email, consent.fullName, emailUrl);

  return { consentId: consent.id, qrCodeDataUrl };
}

export type ConfirmConsentResult =
  | { status: 'confirmed'; email: string; fullName: string }
  | { status: 'already_confirmed' }
  | { status: 'expired' }
  | { status: 'not_found' }
  | { status: 'already_used' };

export async function confirmConsent(token: string): Promise<ConfirmConsentResult> {
  const confirmation = await consentRepo.findConfirmationByToken(token);
  if (!confirmation) return { status: 'not_found' };
  if (confirmation.usedAt) return { status: 'already_used' };
  if (new Date(confirmation.expiresAt) < new Date()) return { status: 'expired' };

  await consentRepo.markConfirmed(confirmation.consentId, confirmation.method, confirmation.id);

  // Fetch name/email for the success page
  const result = await pool.query<{ full_name: string; email: string }>(
    `SELECT full_name, email FROM user_consents WHERE id = $1`,
    [confirmation.consentId],
  );
  const row = result.rows[0];
  return { status: 'confirmed', email: row?.email ?? '', fullName: row?.full_name ?? '' };
}

async function sendConfirmationEmail(to: string, name: string, confirmUrl: string): Promise<void> {
  const apiKey = emailProvider.environmentResendApiKey();
  if (!apiKey) {
    // Log and skip — missing transactional key is a deployment issue, not a user error.
    console.warn('[legalConsentService] No RESEND_API_KEY configured — skipping confirmation email.');
    return;
  }

  const bodyText = `Hi ${name},\n\nThank you for agreeing to the AURA Terms of Service and Privacy Policy.\n\nPlease confirm your consent by clicking the link below:\n\n${confirmUrl}\n\nThis link expires in 48 hours. If you didn't fill out a form on AURA, you can safely ignore this email.\n\nAURA team`;

  const transport: emailProvider.ResendTransport = { kind: 'resend', apiKey };
  await emailProvider.sendEmail(transport, {
    // Domain left as-is deliberately - this is real sending infrastructure
    // (SPF/DKIM tied to whatchat.ai), not display copy. Changing it needs
    // a real AURA-branded domain provisioned first, not a text rename.
    fromEmail: 'noreply@whatchat.ai',
    fromName: 'AURA',
    replyToEmail: null,
    toEmail: to,
    toName: name,
    subject: 'Confirm your AURA consent',
    bodyText,
  });
}

export async function getActiveDocument(type: LegalDocumentType) {
  return legalDocRepo.getActive(type);
}
