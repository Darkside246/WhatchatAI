import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/services/documents/documentChunker.js';

describe('chunkText (deterministic, non-AI - Phase B D2)', () => {
  it('produces no chunks for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n   ')).toEqual([]);
  });

  it('keeps a short document as a single chunk', () => {
    const chunks = chunkText('A short paragraph of real content.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('A short paragraph of real content.');
    expect(chunks[0]?.sequence).toBe(0);
  });

  it('packs multiple short paragraphs into as few chunks as fit, in order', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkText(text, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('First paragraph.');
    expect(chunks[0]?.text).toContain('Third paragraph.');
  });

  it('starts a new chunk once the running text would exceed maxChunkChars', () => {
    const text = `${'a'.repeat(40)}\n\n${'b'.repeat(40)}`;
    const chunks = chunkText(text, 50);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.text.length <= 50)).toBe(true);
    // Sequence numbers are contiguous starting at 0.
    expect(chunks.map((c) => c.sequence)).toEqual(chunks.map((_, i) => i));
  });

  it('splits a single paragraph that alone exceeds maxChunkChars into bounded windows - never one unbounded chunk', () => {
    const hugeParagraph = 'x'.repeat(10_000);
    const chunks = chunkText(hugeParagraph, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 500)).toBe(true);
    // No content lost - concatenating the windows reproduces the source.
    expect(chunks.map((c) => c.text).join('')).toBe(hugeParagraph);
  });

  it('never produces more than the hard chunk-count ceiling, regardless of how many tiny paragraphs the source contains', () => {
    // 5000 one-character paragraphs - each below maxChunkChars alone, but
    // far more of them than the ceiling allows once packing stops helping.
    const manyTinyParagraphs = Array.from({ length: 5000 }, (_, i) => String(i % 10)).join('\n\n');
    const chunks = chunkText(manyTinyParagraphs, 1);
    expect(chunks.length).toBeLessThanOrEqual(2000);
  });
});
