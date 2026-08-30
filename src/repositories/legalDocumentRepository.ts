import type { Queryable } from './types.js';

export type LegalDocumentType = 'TERMS' | 'PRIVACY';

export type LegalDocumentRecord = {
  id: string;
  documentType: LegalDocumentType;
  version: string;
  title: string;
  contentHtml: string;
  effectiveAt: string;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
};

export class LegalDocumentRepository {
  constructor(private readonly db: Queryable) {}

  async getActive(type: LegalDocumentType): Promise<LegalDocumentRecord | null> {
    const result = await this.db.query(
      `SELECT id, document_type, version, title, content_html, effective_at, is_active, created_by, created_at
       FROM legal_documents WHERE document_type = $1 AND is_active = true LIMIT 1`,
      [type],
    );
    return result.rows[0] ? this.map(result.rows[0] as Record<string, unknown>) : null;
  }

  async listAll(): Promise<LegalDocumentRecord[]> {
    const result = await this.db.query(
      `SELECT id, document_type, version, title, content_html, effective_at, is_active, created_by, created_at
       FROM legal_documents ORDER BY document_type, effective_at DESC`,
    );
    return result.rows.map((r) => this.map(r as Record<string, unknown>));
  }

  async publish(input: {
    type: LegalDocumentType;
    version: string;
    title: string;
    contentHtml: string;
    createdBy?: string;
  }): Promise<LegalDocumentRecord> {
    await this.db.query(
      `UPDATE legal_documents SET is_active = false WHERE document_type = $1 AND is_active = true`,
      [input.type],
    );
    const result = await this.db.query(
      `INSERT INTO legal_documents (document_type, version, title, content_html, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, document_type, version, title, content_html, effective_at, is_active, created_by, created_at`,
      [input.type, input.version, input.title, input.contentHtml, input.createdBy ?? null],
    );
    return this.map(result.rows[0] as Record<string, unknown>);
  }

  private map(row: Record<string, unknown>): LegalDocumentRecord {
    return {
      id: row['id'] as string,
      documentType: row['document_type'] as LegalDocumentType,
      version: row['version'] as string,
      title: row['title'] as string,
      contentHtml: row['content_html'] as string,
      // The pool's global timestamp type parser (src/db/pool.ts) already
      // converts timestamp/timestamptz columns to ISO strings - these are
      // never real Date objects, so calling .toISOString() on them threw.
      effectiveAt: row['effective_at'] as string,
      isActive: row['is_active'] as boolean,
      createdBy: row['created_by'] as string | null,
      createdAt: row['created_at'] as string,
    };
  }
}
