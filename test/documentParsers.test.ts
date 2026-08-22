import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A minimal, hand-built, spec-valid one-page PDF ("Hello World") - real
 * bytes a real PDF parser accepts, not a fabricated stand-in. Built once
 * here rather than committing a binary fixture, since the construction
 * itself is small, deterministic, and reviewable.
 */
function buildMinimalValidPdf(): Buffer {
  const objs: string[] = [];
  objs[1] = '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n';
  objs[2] = '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n';
  objs[3] =
    '3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 200 100]/Contents 5 0 R>>endobj\n';
  objs[4] = '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n';
  const stream = 'BT /F1 18 Tf 10 50 Td (Hello World) Tj ET';
  objs[5] = `5 0 obj<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += objs[i];
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i += 1) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer<</Size 6/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

// Real DOCX fixture, copied from mammoth's own published test-data
// (node_modules/mammoth/test/test-data/single-paragraph.docx) - a real,
// valid zip-structured DOCX, not a fabricated one.
const validDocxPath = path.join(__dirname, 'fixtures/documents/single-paragraph.docx');

describe('documentParsers (Phase B D2 - real parser libraries, real malicious/malformed inputs)', () => {
  it('parses a real, valid PDF successfully', async () => {
    const { parseDocument } = await import('../src/services/documents/documentParsers.js');
    const result = await parseDocument('pdf', buildMinimalValidPdf());
    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.text).toContain('Hello World');
  });

  it('parses a real, valid DOCX successfully', async () => {
    const { parseDocument } = await import('../src/services/documents/documentParsers.js');
    const buffer = readFileSync(validDocxPath);
    const result = await parseDocument('docx', buffer);
    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.text.length).toBeGreaterThan(0);
  });

  it('parses plain text and CSV directly (no library needed)', async () => {
    const { parseDocument } = await import('../src/services/documents/documentParsers.js');
    const textResult = await parseDocument('text', Buffer.from('Hello, this is real plain text content.', 'utf8'));
    expect(textResult.status).toBe('success');
    const csvResult = await parseDocument('csv', Buffer.from('name,value\nfoo,1\nbar,2', 'utf8'));
    expect(csvResult.status).toBe('success');
  });

  it('a corrupted PDF (garbage bytes with a PDF-looking header) fails safely - never throws, never fabricates a "parsed" state', async () => {
    const { parseDocument } = await import('../src/services/documents/documentParsers.js');
    const garbage = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0x00, 0xff, 0x13, 0x37, 0xde, 0xad, 0xbe, 0xef])]);
    const result = await parseDocument('pdf', garbage);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('corrupted_or_unreadable');
  });

  it('a corrupted DOCX (garbage bytes, not a real zip) fails safely', async () => {
    const { parseDocument } = await import('../src/services/documents/documentParsers.js');
    const garbage = Buffer.from('this is not a zip archive at all, just plain garbage bytes');
    const result = await parseDocument('docx', garbage);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('corrupted_or_unreadable');
  });

  it('a MIME/content mismatch (real plain-text bytes declared as PDF) fails safely rather than being misinterpreted', async () => {
    const { parseDocument } = await import('../src/services/documents/documentParsers.js');
    const plainTextBytes = Buffer.from('This is just an ordinary text file, not a PDF at all.', 'utf8');
    const result = await parseDocument('pdf', plainTextBytes);
    expect(result.status).toBe('failed');
  });

  it('an empty (whitespace-only) extracted result is a real failure, not an empty success', async () => {
    const { parseDocument } = await import('../src/services/documents/documentParsers.js');
    const result = await parseDocument('text', Buffer.from('   \n\n   \t  ', 'utf8'));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('empty_extracted_text');
  });

  it('extracted text far exceeding the maximum size is a real failure, never a silent truncation pretending to be complete', async () => {
    const { parseDocument } = await import('../src/services/documents/documentParsers.js');
    const huge = Buffer.from('a'.repeat(2_100_000), 'utf8');
    const result = await parseDocument('text', huge);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('extracted_text_too_large');
  });

  it('an unrecognized document family fails safely rather than guessing a parser', async () => {
    const { parseDocument } = await import('../src/services/documents/documentParsers.js');
    // @ts-expect-error - deliberately an invalid family, proving the fallback branch
    const result = await parseDocument('unknown', Buffer.from('x'));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('unsupported_format');
  });

  it('a real PasswordException from the parser library is categorized as password_protected, not a generic corruption', async () => {
    // Verifies documentParsers.ts's own dispatch/categorization branch
    // using the library's real, native exception class (not a fabricated
    // shape) - not a hand-crafted encrypted PDF byte fixture, which would
    // require re-implementing the PDF standard security handler by hand.
    // The library's own published test suite already covers genuine
    // encrypted-PDF parsing behavior (see pdf-parse's README).
    vi.resetModules();
    vi.doMock('pdf-parse', async () => {
      const actual = await vi.importActual<typeof import('pdf-parse')>('pdf-parse');
      class ThrowingPDFParse {
        async getText(): Promise<never> {
          throw new actual.PasswordException('encrypted, no password supplied');
        }
        async destroy(): Promise<void> {}
      }
      return { ...actual, PDFParse: ThrowingPDFParse };
    });

    const { parseDocument } = await import('../src/services/documents/documentParsers.js');
    const result = await parseDocument('pdf', Buffer.from('irrelevant'));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('password_protected');

    vi.doUnmock('pdf-parse');
    vi.resetModules();
  });

  it('a parser call that hangs indefinitely is force-failed by the enforced wall-clock timeout, never left to hang the caller', async () => {
    vi.resetModules();
    vi.doMock('pdf-parse', async () => {
      const actual = await vi.importActual<typeof import('pdf-parse')>('pdf-parse');
      class HangingPDFParse {
        async getText(): Promise<never> {
          return new Promise<never>(() => {}); // never resolves or rejects
        }
        async destroy(): Promise<void> {}
      }
      return { ...actual, PDFParse: HangingPDFParse };
    });

    const { parseDocument } = await import('../src/services/documents/documentParsers.js');
    const start = Date.now();
    const result = await parseDocument('pdf', Buffer.from('irrelevant'), 50);
    const elapsed = Date.now() - start;

    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toBe('timeout');
    // The timeout, not the (nonexistent) real completion, is what ended this call.
    expect(elapsed).toBeLessThan(2000);

    vi.doUnmock('pdf-parse');
    vi.resetModules();
  });
});
