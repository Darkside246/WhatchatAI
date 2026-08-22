/**
 * Deterministic, non-AI chunking - splits extracted document text into
 * bounded windows for full-text indexing (business_document_chunks).
 * No page/heading awareness yet (that's real future refinement, not a
 * D2 requirement) - this greedily packs paragraphs (blank-line-
 * separated) into chunks up to maxChunkChars, splitting any single
 * paragraph that alone exceeds the limit into fixed-size windows so no
 * chunk is ever unbounded regardless of the source document's shape.
 */
export interface DocumentChunk {
  sequence: number;
  text: string;
  charStart: number;
  charEnd: number;
}

const DEFAULT_MAX_CHUNK_CHARS = 1500;
// A second, independent bound - even bounded-size chunks could still
// number in the tens of thousands for a large-enough extracted text
// (already capped at MAX_EXTRACTED_TEXT_CHARS in documentParsers.ts,
// but this is a second, cheap defense at the chunk-count level).
const MAX_CHUNKS_PER_VERSION = 2000;

export function chunkText(text: string, maxChunkChars: number = DEFAULT_MAX_CHUNK_CHARS): DocumentChunk[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: DocumentChunk[] = [];
  let cursor = 0;
  let currentText = '';
  let currentStart = 0;

  function flush(): void {
    const trimmed = currentText.trim();
    if (trimmed.length > 0) {
      chunks.push({ sequence: chunks.length, text: trimmed, charStart: currentStart, charEnd: currentStart + currentText.length });
    }
    currentText = '';
  }

  for (const paragraph of paragraphs) {
    const paragraphStart = cursor;
    cursor += paragraph.length + 2; // account for the removed \n\s*\n separator length (approximate, fine for citation purposes only)

    if (paragraph.length > maxChunkChars) {
      flush();
      for (let offset = 0; offset < paragraph.length; offset += maxChunkChars) {
        const windowText = paragraph.slice(offset, offset + maxChunkChars).trim();
        if (windowText.length > 0) {
          chunks.push({
            sequence: chunks.length,
            text: windowText,
            charStart: paragraphStart + offset,
            charEnd: paragraphStart + Math.min(offset + maxChunkChars, paragraph.length),
          });
        }
        if (chunks.length >= MAX_CHUNKS_PER_VERSION) return chunks;
      }
      currentStart = cursor;
      continue;
    }

    if (currentText.length === 0) currentStart = paragraphStart;
    const candidate = currentText.length === 0 ? paragraph : `${currentText}\n\n${paragraph}`;
    if (candidate.length > maxChunkChars) {
      flush();
      currentStart = paragraphStart;
      currentText = paragraph;
    } else {
      currentText = candidate;
    }

    if (chunks.length >= MAX_CHUNKS_PER_VERSION) return chunks;
  }
  flush();

  return chunks.slice(0, MAX_CHUNKS_PER_VERSION);
}
