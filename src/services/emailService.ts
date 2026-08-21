import { pool } from '../db/pool.js';
import {
  EmailMessageRepository,
  type EmailKind,
  type EmailMessageRecord,
  type EmailStatus,
  type BusinessEmailSettingsRecord,
} from '../repositories/emailMessageRepository.js';
import {
  IntegrationSettingsRepository,
  type EmailSettingsResolved,
} from '../repositories/integrationSettingsRepository.js';
import { AiAgentRepository } from '../repositories/aiAgentRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { enqueueEmailSend } from '../queue/queues/emailSendQueue.js';
import { enqueueWithTimeout } from '../queue/enqueueWithTimeout.js';
import * as emailProvider from './emailProviderService.js';
import { getGeminiClient } from './geminiClient.js';

const emailRepository = new EmailMessageRepository(pool);
const integrationSettingsRepository = new IntegrationSettingsRepository(pool);
const agentRepository = new AiAgentRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

export class EmailNotFoundError extends Error {}
export class InvalidEmailError extends Error {}
export class EmailNotApprovableError extends Error {}

const MAX_SUBJECT_CHARS = 200;
const MAX_BODY_CHARS = 5000;

export interface EmailCapabilities {
  /** Whether a usable transport exists. Sending genuinely cannot happen without one. */
  providerConfigured: boolean;
  /** Whether this workspace has set a sender identity. */
  senderConfigured: boolean;
  provider: emailProvider.EmailProviderName;
  /**
   * Where the credential actually came from. Reported so an operator can
   * tell whether the value in effect is the one they typed into Settings or
   * one left in the server's environment.
   */
  credentialSource: 'workspace' | 'environment' | 'none';
  reason?: string;
}

/**
 * Resolves the transport this workspace would genuinely send through.
 *
 * Precedence: settings saved in the app win over environment variables.
 * Returns null - never a partially-built transport - when the configuration
 * could not actually send, so callers cannot accidentally proceed.
 */
export async function resolveTransport(
  settings: EmailSettingsResolved | null,
): Promise<{ transport: emailProvider.EmailTransport; source: 'workspace' | 'environment' } | null> {
  if (settings?.provider === 'smtp') {
    if (!settings.smtpHost || !settings.smtpPort) return null;
    return {
      transport: {
        kind: 'smtp',
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpSecure,
        username: settings.smtpUsername,
        password: settings.smtpPassword,
      },
      source: 'workspace',
    };
  }

  if (settings?.resendApiKey) {
    return { transport: { kind: 'resend', apiKey: settings.resendApiKey }, source: 'workspace' };
  }

  const environmentKey = emailProvider.environmentResendApiKey();
  if (environmentKey) return { transport: { kind: 'resend', apiKey: environmentKey }, source: 'environment' };

  return null;
}

export async function getEmailCapabilities(businessId: string): Promise<EmailCapabilities> {
  const settings = await integrationSettingsRepository.getEmailResolved(businessId);
  const resolved = await resolveTransport(settings);

  const reasons: string[] = [];
  if (!resolved) {
    reasons.push(
      settings?.provider === 'smtp'
        ? 'SMTP host and port are not configured'
        : 'No Resend API key is configured, in this workspace or the server environment',
    );
  }
  if (!settings?.fromEmail) reasons.push('No sender address is configured for this workspace');

  return {
    providerConfigured: resolved !== null,
    senderConfigured: Boolean(settings?.fromEmail),
    provider: settings?.provider ?? 'resend',
    credentialSource: resolved?.source ?? 'none',
    ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
  };
}

function validateDraft(input: { toEmail: string; subject: string; bodyText: string }): void {
  if (!emailProvider.isPlausibleEmail(input.toEmail)) throw new InvalidEmailError('That recipient address is not a valid email address.');
  if (input.subject.trim().length === 0) throw new InvalidEmailError('Subject is required.');
  if (input.subject.length > MAX_SUBJECT_CHARS) throw new InvalidEmailError(`Subject must be ${MAX_SUBJECT_CHARS} characters or fewer.`);
  if (input.bodyText.trim().length === 0) throw new InvalidEmailError('Body is required.');
  if (input.bodyText.length > MAX_BODY_CHARS) throw new InvalidEmailError(`Body must be ${MAX_BODY_CHARS} characters or fewer.`);
}

