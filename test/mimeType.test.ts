import { describe, expect, it } from 'vitest';
import { normalizeMimeType } from '../src/domain/whatsapp/mimeType.js';

describe('normalizeMimeType (strips parameters, trims, lowercases - the real WhatsApp voice-note regression fixture)', () => {
  it('leaves an already-bare MIME type unchanged', () => {
    expect(normalizeMimeType('audio/ogg')).toBe('audio/ogg');
    expect(normalizeMimeType('audio/mpeg')).toBe('audio/mpeg');
  });

  // The real WhatsApp/Baileys voice-note value - this is the fixture that
  // exposed the original bug (an exact-match Set lookup against 'audio/ogg'
  // silently rejecting every real voice note) and must never regress.
  it('strips the codec parameter from the real WhatsApp voice-note mimeType', () => {
    expect(normalizeMimeType('audio/ogg; codecs=opus')).toBe('audio/ogg');
  });

  it('strips a parameter with no space after the semicolon', () => {
    expect(normalizeMimeType('audio/ogg;codecs=opus')).toBe('audio/ogg');
  });

  it('normalizes case', () => {
    expect(normalizeMimeType('AUDIO/OGG; codecs=opus')).toBe('audio/ogg');
  });

  it('trims stray whitespace around the semicolon', () => {
    expect(normalizeMimeType('audio/ogg ; codecs=opus')).toBe('audio/ogg');
  });

  it('handles an arbitrary parameter name, not just codecs', () => {
    expect(normalizeMimeType('audio/mpeg; something=value')).toBe('audio/mpeg');
  });

  it('returns an empty string for null/undefined, never throwing', () => {
    expect(normalizeMimeType(null)).toBe('');
    expect(normalizeMimeType(undefined)).toBe('');
  });
});
