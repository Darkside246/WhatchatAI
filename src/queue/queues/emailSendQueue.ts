import { Queue } from 'bullmq';
import { queueConnection } from '../connection.js';

export const EMAIL_SEND_QUEUE = 'email_send';

export interface EmailSendJobData {
  /** The worker re-reads the row and re-checks approval rather than trusting the payload. */
  emailMessageId: string;
  businessId: string;
}

export const emailSendQueue = new Queue<EmailSendJobData>(EMAIL_SEND_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 500,
  },
});

export async function enqueueEmailSend(data: EmailSendJobData): Promise<void> {
  await emailSendQueue.add('send-email', data);
}
