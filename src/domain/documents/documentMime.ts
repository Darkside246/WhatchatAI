import { normalizeMimeType } from '../whatsapp/mimeType.js';

/**
 * D1's explicit MIME allow-list for business documents - deliberately
 * narrower than the WhatsApp media pipeline's "store anything, gate
 * inline display" model (mediaCompatibility.ts). This pipeline parses
 * and extracts text server-side (in a later phase), so unsupported
 * types are rejected up front rather than stored and left unusable.
 *
 * This is its own, document-specific classification - deliberately not
 * a reuse of mediaCompatibility.ts's classifyMimeFamily(), which
 * answers a different question ("image/video/audio/sticker/other" for
 * WhatsApp media) than the one document parsing needs
 * ("pdf/docx/text/csv", the actual parser-dispatch families).
 */
export type DocumentMimeFamily = 'pdf' | 'docx' | 'text' | 'csv';

const DOCUMENT_MIME_TO_FAMILY: Readonly<Record<string, DocumentMimeFamily>> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'text',
  'text/csv': 'csv',
};

export const DOCUMENT_ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set(Object.keys(DOCUMENT_MIME_TO_FAMILY));

/** Normalizes before comparing, so `application/pdf; charset=utf-8` is recognized exactly like `application/pdf`. */
export function isAllowedDocumentMime(mimeType: string | null | undefined): boolean {
  return DOCUMENT_ALLOWED_MIME_TYPES.has(normalizeMimeType(mimeType));
}

export function classifyDocumentMimeFamily(mimeType: string | null | undefined): DocumentMimeFamily | null {
  return DOCUMENT_MIME_TO_FAMILY[normalizeMimeType(mimeType)] ?? null;
}
