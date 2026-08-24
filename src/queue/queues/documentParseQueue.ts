import { Queue } from 'bullmq';
import { queueConnection, attachQueueErrorLogging } from '../connection.js';

export const DOCUMENT_PARSE_QUEUE = 'document_parse';

export interface DocumentParseJobData {
  businessId: string;
  documentId: string;
  versionId: string;
}

export const documentParseQueue = new Queue<DocumentParseJobData>(DOCUMENT_PARSE_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 2000 },
  },
});
attachQueueErrorLogging(documentParseQueue, 'documentParseQueue');

export async function enqueueDocumentParse(data: DocumentParseJobData): Promise<void> {
  await documentParseQueue.add('parse-document', data);
}
