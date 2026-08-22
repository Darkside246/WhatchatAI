import { Worker, type Job } from 'bullmq';
import { queueConnection } from '../connection.js';
import { EMAIL_SEND_QUEUE, type EmailSendJobData } from '../queues/emailSendQueue.js';
import { pool } from '../../db/pool.js';
import { EmailMessageRepository } from '../../repositories/emailMessageRepository.js';
import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';
import * as emailProvider from '../../services/emailProviderService.js';
import { resolveTransport } from '../../services/emailService.js';
import { IntegrationSettingsRepository } from '../../repositories/integrationSettingsRepository.js';

const emailRepository = new EmailMessageRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const integrationSettingsRepository = new IntegrationSettingsRepository(pool);

/**
 * Sends one approved email.
 *
 * The approval check is repeated here on purpose. The API already refuses to
 * queue an unapproved draft, but this worker is the last gate before a real
 * customer receives something - so it re-reads the row and refuses anything
 * that is not genuinely approved by a real person, whatever the job payload
 * claims.
 */
async function processJob(job: Job<EmailSendJobData>): Promise<void> {
  const { emailMessageId, businessId } = job.data;

  // Business-scoped in the same query, not a bare findById - the job
  // payload's own businessId is trusted only as far as this WHERE clause,
  // never as a claim taken at face value.
  const email = await emailRepository.findByIdForBusiness(businessId, emailMessageId);
  if (!email) {
    console.warn(`[EmailSendWorker] No such email ${emailMessageId} for business ${businessId}`);
    return;
  }
  if (email.status === 'sent') return; // a retry must never send twice
  if (email.status !== 'approved') {
    console.warn(`[EmailSendWorker] Refusing to send ${emailMessageId}: status is "${email.status}", not approved`);
    return;
  }
  if (!email.approvedBy) {
    // Should be impossible (a DB CHECK enforces it too), but this is the
    // invariant that keeps an AI draft from ever reaching a customer alone.
    await emailRepository.markFailed(emailMessageId, 'Refused: approved status with no recorded approver');
    return;
  }

  const settings = await integrationSettingsRepository.getEmailResolved(email.businessId);
  if (!settings?.fromEmail) {
    await emailRepository.markFailed(emailMessageId, 'No sender identity configured for this workspace');
    return;
  }

  // Resolved fresh here rather than captured at approval time, so a
  // corrected credential takes effect on the retry instead of the send
  // failing forever on settings the operator has already fixed.
  const resolved = await resolveTransport(settings);
  if (!resolved) {
    await emailRepository.markFailed(emailMessageId, 'No usable mail transport is configured for this workspace');
    return;
  }

  // Claim it. If another job already moved it out of 'approved', stop.
  if (!(await emailRepository.markSending(emailMessageId))) return;

  const result = await emailProvider.sendEmail(resolved.transport, {
    fromEmail: settings.fromEmail,
    fromName: settings.fromName,
    replyToEmail: settings.replyToEmail,
    toEmail: email.toEmail,
    toName: email.toName,
    subject: email.subject,
    bodyText: email.bodyText,
  });

  if (result.status === 'sent') {
    await emailRepository.markSent(emailMessageId, result.provider, result.providerMessageId);
    await securityAuditLogRepository.record({
      businessId: email.businessId,
      eventType: 'email_sent',
      rawMetadata: {
        emailMessageId,
        toEmail: email.toEmail,
        approvedBy: email.approvedBy,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
      },
    });
    console.log(`[EmailSendWorker] Sent email ${emailMessageId} via ${result.provider}`);
    return;
  }

  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  if (isFinalAttempt) {
    await emailRepository.markFailed(emailMessageId, result.reason);
    return;
  }
  // Put it back so the next attempt can claim it again. approve() would be
  // wrong here: it only ever matches a 'draft', so this row would stay stuck
  // in 'sending' and never send at all.
  await emailRepository.revertToApproved(emailMessageId);
  throw new Error(result.reason);
}

export const emailSendWorker = new Worker<EmailSendJobData>(EMAIL_SEND_QUEUE, processJob, {
  connection: queueConnection,
  concurrency: 3,
});

emailSendWorker.on('failed', (job, error) => {
  console.error(`[EmailSendWorker] Job ${job?.id} failed:`, error.message);
});

emailSendWorker.on('error', (error) => {
  console.error('[EmailSendWorker] Worker error:', error.message);
});

console.log(`[EmailSendWorker] Listening on queue "${EMAIL_SEND_QUEUE}" (concurrency=3)`);
