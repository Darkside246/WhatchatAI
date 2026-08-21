import { pool } from '../db/pool.js';
import { KnowledgeBaseRepository, type KnowledgeBaseDocumentRecord } from '../repositories/knowledgeBaseRepository.js';
import { EntitlementService } from './entitlementService.js';
import type { EntitlementDeniedError } from './workspaceService.js';

const knowledgeBaseRepository = new KnowledgeBaseRepository(pool);
const entitlementService = new EntitlementService(pool);

export class KnowledgeBaseDocumentNotFoundError extends Error {}
export class InvalidKnowledgeBaseDocumentError extends Error {}

const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 20_000;

function validate(title: string, content: string): void {
  if (!title.trim()) throw new InvalidKnowledgeBaseDocumentError('Title is required.');
  if (title.length > MAX_TITLE_LENGTH) throw new InvalidKnowledgeBaseDocumentError(`Title must be at most ${MAX_TITLE_LENGTH} characters.`);
  if (!content.trim()) throw new InvalidKnowledgeBaseDocumentError('Content is required.');
  if (content.length > MAX_CONTENT_LENGTH) throw new InvalidKnowledgeBaseDocumentError(`Content must be at most ${MAX_CONTENT_LENGTH} characters.`);
}

export async function createKnowledgeBaseDocument(
  businessId: string,
  createdBy: string,
  title: string,
  content: string,
): Promise<KnowledgeBaseDocumentRecord> {
  validate(title, content);

  const entitlementCheck = await entitlementService.canCreateKnowledgeBaseDocument(businessId);
  if (!entitlementCheck.allowed) {
    const error = new Error(`Knowledge base document creation denied: ${entitlementCheck.reason}`) as EntitlementDeniedError;
    error.code = 'ENTITLEMENT_DENIED';
    error.reason = entitlementCheck.reason as EntitlementDeniedError['reason'];
    error.limit = entitlementCheck.limit;
    error.current = entitlementCheck.current;
    throw error;
  }

  return knowledgeBaseRepository.create({ businessId, createdBy, title: title.trim(), content: content.trim() });
}

export async function listKnowledgeBaseDocuments(businessId: string): Promise<KnowledgeBaseDocumentRecord[]> {
  return knowledgeBaseRepository.listForBusiness(businessId);
}

export async function updateKnowledgeBaseDocument(
  businessId: string,
  documentId: string,
  title: string,
  content: string,
): Promise<KnowledgeBaseDocumentRecord> {
  validate(title, content);
  const updated = await knowledgeBaseRepository.update(businessId, documentId, title.trim(), content.trim());
  if (!updated) throw new KnowledgeBaseDocumentNotFoundError('Knowledge base document not found.');
  return updated;
}

export async function deleteKnowledgeBaseDocument(businessId: string, documentId: string): Promise<void> {
  const removed = await knowledgeBaseRepository.remove(businessId, documentId);
  if (!removed) throw new KnowledgeBaseDocumentNotFoundError('Knowledge base document not found.');
}

export function isKnowledgeBaseDocumentNotFoundError(error: unknown): error is KnowledgeBaseDocumentNotFoundError {
  return error instanceof KnowledgeBaseDocumentNotFoundError;
}
export function isInvalidKnowledgeBaseDocumentError(error: unknown): error is InvalidKnowledgeBaseDocumentError {
  return error instanceof InvalidKnowledgeBaseDocumentError;
}
