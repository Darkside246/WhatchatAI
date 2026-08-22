import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import {
  BusinessDocumentRepository,
  type BusinessDocumentRecord,
  type BusinessDocumentVersionRecord,
} from '../repositories/businessDocumentRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { EntitlementService } from './entitlementService.js';
import type { EntitlementDeniedError } from './workspaceService.js';
import { storeMedia, retrieveMedia } from '../media/localEncryptedMediaStorage.js';
import { isAllowedDocumentMime, classifyDocumentMimeFamily } from '../domain/documents/documentMime.js';
import { checkExecutablePayload } from '../security/sentinel/heuristicShield.js';
import { enqueueDocumentParse } from '../queue/queues/documentParseQueue.js';
import { enqueueWithTimeout } from '../queue/enqueueWithTimeout.js';

const documentRepository = new BusinessDocumentRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const entitlementService = new EntitlementService(pool);

export class DocumentNotFoundError extends Error {}
export class InvalidDocumentError extends Error {}

export function isDocumentNotFoundError(error: unknown): error is DocumentNotFoundError {
  return error instanceof DocumentNotFoundError;
}
export function isInvalidDocumentError(error: unknown): error is InvalidDocumentError {
  return error instanceof InvalidDocumentError;
}

const MAX_FILENAME_LENGTH = 255;
// Real file bytes, after base64 decoding - the base64 JSON request body
// itself is bounded separately by the app-wide express.json() limit
// (src/server/index.ts), which this phase does not change.
const MAX_DOCUMENT_FILE_SIZE_BYTES = 15 * 1024 * 1024;

export interface UploadDocumentInput {
  businessId: string;
  createdBy: string;
  filename: string;
  mimeType: string;
  fileBase64: string;
}

export interface UploadedDocument {
  document: BusinessDocumentRecord;
  version: BusinessDocumentVersionRecord;
}

async function auditBlocked(businessId: string, userId: string, filename: string, mimeType: string, reason: string): Promise<void> {
  await securityAuditLogRepository.record({
    businessId,
    eventType: 'business_document_upload_blocked',
    severity: 'warning',
    reason,
    // Structural/diagnostic only - never the file's own bytes/content.
    rawMetadata: { filename, mimeType, uploadedBy: userId },
  });
}

/**
 * D1's only mutation that creates real content: validate -> screen ->
 * encrypt+store -> persist metadata in one transaction -> audit. No
 * partially-created row is ever left behind - every validation/security
 * check runs before anything is inserted, so a rejected upload never
 * reaches the database at all (see docs/PHASE_B_.../D1: "no fabricated
 * status").
 */
