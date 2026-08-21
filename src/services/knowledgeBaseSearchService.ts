import { pool } from '../db/pool.js';
import { KnowledgeBaseRepository } from '../repositories/knowledgeBaseRepository.js';

export interface KnowledgeBaseResult {
  documentId: string;
  title: string;
  snippet: string;
  score: number;
}

export interface KnowledgeBaseSearchResult {
  available: boolean;
  results: KnowledgeBaseResult[];
  reason: string | null;
}

const knowledgeBaseRepository = new KnowledgeBaseRepository(pool);

const MAX_RESULTS = 3;
/** Keeps a matched document's excerpt bounded in the AI prompt - the full document is never dumped into context. */
const SNIPPET_LENGTH = 400;

/**
 * Real Postgres full-text search (see knowledge_base_documents' generated
 * tsvector column and its GIN index) against the business's own uploaded
 * documents. `available: false` means the search itself failed (e.g. a
 * real database error) - a real search that simply found nothing is
 * `available: true, results: []`, never conflated with unavailability.
 */
export async function searchKnowledgeBase(businessId: string, queryText: string): Promise<KnowledgeBaseSearchResult> {
  if (!queryText.trim()) {
    return { available: true, results: [], reason: null };
  }

  try {
    const rows = await knowledgeBaseRepository.search(businessId, queryText, MAX_RESULTS);
    return {
      available: true,
      results: rows.map((row) => ({
        documentId: row.id,
        title: row.title,
        snippet: row.content.length > SNIPPET_LENGTH ? `${row.content.slice(0, SNIPPET_LENGTH)}...` : row.content,
        score: row.rank,
      })),
      reason: null,
    };
  } catch (error) {
    console.error('[KnowledgeBaseSearchService] Search failed:', error);
    return {
      available: false,
      results: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
