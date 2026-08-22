import type { Queryable } from './types.js';

export type BusinessDocumentStatus = 'uploaded';

export interface BusinessDocumentRecord {
  id: string;
  businessId: string;
  createdBy: string;
  filename: string;
  currentVersionId: string | null;
  status: BusinessDocumentStatus;
  aiRetrievable: boolean;
  aiSendable: boolean;
  customerVisible: boolean;
  humanOnly: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface BusinessDocumentRow {
  id: string;
  business_id: string;
  created_by: string;
  filename: string;
  current_version_id: string | null;
  status: BusinessDocumentStatus;
  ai_retrievable: boolean;
  ai_sendable: boolean;
  customer_visible: boolean;
  human_only: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toRecord(row: BusinessDocumentRow): BusinessDocumentRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    createdBy: row.created_by,
    filename: row.filename,
    currentVersionId: row.current_version_id,
    status: row.status,
    aiRetrievable: row.ai_retrievable,
    aiSendable: row.ai_sendable,
    customerVisible: row.customer_visible,
    humanOnly: row.human_only,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export type DocumentParserStatus = 'pending' | 'parsing' | 'parsed' | 'failed' | 'unsupported';
export type DocumentExtractionStatus = 'pending' | 'extracted' | 'failed';
export type DocumentIndexingStatus = 'pending' | 'chunked' | 'failed';

export interface BusinessDocumentVersionRecord {
  id: string;
  businessId: string;
  documentId: string;
  versionNumber: number;
  checksum: string;
  contentHash: string | null;
  mimeType: string;
  mimeFamily: string;
  fileSize: number;
  storageReference: string;
  parserStatus: DocumentParserStatus;
  extractionStatus: DocumentExtractionStatus;
  indexingStatus: DocumentIndexingStatus;
  failureReason: string | null;
  createdAt: string;
}

interface BusinessDocumentVersionRow {
  id: string;
  business_id: string;
  document_id: string;
  version_number: number;
  checksum: string;
  content_hash: string | null;
  mime_type: string;
  mime_family: string;
  file_size: string;
  storage_reference: string;
  parser_status: DocumentParserStatus;
  extraction_status: DocumentExtractionStatus;
  indexing_status: DocumentIndexingStatus;
  failure_reason: string | null;
  created_at: string;
}

function toVersionRecord(row: BusinessDocumentVersionRow): BusinessDocumentVersionRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    documentId: row.document_id,
    versionNumber: row.version_number,
    checksum: row.checksum,
    contentHash: row.content_hash,
    mimeType: row.mime_type,
    mimeFamily: row.mime_family,
    fileSize: Number(row.file_size),
    storageReference: row.storage_reference,
    parserStatus: row.parser_status,
    extractionStatus: row.extraction_status,
    indexingStatus: row.indexing_status,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

export interface CreateDocumentVersionInput {
  businessId: string;
  documentId: string;
  versionNumber: number;
  checksum: string;
  mimeType: string;
  mimeFamily: string;
  fileSize: number;
  storageReference: string;
}

/**
 * Tenant-scoped by construction: every method that accepts a document id
 * also requires businessId, and the SQL itself filters on it - no bare
 * findById is exposed for this table, so there is nothing to accidentally
 * bypass into. A cross-tenant id returns the exact same null result as a
 * genuinely nonexistent one.
 */
export class BusinessDocumentRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: { businessId: string; createdBy: string; filename: string }): Promise<BusinessDocumentRecord> {
    const { rows } = await this.db.query<BusinessDocumentRow>(
      `INSERT INTO business_documents (business_id, created_by, filename) VALUES ($1, $2, $3) RETURNING *`,
      [input.businessId, input.createdBy, input.filename],
    );
    const row = rows[0];
    if (!row) throw new Error('business_documents insert returned no row');
    return toRecord(row);
  }

  async setCurrentVersion(businessId: string, documentId: string, versionId: string): Promise<void> {
    await this.db.query(
      `UPDATE business_documents SET current_version_id = $3, updated_at = now() WHERE id = $1 AND business_id = $2`,
      [documentId, businessId, versionId],
    );
  }