export interface CreateDraftInput {
  kind: EmailKind;
  toEmail: string;
  toName?: string | null | undefined;
  subject: string;
  bodyText: string;
  chatId?: string | null | undefined;
  crmContactId?: string | null | undefined;
}

export async function createDraft(businessId: string, createdBy: string, input: CreateDraftInput): Promise<EmailMessageRecord> {
  validateDraft(input);
  const draft = await emailRepository.createDraft({
    businessId,
    createdBy,
    kind: input.kind,
    toEmail: input.toEmail.trim(),
    toName: input.toName ?? null,
    subject: input.subject.trim(),
    bodyText: input.bodyText,
    chatId: input.chatId ?? null,
    crmContactId: input.crmContactId ?? null,
  });
  await securityAuditLogRepository.record({
    businessId,
    eventType: 'email_drafted',
    rawMetadata: { emailMessageId: draft.id, kind: draft.kind, createdBy, source: 'human' },
  });
  return draft;
}

export async function listEmails(businessId: string, status?: EmailStatus): Promise<EmailMessageRecord[]> {
  return emailRepository.listForBusiness(businessId, status);
}

export async function getEmail(businessId: string, id: string): Promise<EmailMessageRecord> {
  const email = await emailRepository.findByIdForBusiness(businessId, id);
  if (!email) throw new EmailNotFoundError('Email not found.');
  return email;
}

export async function updateDraft(
  businessId: string,
  id: string,
  input: { subject: string; bodyText: string; toEmail: string; toName?: string | null | undefined },
): Promise<EmailMessageRecord> {
  validateDraft(input);
  const updated = await emailRepository.updateDraft(businessId, id, {
    subject: input.subject.trim(),
    bodyText: input.bodyText,
    toEmail: input.toEmail.trim(),
    toName: input.toName ?? null,
  });
  // Only a draft is editable: an approved email must not change after the
  // approver read it.
  if (!updated) throw new EmailNotApprovableError('Only a draft can be edited. This email has already been approved or sent.');
  return updated;
}

/**
 * The human gate. This is the only path to sending, and it requires a real
 * user id from an authenticated session holding 'email.send' - never an
 * agent, and never an automated caller.
 */
export async function approveAndSend(businessId: string, id: string, approvedBy: string): Promise<EmailMessageRecord> {
  const existing = await emailRepository.findByIdForBusiness(businessId, id);
  if (!existing) throw new EmailNotFoundError('Email not found.');
  if (existing.status !== 'draft') {
    throw new EmailNotApprovableError(`This email is "${existing.status}" - only a draft can be approved.`);
  }

  const capabilities = await getEmailCapabilities(businessId);
  if (!capabilities.providerConfigured || !capabilities.senderConfigured) {
    // Refuse up front rather than approving something that will only fail in
    // the worker; the operator gets the real reason now.
    throw new InvalidEmailError(capabilities.reason ?? 'Email sending is not configured.');
  }

  const approved = await emailRepository.approve(businessId, id, approvedBy);
  if (!approved) throw new EmailNotApprovableError('This email could no longer be approved.');

  await securityAuditLogRepository.record({
    businessId,
    eventType: 'email_approved',
    rawMetadata: { emailMessageId: id, approvedBy, draftedByAgentId: approved.draftedByAgentId, toEmail: approved.toEmail },
  });

  // The row is already durably 'approved' at this point, so a slow/
  // unreachable Redis must never hang this caller (a real HTTP
  // "approve and send" request) indefinitely - see enqueueWithTimeout.
  await enqueueWithTimeout(enqueueEmailSend({ emailMessageId: id, businessId }), `email send ${id}`);
  return approved;
}