export async function uploadDocument(input: UploadDocumentInput): Promise<UploadedDocument> {
  const filename = input.filename.trim();
  if (!filename) throw new InvalidDocumentError('Filename is required.');
  if (filename.length > MAX_FILENAME_LENGTH) {
    throw new InvalidDocumentError(`Filename must be at most ${MAX_FILENAME_LENGTH} characters.`);
  }

  if (!isAllowedDocumentMime(input.mimeType)) {
    const reason = `Unsupported document type: ${input.mimeType}. Allowed types: PDF, DOCX, plain text, CSV.`;
    await auditBlocked(input.businessId, input.createdBy, filename, input.mimeType, reason);
    throw new InvalidDocumentError(reason);
  }

  // Same executable-payload check the WhatsApp message pipeline runs
  // (heuristicShield.ts) - reused, not duplicated or weakened.
  const executableBlockReason = checkExecutablePayload({ mimetype: input.mimeType, fileName: filename });
  if (executableBlockReason) {
    await auditBlocked(input.businessId, input.createdBy, filename, input.mimeType, executableBlockReason);
    throw new InvalidDocumentError(executableBlockReason);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(input.fileBase64, 'base64');
  } catch {
    throw new InvalidDocumentError('File content is not valid base64.');
  }
  if (buffer.length === 0) throw new InvalidDocumentError('File is empty.');
  if (buffer.length > MAX_DOCUMENT_FILE_SIZE_BYTES) {
    throw new InvalidDocumentError(`File exceeds the maximum allowed size (${MAX_DOCUMENT_FILE_SIZE_BYTES} bytes).`);
  }

  const entitlementCheck = await entitlementService.canCreateBusinessDocument(input.businessId);
  if (!entitlementCheck.allowed) {
    const error = new Error(`Business document creation denied: ${entitlementCheck.reason}`) as EntitlementDeniedError;
    error.code = 'ENTITLEMENT_DENIED';
    error.reason = entitlementCheck.reason as EntitlementDeniedError['reason'];
    error.limit = entitlementCheck.limit;
    error.current = entitlementCheck.current;
    throw error;
  }

  // Guaranteed non-null: isAllowedDocumentMime and classifyDocumentMimeFamily
  // read the exact same allow-list, so a MIME that passed the check above
  // always classifies to a real family.
  const mimeFamily = classifyDocumentMimeFamily(input.mimeType);
  if (!mimeFamily) throw new InvalidDocumentError(`Unsupported document type: ${input.mimeType}.`);

  const checksum = createHash('sha256').update(buffer).digest('hex');
  // Same storeMedia/EncryptionService.encryptBuffer primitive WhatsApp
  // media already uses - no new encryption or storage implementation.
  const storageReference = await storeMedia(input.businessId, checksum, buffer);

  const result = await withTransaction(async (client) => {
    const repo = new BusinessDocumentRepository(client);
    const document = await repo.create({ businessId: input.businessId, createdBy: input.createdBy, filename });
    const version = await repo.createVersion({
      businessId: input.businessId,
      documentId: document.id,
      versionNumber: 1,
      checksum,
      mimeType: input.mimeType,
      mimeFamily,
      fileSize: buffer.length,
      storageReference,
    });
    await repo.setCurrentVersion(input.businessId, document.id, version.id);
    return { document: { ...document, currentVersionId: version.id }, version };
  });

  await securityAuditLogRepository.record({
    businessId: input.businessId,
    eventType: 'business_document_uploaded',
    rawMetadata: {
      documentId: result.document.id,
      versionId: result.version.id,
      mimeFamily,
      fileSize: buffer.length,
      uploadedBy: input.createdBy,
    },
  });

  // The document/version rows are already durably committed above, so a
  // slow/unreachable Redis must never hang this caller (a real HTTP
  // upload request) indefinitely - see enqueueWithTimeout. Parsing is
  // D2's own, strictly separate stage (§ D2 directive: "document
  // ingestion and document AI retrieval are two separate security
  // boundaries") - this enqueue only ever leads to extraction/chunking/
  // indexing, never to ai_retrievable being set.
  await enqueueWithTimeout(
    enqueueDocumentParse({ businessId: input.businessId, documentId: result.document.id, versionId: result.version.id }),
    `document parse ${result.document.id}`,
  );

  return result;
}

export async function listDocuments(businessId: string): Promise<BusinessDocumentRecord[]> {
  return documentRepository.listForBusiness(businessId);
}

export async function getDocument(businessId: string, documentId: string): Promise<BusinessDocumentRecord> {
  const document = await documentRepository.findByIdForBusiness(documentId, businessId);
  if (!document) throw new DocumentNotFoundError('Document not found.');
  return document;
}

export async function deleteDocument(businessId: string, documentId: string, deletedBy: string): Promise<void> {
  const removed = await documentRepository.softDeleteForBusiness(documentId, businessId);
  if (!removed) throw new DocumentNotFoundError('Document not found.');

  await securityAuditLogRepository.record({
    businessId,
    eventType: 'business_document_deleted',
    rawMetadata: { documentId, deletedBy },
  });
}

export interface DownloadedDocument {
  buffer: Buffer;
  document: BusinessDocumentRecord;
  version: BusinessDocumentVersionRecord;
}

/** Decrypts and returns the original uploaded bytes - the same authenticated-read pattern GET /api/media/:id already uses, never a raw filesystem path. */
export async function downloadDocument(businessId: string, documentId: string): Promise<DownloadedDocument> {
  const document = await getDocument(businessId, documentId);
  if (!document.currentVersionId) throw new DocumentNotFoundError('Document has no stored version.');

  const version = await documentRepository.findVersionForBusiness(document.currentVersionId, businessId);
  if (!version) throw new DocumentNotFoundError('Document version not found.');

  const buffer = await retrieveMedia(businessId, version.storageReference);
  return { buffer, document, version };
}
