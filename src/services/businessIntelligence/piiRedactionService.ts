/**
 * Business Intelligence Agent - PII and secret redaction. No PII-detection
 * utility existed anywhere in AURA before this; built from scratch,
 * mirroring Sentinel's own two-stage shape (heuristicShield.ts then
 * aiSentinel.ts) rather than inventing a new architecture.
 *
 * Stage 1 (always runs, deterministic, free): regex patterns for common,
 * well-defined PII/secret shapes, plus a real cross-reference against
 * this business's own CRM contacts already on file. Honestly best-effort,
 * not exhaustive - natural-language PII (a street address woven into a
 * sentence) can slip through regex alone.
 *
 * Stage 2 (optional, Goose-routed): if Goose is configured, one more
 * pass asks it to flag residual natural-language PII the regex missed.
 * Skipped silently, never blocking the pipeline, when Goose isn't
 * configured or the call fails - matches this codebase's own established
 * "Goose is a best-effort fallback, never a hard dependency" convention.
 */

import { pool, queryAsTenant } from '../../db/pool.js';
import { CrmContactRepository } from '../../repositories/crmContactRepository.js';
import { BiSecurityAlertRepository, type BiAlertSourceType } from '../../repositories/biSecurityAlertRepository.js';
import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';
import { isGooseFallbackEnabled } from '../platform/platformConfigService.js';
import * as gooseService from '../gooseService.js';
import { aiGateway } from '../ai/aiGateway.js';

const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

// Deliberately simple, fast, auditable regex patterns - Stage 1 must stay
// cheap since it runs on every piece of content before anything reaches
// an LLM. Ambiguous/natural-language cases are left to the optional
// Stage 2 Goose pass, not adjudicated here.
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const CARD_NUMBER_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;
const SECRET_KEY_PATTERN = /\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9]{16,}\b/gi;

export interface RedactionResult {
  redactedText: string;
  alertTypes: Array<'pii_detected' | 'secret_detected'>;
}

function redactStage1(text: string, knownContacts: { name: string | null; phone: string | null; email: string | null }[]): RedactionResult {
  let redacted = text;
  const alertTypes = new Set<'pii_detected' | 'secret_detected'>();

  if (SECRET_KEY_PATTERN.test(redacted)) {
    redacted = redacted.replace(SECRET_KEY_PATTERN, '[REDACTED_SECRET]');
    alertTypes.add('secret_detected');
  }
  if (EMAIL_PATTERN.test(redacted)) {
    redacted = redacted.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
    alertTypes.add('pii_detected');
  }
  if (CARD_NUMBER_PATTERN.test(redacted)) {
    redacted = redacted.replace(CARD_NUMBER_PATTERN, '[REDACTED_NUMBER]');
    alertTypes.add('pii_detected');
  }
  if (PHONE_PATTERN.test(redacted)) {
    redacted = redacted.replace(PHONE_PATTERN, '[REDACTED_PHONE]');
    alertTypes.add('pii_detected');
  }

  // Real cross-reference against this business's own known contacts -
  // catches a verbatim name/phone/email even where the generic patterns
  // above wouldn't (e.g. a bare name with no @ or digit shape).
  for (const contact of knownContacts) {
    for (const value of [contact.name, contact.phone, contact.email]) {
      if (!value || value.trim().length < 3) continue;
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'gi');
      if (pattern.test(redacted)) {
        redacted = redacted.replace(pattern, '[REDACTED_NAME]');
        alertTypes.add('pii_detected');
      }
    }
  }

  return { redactedText: redacted, alertTypes: [...alertTypes] };
}

/** Optional second pass - never throws, never blocks on Goose being unavailable or slow. */
async function redactStage2(businessId: string, text: string): Promise<RedactionResult> {
  try {
    const available = gooseService.getCapabilities().configured && (await isGooseFallbackEnabled());
    if (!available) return { redactedText: text, alertTypes: [] };

    const response = await aiGateway.generate({
      tenantId: businessId,
      operation: 'bi.pii_scan',
      preferredProvider: 'goose',
      responseFormat: 'json',
      maxOutputTokens: 500,
      messages: [
        {
          role: 'system',
          content: [
            'You scan business text for residual personal information a simple pattern match could miss - a street address, a full name in prose, a workplace, anything that could identify a specific individual.',
            'The text has already had emails/phones/card numbers/known contact names redacted - look only for what remains.',
            'Respond as a JSON object: {"redactedText": "..."} with any remaining personal information replaced by [REDACTED_PII]. If nothing remains, return the text unchanged.',
          ].join('\n'),
        },
        { role: 'user', content: text },
      ],
    });

    const parsed: unknown = JSON.parse(response.text);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { redactedText?: unknown }).redactedText === 'string') {
      const redactedText = (parsed as { redactedText: string }).redactedText;
      return { redactedText, alertTypes: redactedText !== text ? ['pii_detected'] : [] };
    }
    return { redactedText: text, alertTypes: [] };
  } catch (error) {
    console.warn('[piiRedactionService] Stage 2 (Goose) scan failed, continuing with Stage 1 result only:', error instanceof Error ? error.message : error);
    return { redactedText: text, alertTypes: [] };
  }
}

/**
 * The one real entry point - redacts a single piece of source content and
 * logs a real, value-free security alert for anything found. Never
 * throws; a redaction failure degrades to "leave the text as-is and log
 * nothing" rather than blocking the whole extraction run (fail-safe, per
 * the directive's own §39 - but this specific failure mode means an
 * over-cautious pipeline should prefer NOT calling the LLM at all if
 * Stage 1 itself throws, which the regex patterns above cannot: they are
 * pure, synchronous string operations with no I/O to fail).
 */
export async function redactForAnalysis(
  businessId: string,
  text: string,
  sourceType: BiAlertSourceType,
  sourceId?: string | null,
): Promise<string> {
  const contactRepo = new CrmContactRepository(queryAsTenant(businessId));
  const contacts = await contactRepo.listByBusiness(businessId, 500, { excludeSyncExcluded: true }).catch(() => []);
  const knownContacts = contacts.map((c) => ({
    name: c.manualDisplayName ?? c.contactDisplayName ?? null,
    phone: c.phoneNumber ?? null,
    email: c.email ?? null,
  }));

  const stage1 = redactStage1(text, knownContacts);
  const stage2 = await redactStage2(businessId, stage1.redactedText);
  const allAlertTypes = [...new Set([...stage1.alertTypes, ...stage2.alertTypes])];

  if (allAlertTypes.length > 0) {
    const alertRepo = new BiSecurityAlertRepository(queryAsTenant(businessId));
    for (const alertType of allAlertTypes) {
      await alertRepo.record({ businessId, alertType, sourceType, sourceId: sourceId ?? null }).catch(() => undefined);
    }
    await securityAuditLogRepository.record({
      businessId,
      eventType: 'bi_security_alert_detected',
      rawMetadata: { sourceType, alertTypes: allAlertTypes },
    }).catch(() => undefined);
  }

  return stage2.redactedText;
}
