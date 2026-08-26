import { describe, expect, it } from 'vitest';
import { MediaProcessingService } from './mediaProcessingService.js';

describe('MediaProcessingService', () => {
  it('accepts bounded images', () => {
    const service = new MediaProcessingService();
    expect(service.validate({ kind: 'image', mimeType: 'image/jpeg', sizeBytes: 1024, storageRef: 'tenant/file' }).status).toBe('ACCEPTED');
  });
  it('rejects oversized images', () => {
    const service = new MediaProcessingService();
    expect(service.validate({ kind: 'image', mimeType: 'image/jpeg', sizeBytes: 9 * 1024 * 1024, storageRef: 'tenant/file' }).status).toBe('REJECTED');
  });
  it('defers video by default', () => {
    const service = new MediaProcessingService();
    expect(service.validate({ kind: 'video', mimeType: 'video/mp4', sizeBytes: 1024, durationMs: 1000, storageRef: 'tenant/file' }).status).toBe('DEFERRED');
  });
  it('rejects invalid duration and storage references', () => {
    const service = new MediaProcessingService({ audio: { maxBytes: 1000, maxDurationMs: 100, enabled: true }, image: { maxBytes: 1000, enabled: true }, voice_note: { maxBytes: 1000, maxDurationMs: 100, enabled: true }, video: { maxBytes: 1000, maxDurationMs: 100, enabled: true }, document: { maxBytes: 1000, enabled: true } });
    expect(service.validate({ kind: 'audio', mimeType: 'audio/ogg', sizeBytes: 100, durationMs: 101, storageRef: 'tenant/file' }).status).toBe('REJECTED');
    expect(service.validate({ kind: 'image', mimeType: 'image/jpeg', sizeBytes: 100, storageRef: ' ' }).status).toBe('REJECTED');
  });
});
