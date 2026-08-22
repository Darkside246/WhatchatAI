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

export interface BusinessDocumentVersionRecord {
  id: string;
  businessId: string;
  documentId: string;
  versionNumber: number;
  checksum: string;
  mimeType: string;
  mimeFamily: string;
  fileSize: number;
  storageReference: string;
  createdAt: string;
}

interface BusinessDocumentVersionRow {
  id: string;
  business_id: string;
  document_id: string;
  version_number: number;
  checksum: string;
  mime_type: string;
  mime_family: string;
  file_size: string;
  storage_reference: string;
  created_at: string;
}

function toVersionRecord(row: BusinessDocumentVersionRow): BusinessDocumentVersionRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    documentId: row.document_id,
    versionNumber: row.version_number,
    checksum: row.checksum,
    mimeType: row.mime_type,
    mimeFamily: row.mime_family,
    fileSize: Number(row.file_size),
    storageReference: row.storage_reference,
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
}
