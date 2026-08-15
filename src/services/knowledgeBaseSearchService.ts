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

/**
 * Knowledge Base vector search has no real backend yet (no embeddings store,
 * no ingestion pipeline - a later phase). Per the project's no-fabricated-data
 * rule, this honestly reports unavailability with zero results rather than
 * inventing retrieved documents. Callers (the AI context gatherer) treat
 * `available: false` as "no KB context for this turn," not an error.
 */
export async function searchKnowledgeBase(
  _businessId: string,
  _queryText: string,
): Promise<KnowledgeBaseSearchResult> {
  return {
    available: false,
    results: [],
    reason: 'Knowledge base vector search backend is not yet implemented for this business.',
  };
}
