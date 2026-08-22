import { PDFParse, PasswordException, InvalidPDFException } from 'pdf-parse';
import mammoth from 'mammoth';
import type { DocumentMimeFamily } from '../../domain/documents/documentMime.js';

export type DocumentParseFailureReason =
  | 'corrupted_or_unreadable'
  | 'password_protected'
  | 'unsupported_format'
  | 'extracted_text_too_large'
  | 'timeout'
  | 'empty_extracted_text';

export type DocumentParseResult =
  | { status: 'success'; text: string }
  | { status: 'failed'; reason: DocumentParseFailureReason };

// Bounds the extracted text, independent of the source file's own size -
// this is what actually defends against a small-file/huge-output
// expansion attack (e.g. a DOCX, itself a zip archive, crafted to
// decompress into a large amount of text), not merely a size check on
// the uploaded bytes (already covered separately in documentService.ts).
const MAX_EXTRACTED_TEXT_CHARS = 2_000_000;

// A wall-clock ceiling around each parse call. This runs inside the
// dedicated documentParseWorker process (already isolated from the API
// server, matching this codebase's existing worker-process boundaries -
// see documentParseWorker.ts), not a full OS-level sandbox with its own
// enforced memory ceiling per job. Disclosed explicitly as a residual
// risk in the Phase B D2 report: a parser bug causing a genuine
// synchronous infinite loop (as opposed to a slow-but-eventually-
// rejecting async call, which both pdf-parse and mammoth are written to
// produce for malformed input) would stall this worker process
// specifically, not the API server, recoverable by process restart.
const PARSE_TIMEOUT_MS = 30_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('__PARSE_TIMEOUT__')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function boundedResult(text: string): DocumentParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { status: 'failed', reason: 'empty_extracted_text' };
  // Failure, not silent truncation - a truncated-but-marked-success
  // document would misrepresent what was actually understood (the same
  // "never fabricate a parsed state" rule already governing parser_status).
  if (trimmed.length > MAX_EXTRACTED_TEXT_CHARS) return { status: 'failed', reason: 'extracted_text_too_large' };
  return { status: 'success', text: trimmed };
}

async function parsePdf(buffer: Buffer, timeoutMs: number): Promise<DocumentParseResult> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await withTimeout(parser.getText(), timeoutMs);
    return boundedResult(result.text);
  } catch (error) {
    if (error instanceof Error && error.message === '__PARSE_TIMEOUT__') return { status: 'failed', reason: 'timeout' };
    if (error instanceof PasswordException) return { status: 'failed', reason: 'password_protected' };
    if (error instanceof InvalidPDFException) return { status: 'failed', reason: 'corrupted_or_unreadable' };
    // Any other parser exception - never re-thrown, never logged with its
    // raw message (which can embed fragments of the file's own bytes).
    return { status: 'failed', reason: 'corrupted_or_unreadable' };
  } finally {
    await parser.destroy?.().catch(() => undefined);
  }
}

async function parseDocx(buffer: Buffer, timeoutMs: number): Promise<DocumentParseResult> {
  try {
    const result = await withTimeout(mammoth.extractRawText({ buffer }), timeoutMs);
    return boundedResult(result.value);
  } catch (error) {
    if (error instanceof Error && error.message === '__PARSE_TIMEOUT__') return { status: 'failed', reason: 'timeout' };
    return { status: 'failed', reason: 'corrupted_or_unreadable' };
  }
}

async function parsePlainText(buffer: Buffer): Promise<DocumentParseResult> {
  try {
    const text = buffer.toString('utf8');
    return boundedResult(text);
  } catch {
    return { status: 'failed', reason: 'corrupted_or_unreadable' };
  }
}

/**
 * Dispatches by the already-normalized document MIME family (§ D1's
 * documentMime.ts) - never by re-inspecting the raw, uploader-declared
 * MIME type. A mismatch between the declared MIME and the file's real
 * bytes (filename/MIME spoofing) surfaces here as an ordinary parse
 * failure (e.g. plain text bytes fail PDF structural validation), never
 * as a misinterpretation - the parser for the *declared* family is
 * always the one that runs, and it either succeeds on real content of
 * that type or fails safely.
 */
export async function parseDocument(
  mimeFamily: DocumentMimeFamily,
  buffer: Buffer,
  timeoutMs: number = PARSE_TIMEOUT_MS,
): Promise<DocumentParseResult> {
  switch (mimeFamily) {
    case 'pdf':
      return parsePdf(buffer, timeoutMs);
    case 'docx':
      return parseDocx(buffer, timeoutMs);
    case 'text':
    case 'csv':
      return parsePlainText(buffer);
    default:
      return { status: 'failed', reason: 'unsupported_format' };
  }
}
