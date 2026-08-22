import { describe, expect, it } from 'vitest';
import {
  isSupportedMime,
  resolveMediaType,
  resolveExtension,
  canPreview,
  canStream,
  canDownload,
  requiresConversion,
  requiresThumbnail,
  requiresTranscoding,
  classifyMimeFamily,
  isInlineSafeMime,
} from '../src/domain/whatsapp/mediaCompatibility.js';
import { normalizeMimeType } from '../src/domain/whatsapp/mimeType.js';

describe('MediaCompatibilityService (real MIME-driven decisions, no guessing)', () => {
  it('treats any real MIME type as supported, and a missing one as unsupported', () => {
    expect(isSupportedMime('image/jpeg')).toBe(true);
    expect(isSupportedMime('application/x-totally-unknown-format')).toBe(true);
    expect(isSupportedMime(null)).toBe(false);
  });

  it('resolves the real WhatsApp content type, defaulting unknown types to document rather than fabricating one', () => {
    expect(resolveMediaType('image')).toBe('image');
    expect(resolveMediaType('video')).toBe('video');
    expect(resolveMediaType('voice_note')).toBe('voice_note');
    expect(resolveMediaType('sticker')).toBe('sticker');
    expect(resolveMediaType('poll')).toBe('document');
    expect(resolveMediaType('unsupported')).toBe('document');
  });

  it('prefers the real filename extension over a MIME-derived guess', () => {
    expect(resolveExtension('application/pdf', 'invoice.PDF')).toBe('pdf');
    expect(resolveExtension('image/jpeg', 'photo.jpeg')).toBe('jpeg');
    expect(resolveExtension('image/jpeg', null)).toBe('jpg');
    expect(resolveExtension('video/quicktime', null)).toBe('mov');
    expect(resolveExtension(null, null)).toBeNull();
    expect(resolveExtension('application/x-unknown-binary', null)).toBeNull();
  });

  it('images and stickers always preview inline; video/audio only when the browser can actually decode the codec', () => {
    expect(canPreview('image', 'image/jpeg')).toBe(true);
    expect(canPreview('sticker', 'image/webp')).toBe(true);
    expect(canPreview('video', 'video/mp4')).toBe(true);
    expect(canPreview('video', 'video/quicktime')).toBe(false); // MOV/HEVC is not browser-native
    expect(canPreview('audio', 'audio/mpeg')).toBe(true);
    expect(canPreview('audio', 'audio/aac')).toBe(false);
    expect(canPreview('document', 'application/pdf')).toBe(false);
  });

  it('only streamable media types report canStream', () => {
    expect(canStream('video')).toBe(true);
    expect(canStream('audio')).toBe(true);
    expect(canStream('voice_note')).toBe(true);
    expect(canStream('image')).toBe(false);
    expect(canStream('document')).toBe(false);
  });

  it('every successfully stored file can be downloaded regardless of preview support', () => {
    expect(canDownload()).toBe(true);
  });

  it('flags conversion only for non-browser-native video/audio codecs', () => {
    expect(requiresConversion('video', 'video/mp4')).toBe(false);
    expect(requiresConversion('video', 'video/3gpp')).toBe(true);
    expect(requiresConversion('audio', 'audio/ogg')).toBe(false);
    expect(requiresConversion('audio', 'audio/aac')).toBe(true);
    expect(requiresConversion('image', 'image/jpeg')).toBe(false);
  });

  it('flags thumbnail generation only for video and document types', () => {
    expect(requiresThumbnail('video')).toBe(true);
    expect(requiresThumbnail('document')).toBe(true);
    expect(requiresThumbnail('image')).toBe(false);
    expect(requiresThumbnail('audio')).toBe(false);
  });

  it('honestly reports transcoding as unavailable - FFmpeg is not wired in this pass', () => {
    expect(requiresTranscoding()).toBe(false);
  });

  it('classifies MIME family from the real MIME type, distinguishing stickers from generic images', () => {
    expect(classifyMimeFamily('image/webp')).toBe('sticker');
    expect(classifyMimeFamily('image/jpeg')).toBe('image');
    expect(classifyMimeFamily('video/mp4')).toBe('video');
    expect(classifyMimeFamily('audio/opus')).toBe('audio');
    expect(classifyMimeFamily('application/pdf')).toBe('other');
    expect(classifyMimeFamily(null)).toBe('other');
  });

  // Real WhatsApp voice notes report `audio/ogg; codecs=opus`, never the
  // bare `audio/ogg` - every one of these lookups must recognize the real
  // value, not just the bare one, or a genuine voice note gets
  // misclassified/rejected purely because of the codec parameter.
  it('treats "audio/ogg; codecs=opus" (the real WhatsApp voice-note mimeType) identically to the bare "audio/ogg"', () => {
    const real = 'audio/ogg; codecs=opus';

    expect(classifyMimeFamily(real)).toBe(classifyMimeFamily('audio/ogg'));
    expect(classifyMimeFamily(real)).toBe('audio');

    expect(canPreview('voice_note', real)).toBe(canPreview('voice_note', 'audio/ogg'));
    expect(canPreview('voice_note', real)).toBe(true);

    expect(requiresConversion('voice_note', real)).toBe(requiresConversion('voice_note', 'audio/ogg'));
    expect(requiresConversion('voice_note', real)).toBe(false);

    expect(resolveExtension(real, null)).toBe(resolveExtension('audio/ogg', null));
    expect(resolveExtension(real, null)).toBe('ogg');

    expect(isInlineSafeMime(real)).toBe(isInlineSafeMime('audio/ogg'));
    expect(isInlineSafeMime(real)).toBe(true);
  });
});