  async findByIdForBusiness(id: string, businessId: string): Promise<BusinessDocumentRecord | null> {
    const { rows } = await this.db.query<BusinessDocumentRow>(
      'SELECT * FROM business_documents WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL',
      [id, businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForBusiness(businessId: string): Promise<BusinessDocumentRecord[]> {
    const { rows } = await this.db.query<BusinessDocumentRow>(
      'SELECT * FROM business_documents WHERE business_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
      [businessId],
    );
    return rows.map(toRecord);
  }

  async countByBusiness(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT count(*)::int AS count FROM business_documents WHERE business_id = $1 AND deleted_at IS NULL',
      [businessId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Soft delete - never a hard DELETE. Returns false for a cross-tenant or already-deleted id, identical to a nonexistent one. */
  async softDeleteForBusiness(id: string, businessId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE business_documents SET deleted_at = now(), updated_at = now() WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
      [id, businessId],
    );
    return (rowCount ?? 0) > 0;
  }

  async createVersion(input: CreateDocumentVersionInput): Promise<BusinessDocumentVersionRecord> {
    const { rows } = await this.db.query<BusinessDocumentVersionRow>(
      `INSERT INTO business_document_versions
         (business_id, document_id, version_number, checksum, mime_type, mime_family, file_size, storage_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.businessId,
        input.documentId,
        input.versionNumber,
        input.checksum,
        input.mimeType,
        input.mimeFamily,
        input.fileSize,
        input.storageReference,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('business_document_versions insert returned no row');
    return toVersionRecord(row);
  }

  /** Tenant-scoped: a version belonging to another business's document is never returned, matching the parent table's own rule. */
  async findVersionForBusiness(versionId: string, businessId: string): Promise<BusinessDocumentVersionRecord | null> {
    const { rows } = await this.db.query<BusinessDocumentVersionRow>(
      'SELECT * FROM business_document_versions WHERE id = $1 AND business_id = $2',
      [versionId, businessId],
    );
    return rows[0] ? toVersionRecord(rows[0]) : null;
  }

  // --- D2: parsing lifecycle ---

  /**
   * Ingestion (D1) and AI retrieval are two separate security boundaries -
   * nothing below this line ever touches ai_retrievable/ai_sendable/
   * customer_visible/human_only. A document reaching 'ready' here means
   * "chunked and indexed," never "available to the AI."
   */
  async markVersionParsing(businessId: string, versionId: string): Promise<void> {
    await this.db.query(
      `UPDATE business_document_versions SET parser_status = 'parsing' WHERE id = $1 AND business_id = $2`,
      [versionId, businessId],
    );
  }

  async markVersionParsed(businessId: string, versionId: string, contentHash: string): Promise<void> {
    await this.db.query(
      `UPDATE business_document_versions
       SET parser_status = 'parsed', extraction_status = 'extracted', indexing_status = 'chunked', content_hash = $3
       WHERE id = $1 AND business_id = $2`,
      [versionId, businessId, contentHash],
    );
  }

  /** failureReason is always a sanitized category string (see documentParsers.ts) - never a raw exception message or document content. */
  async markVersionFailed(businessId: string, versionId: string, failureReason: string): Promise<void> {
    await this.db.query(
      `UPDATE business_document_versions
       SET parser_status = 'failed', extraction_status = 'failed', failure_reason = $3
       WHERE id = $1 AND business_id = $2`,
      [versionId, businessId, failureReason],
    );
  }

  async markDocumentProcessing(businessId: string, documentId: string): Promise<void> {
    await this.db.query(
      `UPDATE business_documents SET status = 'processing', updated_at = now() WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
      [documentId, businessId],
    );
  }

  /**
   * Guarded by construction, not by a separate pre-check: this UPDATE only
   * ever matches a row that is (a) not soft-deleted and (b) still pointing
   * at exactly the version this job parsed - a document deleted mid-parse,
   * or (once a future phase allows re-uploading a new version) a version
   * that changed mid-parse, both simply fail to match and this becomes a
   * documented no-op, never a status flip on a document that moved on.
   * Returns whether the transition actually happened.
   */
  async markDocumentReadyIfCurrentVersion(businessId: string, documentId: string, expectedVersionId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE business_documents
       SET status = 'ready', updated_at = now()
       WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL AND current_version_id = $3`,
      [documentId, businessId, expectedVersionId],
    );
    return (rowCount ?? 0) > 0;
  }

  async markDocumentFailedIfCurrentVersion(businessId: string, documentId: string, expectedVersionId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE business_documents
       SET status = 'failed', updated_at = now()
       WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL AND current_version_id = $3`,
      [documentId, businessId, expectedVersionId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Each chunk's checksum is computed by the caller (Node crypto, same as every other checksum in this system - business_document_versions.checksum, whatsapp_media.sha256) - no new Postgres extension (pgcrypto) is introduced just for this. */
  async createChunks(input: { businessId: string; documentId: string; versionId: string; chunks: DocumentChunkInput[] }): Promise<number> {
    if (input.chunks.length === 0) return 0;
    const values: string[] = [];
    const params: unknown[] = [];
    input.chunks.forEach((chunk, index) => {
      const base = index * 8;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
      );
      params.push(
        input.businessId,
        input.documentId,
        input.versionId,
        chunk.sequence,
        chunk.text,
        chunk.charStart,
        chunk.charEnd,
        chunk.checksum,
      );
    });
    const { rowCount } = await this.db.query(
      `INSERT INTO business_document_chunks (business_id, document_id, version_id, sequence, text, char_start, char_end, checksum)
       VALUES ${values.join(', ')}`,
      params,
    );
    return rowCount ?? 0;
  }

  async countChunksForVersion(businessId: string, versionId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT count(*)::int AS count FROM business_document_chunks WHERE version_id = $1 AND business_id = $2',
      [versionId, businessId],
    );
    return Number(rows[0]?.count ?? 0);
  }
}

export interface DocumentChunkInput {
  sequence: number;
  text: string;
  charStart: number;
  charEnd: number;
  checksum: string;
}