export async function cancelEmail(businessId: string, id: string, cancelledBy: string): Promise<EmailMessageRecord> {
  const cancelled = await emailRepository.cancel(businessId, id);
  if (!cancelled) throw new EmailNotApprovableError('This email can no longer be cancelled.');
  await securityAuditLogRepository.record({
    businessId,
    eventType: 'email_cancelled',
    rawMetadata: { emailMessageId: id, cancelledBy },
  });
  return cancelled;
}

export async function getSettings(businessId: string) {
  return integrationSettingsRepository.getEmailPublic(businessId);
}

export interface UpdateEmailSettingsInput {
  provider: emailProvider.EmailProviderName;
  fromEmail: string;
  fromName?: string | null | undefined;
  replyToEmail?: string | null | undefined;
  /** Omit to keep the stored secret; empty string clears it. Never round-tripped to the browser. */
  resendApiKey?: string | null | undefined;
  smtpHost?: string | null | undefined;
  smtpPort?: number | null | undefined;
  smtpSecure?: boolean | undefined;
  smtpUsername?: string | null | undefined;
  smtpPassword?: string | null | undefined;
}

export async function updateEmailSettings(businessId: string, updatedBy: string, input: UpdateEmailSettingsInput) {
  if (!emailProvider.isPlausibleEmail(input.fromEmail)) throw new InvalidEmailError('That sender address is not a valid email address.');
  if (input.replyToEmail && !emailProvider.isPlausibleEmail(input.replyToEmail)) {
    throw new InvalidEmailError('That reply-to address is not a valid email address.');
  }
  if (input.provider === 'smtp') {
    if (!input.smtpHost?.trim()) throw new InvalidEmailError('SMTP needs a host.');
    if (!input.smtpPort || input.smtpPort < 1 || input.smtpPort > 65535) throw new InvalidEmailError('SMTP needs a valid port.');
  }

  await integrationSettingsRepository.upsertEmail({
    businessId,
    provider: input.provider,
    fromEmail: input.fromEmail.trim(),
    fromName: input.fromName?.trim() || null,
    replyToEmail: input.replyToEmail?.trim() || null,
    resendApiKey: input.resendApiKey,
    smtpHost: input.smtpHost?.trim() || null,
    smtpPort: input.smtpPort ?? null,
    smtpSecure: input.smtpSecure,
    smtpUsername: input.smtpUsername?.trim() || null,
    smtpPassword: input.smtpPassword,
  });

  await securityAuditLogRepository.record({
    businessId,
    eventType: 'email_settings_updated',
    rawMetadata: { updatedBy, provider: input.provider, fromEmail: input.fromEmail },
  });

  return integrationSettingsRepository.getEmailPublic(businessId);
}

export type EmailTestResult = { status: 'ok'; detail: string } | { status: 'failed'; reason: string };

/**
 * Proves the mail settings genuinely work.
 *
 * SMTP is verified twice: a real connection/auth handshake first, then a
 * real message. Resend has no handshake, so it is proven by the send alone.
 * Either way the result is recorded, so the Settings screen reports a real
 * past outcome rather than inferring health from fields being filled in.
 */
