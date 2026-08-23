import { pool } from '../db/pool.js';
import { BusinessDocumentRepository } from '../repositories/businessDocumentRepository.js';

export interface DocumentSearchResult {
  documentId: string;
  versionId: string;
  filename: string;
  snippet: string;
  score: number;
}

export interface DocumentSearchResponse {
  available: boolean;
  results: DocumentSearchResult[];
  reason: string | null;
}

const documentRepository = new BusinessDocumentRepository(pool);

const MAX_RESULTS = 10;
const SNIPPET_LENGTH = 1000;
export const MAX_QUERY_LENGTH = 500;

/**
 * Human document search - scoped to the authenticated business, gated by
 * the caller's own application permission (see the route), never by
 * ai_retrievable. Reuses the same Postgres full-text search
 * infrastructure (generated tsvector, GIN index, parameterized query
 * construction) knowledgeBaseSearchService.ts already proves works, and
 * the same {available, results, reason} contract so a real search
 * failure is never conflated with a real, honest empty result.
 */
export async function searchBusinessDocuments(businessId: string, queryText: string): Promise<DocumentSearchResponse> {
  const trimmed = queryText.trim();
  if (!trimmed) return { available: true, results: [], reason: null };
  if (trimmed.length > MAX_QUERY_LENGTH) {
    return { available: false, results: [], reason: `Query exceeds the maximum length of ${MAX_QUERY_LENGTH} characters.` };
  }

  try {
    const rows = await documentRepository.searchReadyDocumentChunksForBusiness(businessId, trimmed, MAX_RESULTS);
    return {
      available: true,
      results: rows.map((row) => ({
        documentId: row.documentId,
        versionId: row.versionId,
        filename: row.filename,
        snippet: row.text.length > SNIPPET_LENGTH ? `${row.text.slice(0, SNIPPET_LENGTH)}...` : row.text,
        score: row.rank,
      })),
      reason: null,
    };
  } catch (error) {
    console.error('[DocumentSearchService] Search failed:', error);
    return {
      available: false,
      results: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
