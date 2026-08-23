import { pool } from '../db/pool.js';
import { BusinessDocumentRepository } from '../repositories/businessDocumentRepository.js';

export interface AiDocumentContextResult {
  documentTitle: string;
  documentId: string;
  versionId: string;
  text: string;
  score: number;
}

export interface AiDocumentRetrievalResponse {
  available: boolean;
  results: AiDocumentContextResult[];
  reason: string | null;
}

const documentRepository = new BusinessDocumentRepository(pool);

const MAX_CHUNKS = 3;
const MAX_CHUNK_CHARS = 500;
export const MAX_QUERY_LENGTH = 500;

/**
 * D3-C: built and adversarially tested, but NOT wired into
 * aiContextGathererService.ts, buildSystemInstruction(), or any live
 * Gemini/tool call path - that wiring is D4's own, separately-approved
 * decision (see docs/PHASE_D3B_SEARCH_RETRIEVAL_PROPOSAL.md §6.2, §7).
 * Nothing in this file is imported by anything outside this module and
 * its own tests as of this commit.
 *
 * Fails closed by construction, not by convention: the only repository
 * method this ever calls is searchAiRetrievableDocumentChunksForBusiness,
 * which structurally requires business_id, deleted_at IS NULL,
 * status='ready', current_version_id=version_id, AND ai_retrievable=true
 * inside its own SQL join - there is no code path here that could widen,
 * retry with different scope, or fall back to a broader/global/human
 * search. Any failure (bad input, a real DB error) returns
 * {available:false, results:[]} - never a partial or best-effort result,
 * and never an exception that could crash a caller expecting a document-
 * context field to always be present.
 */
export async function retrieveAiDocumentContext(businessId: string, queryText: string): Promise<AiDocumentRetrievalResponse> {
  const trimmed = queryText.trim();
  if (!trimmed) return { available: true, results: [], reason: null };
  if (trimmed.length > MAX_QUERY_LENGTH) {
    return { available: false, results: [], reason: `Query exceeds the maximum length of ${MAX_QUERY_LENGTH} characters.` };
  }

  try {
    const rows = await documentRepository.searchAiRetrievableDocumentChunksForBusiness(businessId, trimmed, MAX_CHUNKS);
    return {
      available: true,
      results: rows.map((row) => ({
        // filename stands in for a document title - business_documents
        // has no separate title field (see the D3-B proposal, §14).
        documentTitle: row.filename,
        documentId: row.documentId,
        versionId: row.versionId,
        // Bounded independently of the chunker's own ~1500-char ceiling
        // (D2) - this is the prompt-token-budget bound, matching
        // knowledgeBaseSearchService.SNIPPET_LENGTH's precedent, not a
        // signal that the underlying chunk was unbounded.
        text: row.text.length > MAX_CHUNK_CHARS ? row.text.slice(0, MAX_CHUNK_CHARS) : row.text,
        score: row.rank,
      })),
      reason: null,
    };
  } catch (error) {
    // Never a raw database error object, never a stack trace with a
    // storage path - a plain message string only, matching the same
    // discipline documentParsers.ts already applies to parse failures.
    console.error('[AiDocumentRetrievalService] Retrieval failed:', error);
    return {
      available: false,
      results: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