export async function sendTestEmail(businessId: string, requestedBy: string, toEmail: string): Promise<EmailTestResult> {
  if (!emailProvider.isPlausibleEmail(toEmail)) throw new InvalidEmailError('That test recipient is not a valid email address.');

  const settings = await integrationSettingsRepository.getEmailResolved(businessId);
  if (!settings?.fromEmail) return { status: 'failed', reason: 'Set a sender address first.' };

  const resolved = await resolveTransport(settings);
  if (!resolved) return { status: 'failed', reason: 'No usable mail transport is configured.' };

  if (resolved.transport.kind === 'smtp') {
    const verified = await emailProvider.verifySmtpTransport(resolved.transport);
    if (!verified.ok) {
      await integrationSettingsRepository.recordEmailTest(businessId, false, verified.reason);
      return { status: 'failed', reason: `Could not connect to the mail server: ${verified.reason}` };
    }
  }

  const result = await emailProvider.sendEmail(resolved.transport, {
    fromEmail: settings.fromEmail,
    fromName: settings.fromName,
    replyToEmail: settings.replyToEmail,
    toEmail: toEmail.trim(),
    toName: null,
    subject: 'WhatchatAI test email',
    bodyText:
      'This is a real test email from WhatchatAI.\n\n' +
      'If you are reading it, your sending settings work and the workspace can send email.',
  });

  const ok = result.status === 'sent';
  await integrationSettingsRepository.recordEmailTest(businessId, ok, ok ? null : result.reason);
  await securityAuditLogRepository.record({
    businessId,
    eventType: 'email_test_sent',
    rawMetadata: { requestedBy, toEmail, ok, provider: resolved.transport.kind, source: resolved.source },
  });

  return ok
    ? { status: 'ok', detail: `Sent via ${resolved.transport.kind}. Check that inbox to confirm it arrived.` }
    : { status: 'failed', reason: result.reason };
}


export type DraftWithAiResult =
  | { status: 'drafted'; email: EmailMessageRecord }
  | { status: 'unavailable'; reason: string };

/**
 * Has an agent draft an email from REAL context only.
 *
 * Two hard rules, both enforced in the prompt and by the surrounding flow:
 *  1. The result is always a draft. There is no code path from here to a
 *     send - a person holding 'email.send' must approve it.
 *  2. The model is forbidden from inventing figures. This app holds no
 *     orders or invoicing model, so an "invoice" it wrote from imagination
 *     would contain fabricated amounts. It must use only the facts passed
 *     in, and leave an explicit [ ] gap otherwise for a human to fill.
 */
