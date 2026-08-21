import type { Queryable } from './types.js';

export interface KnowledgeBaseDocumentRecord {
  id: string;
  businessId: string;
  createdBy: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface KnowledgeBaseDocumentRow {
  id: string;
  business_id: string;
  created_by: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

function toRecord(row: KnowledgeBaseDocumentRow): KnowledgeBaseDocumentRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    createdBy: row.created_by,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface KnowledgeBaseSearchRow {
  id: string;
  title: string;
  content: string;
  rank: number;
}

export class KnowledgeBaseRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: { businessId: string; createdBy: string; title: string; content: string }): Promise<KnowledgeBaseDocumentRecord> {
    const { rows } = await this.db.query<KnowledgeBaseDocumentRow>(
      `INSERT INTO knowledge_base_documents (business_id, created_by, title, content) VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.businessId, input.createdBy, input.title, input.content],
    );
    const row = rows[0];
    if (!row) throw new Error('knowledge_base_documents insert returned no row');
    return toRecord(row);
  }

  async findByIdForBusiness(businessId: string, id: string): Promise<KnowledgeBaseDocumentRecord | null> {
    const { rows } = await this.db.query<KnowledgeBaseDocumentRow>(
      'SELECT * FROM knowledge_base_documents WHERE id = $1 AND business_id = $2',
      [id, businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForBusiness(businessId: string): Promise<KnowledgeBaseDocumentRecord[]> {
    const { rows } = await this.db.query<KnowledgeBaseDocumentRow>(
      'SELECT * FROM knowledge_base_documents WHERE business_id = $1 ORDER BY created_at DESC',
      [businessId],
    );
    return rows.map(toRecord);
  }

  async countByBusiness(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT count(*)::int AS count FROM knowledge_base_documents WHERE business_id = $1',
      [businessId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async update(businessId: string, id: string, title: string, content: string): Promise<KnowledgeBaseDocumentRecord | null> {
    const { rows } = await this.db.query<KnowledgeBaseDocumentRow>(
      `UPDATE knowledge_base_documents SET title = $3, content = $4, updated_at = now() WHERE id = $1 AND business_id = $2 RETURNING *`,
      [id, businessId, title, content],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async remove(businessId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM knowledge_base_documents WHERE id = $1 AND business_id = $2', [id, businessId]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Real Postgres full-text search (GIN-indexed tsvector, no external
   * embeddings API, no new database extension) - title matches rank higher
   * than body matches (see the generated column's setweight in the
   * migration), ordered by ts_rank, capped to `limit`.
   *
   * The query terms are OR-combined, not AND-combined: `plainto_tsquery`
   * (Postgres's default for a plain-text query) ANDs every term together,
   * which is wrong for this use case - the AI passes a whole natural-
   * language customer message as the query (e.g. "how long does shipping
   * take"), and requiring every one of those words to appear in a short
   * business document would silently exclude real, relevant matches
   * (verified empirically: `plainto_tsquery` against "Standard shipping
   * takes 5 to 7 business days" returned zero results for that exact
   * query). `strip(to_tsvector(...))` reduces the query to its own
   * stemmed lexemes with duplicates/positions removed, and the
   * regexp_replace turns the whitespace between them into the `|` (OR)
   * tsquery operator - a standard, documented Postgres idiom - so a
   * document matching any significant query term is found, ranked by how
   * many terms it actually matches.
   */
  async search(businessId: string, queryText: string, limit: number): Promise<KnowledgeBaseSearchRow[]> {
    const { rows } = await this.db.query<{ id: string; title: string; content: string; rank: number }>(
      `SELECT id, title, content, ts_rank(search_vector, query) AS rank
       FROM knowledge_base_documents,
            to_tsquery('english', regexp_replace(strip(to_tsvector('english', $2))::text, '\\s+', ' | ', 'g')) AS query
       WHERE business_id = $1 AND search_vector @@ query
       ORDER BY rank DESC
       LIMIT $3`,
      [businessId, queryText, limit],
    );
    return rows;
  }
}
