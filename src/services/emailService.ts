import { pool } from '../db/pool.js';
import {
  EmailMessageRepository,
  type EmailKind,
  type EmailMessageRecord,
  type EmailStatus,
  type BusinessEmailSettingsRecord,
} from '../repositories/emailMessageRepository.js';
import { AiAgentRepository } from '../repositories/aiAgentRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { enqueueEmailSend } from '../queue/queues/emailSendQueue.js';
import * as emailProvider from './emailProviderService.js';
import { getGeminiClient } from './geminiClient.js';

const emailRepository = new EmailMessageRepository(pool);
const agentRepository = new AiAgentRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

export class EmailNotFoundError extends Error {}
export class InvalidEmailError extends Error {}
export class EmailNotApprovableError extends Error {}

const MAX_SUBJECT_CHARS = 200;
const MAX_BODY_CHARS = 5000;

export interface EmailCapabilities {
  /** Whether a provider key exists. Sending genuinely cannot happen without it. */
  providerConfigured: boolean;
  /** Whether this workspace has set a sender identity. */
  senderConfigured: boolean;
  provider: emailProvider.EmailProviderName;
  reason?: string;
}

export async function getEmailCapabilities(businessId: string): Promise<EmailCapabilities> {
  const capabilities = emailProvider.getCapabilities();
  const settings = await emailRepository.getSettings(businessId);
  const reasons: string[] = [];
  if (!capabilities.configured) reasons.push(capabilities.reason ?? 'Email provider is not configured');
  if (!settings) reasons.push('No sender address is configured for this workspace');
  return {
    providerConfigured: capabilities.configured,
    senderConfigured: settings !== null,
    provider: capabilities.provider,
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

  await enqueueEmailSend({ emailMessageId: id, businessId });
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

export async function getSettings(businessId: string): Promise<BusinessEmailSettingsRecord | null> {
  return emailRepository.getSettings(businessId);
}

export async function updateSettings(
  businessId: string,
  updatedBy: string,
  input: { fromEmail: string; fromName?: string | null | undefined; replyToEmail?: string | null | undefined },
): Promise<BusinessEmailSettingsRecord> {
  if (!emailProvider.isPlausibleEmail(input.fromEmail)) throw new InvalidEmailError('That sender address is not a valid email address.');
  if (input.replyToEmail && !emailProvider.isPlausibleEmail(input.replyToEmail)) {
    throw new InvalidEmailError('That reply-to address is not a valid email address.');
  }
  const settings = await emailRepository.upsertSettings({
    businessId,
    fromEmail: input.fromEmail.trim(),
    fromName: input.fromName?.trim() || null,
    replyToEmail: input.replyToEmail?.trim() || null,
  });
  await securityAuditLogRepository.record({
    businessId,
    eventType: 'email_settings_updated',
    rawMetadata: { updatedBy, fromEmail: settings.fromEmail },
  });
  return settings;
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

export function isEmailNotFoundError(error: unknown): error is EmailNotFoundError {
  return error instanceof EmailNotFoundError;
}
export function isInvalidEmailError(error: unknown): error is InvalidEmailError {
  return error instanceof InvalidEmailError;
}
export function isEmailNotApprovableError(error: unknown): error is EmailNotApprovableError {
  return error instanceof EmailNotApprovableError;
}