export async function draftWithAi(
  businessId: string,
  requestedBy: string,
  input: {
    agentId: string;
    kind: EmailKind;
    toEmail: string;
    toName?: string | null | undefined;
    instruction: string;
    facts?: string | null | undefined;
    chatId?: string | null | undefined;
    crmContactId?: string | null | undefined;
  },
): Promise<DraftWithAiResult> {
  if (!emailProvider.isPlausibleEmail(input.toEmail)) throw new InvalidEmailError('That recipient address is not a valid email address.');

  // Tenant check is explicit: findById is not business-scoped, so an agent
  // id from another workspace must be refused here.
  const agent = await agentRepository.findById(input.agentId);
  if (!agent || agent.businessId !== businessId) throw new EmailNotFoundError('Agent not found.');

  const genAi = getGeminiClient();
  if (!genAi) return { status: 'unavailable', reason: 'GEMINI_API_KEY is not configured, so no draft can be generated.' };

  const systemInstruction = [
    `You are drafting a business email on behalf of "${agent.name}".`,
    agent.persona ? `Persona: ${agent.persona}` : '',
    agent.tone ? `Tone: ${agent.tone}` : '',
    `Email type: ${input.kind}.`,
    '',
    'ABSOLUTE RULES:',
    '- Use ONLY facts given to you below. Never invent prices, totals, amounts, invoice or order numbers, dates, delivery times, or account details.',
    '- If a necessary detail was not given, write a placeholder in square brackets such as [amount] or [order number] so a human fills it in. Never guess a value.',
    '- Do not promise anything not stated in the facts.',
    '- Output the email body only: no subject line, no markdown, no commentary.',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  const factsBlock = input.facts?.trim() ? `Known facts:\n${input.facts.trim()}` : 'Known facts: none supplied.';
  const prompt = `${factsBlock}\n\nWhat this email needs to do:\n${input.instruction.trim()}`;

  try {
    const response = await genAi.models.generateContent({
      model: process.env.GEMINI_REPLY_MODEL ?? process.env.GEMINI_MODEL ?? 'gemini-3.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { systemInstruction },
    });
    const text = response.text?.trim();
    if (!text) return { status: 'unavailable', reason: 'The model returned an empty draft.' };

    const subject = `${input.kind.replace(/_/g, ' ')} from ${agent.name}`.slice(0, MAX_SUBJECT_CHARS);
    const email = await emailRepository.createDraft({
      businessId,
      createdBy: requestedBy,
      draftedByAgentId: agent.id,
      kind: input.kind,
      toEmail: input.toEmail.trim(),
      toName: input.toName ?? null,
      subject,
      bodyText: text.slice(0, MAX_BODY_CHARS),
      chatId: input.chatId ?? null,
      crmContactId: input.crmContactId ?? null,
    });

    await securityAuditLogRepository.record({
      businessId,
      eventType: 'email_drafted',
      rawMetadata: { emailMessageId: email.id, kind: email.kind, requestedBy, source: 'ai', agentId: agent.id },
    });

    return { status: 'drafted', email };
  } catch (error) {
    return { status: 'unavailable', reason: `Draft generation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The one path by which an automation may send email.
 *
 * Deliberately separate from approveAndSend so the human-approval route
 * stays exactly as strict as it was. What makes this legitimate is narrow
 * and worth stating: the body is static text a person wrote into a funnel
 * step and then explicitly activated, so it carries no untrusted customer
 * input and no AI generation. The approval is attributed to that person,
 * and the audit records that it came from a funnel rather than from a click.
 *
 * If sending is not configured, the row is left as a draft for a human -
 * an automation must not silently drop a message it promised to send.
 */
export async function sendFunnelEmail(input: {
  businessId: string;
  authorisedBy: string;
  funnelId: string;
  crmContactId: string;
  chatId: string;
  toEmail: string;
  subject: string;
  bodyText: string;
}): Promise<EmailMessageRecord> {
  if (!emailProvider.isPlausibleEmail(input.toEmail)) {
    throw new InvalidEmailError(`"${input.toEmail}" is not a valid email address.`);
  }

  const draft = await emailRepository.createDraft({
    businessId: input.businessId,
    createdBy: input.authorisedBy,
    kind: 'general_update',
    toEmail: input.toEmail.trim(),
    toName: null,
    subject: input.subject.trim().slice(0, MAX_SUBJECT_CHARS),
    bodyText: input.bodyText.slice(0, MAX_BODY_CHARS),
    chatId: input.chatId,
    crmContactId: input.crmContactId,
  });

  await securityAuditLogRepository.record({
    businessId: input.businessId,
    eventType: 'email_drafted',
    rawMetadata: { emailMessageId: draft.id, source: 'funnel', funnelId: input.funnelId, authorisedBy: input.authorisedBy },
  });

  const capabilities = await getEmailCapabilities(input.businessId);
  if (!capabilities.providerConfigured || !capabilities.senderConfigured) {
    // Left as a draft on purpose: a human can see it waiting and send it
    // once email is set up, instead of it vanishing.
    return draft;
  }

  const approved = await emailRepository.approve(input.businessId, draft.id, input.authorisedBy);
  if (!approved) return draft;

  await securityAuditLogRepository.record({
    businessId: input.businessId,
    eventType: 'email_approved',
    rawMetadata: { emailMessageId: draft.id, approvedBy: input.authorisedBy, source: 'funnel', funnelId: input.funnelId },
  });

  // Reached from a funnel's SEND_EMAIL step, which can itself run
  // synchronously inside a real HTTP enrollContact request (initial
  // enrollment) as well as from the background funnelAdvanceWorker (a
  // WAIT resume) - never assume this is off the request path.
  await enqueueWithTimeout(enqueueEmailSend({ emailMessageId: draft.id, businessId: input.businessId }), `funnel email send ${draft.id}`);
  return approved;
}

export function isEmailNotFoundError(error: unknown): error is EmailNotFoundError {
  return error instanceof EmailNotFoundError;
}
export function isInvalidEmailError(error: unknown): error is InvalidEmailError {
  return error instanceof InvalidEmailError;
}
export function isEmailNotApprovableError(error: unknown): error is EmailNotApprovableError {
  return error instanceof EmailNotApprovableError;
}
