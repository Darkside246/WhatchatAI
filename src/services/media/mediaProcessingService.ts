import { z } from 'zod';

export const MediaKindSchema = z.enum(['image', 'audio', 'voice_note', 'video', 'document']);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export interface MediaInput { kind: MediaKind; mimeType: string; sizeBytes: number; durationMs?: number; storageRef: string; }
export interface MediaPolicy { maxBytes: number; maxDurationMs?: number; enabled: boolean; }
export interface MediaAnalysis { kind: MediaKind; status: 'ACCEPTED' | 'REJECTED' | 'DEFERRED'; reason?: string; normalizedRef?: string; }

const DEFAULT_POLICIES: Record<MediaKind, MediaPolicy> = {
  image: { maxBytes: 8 * 1024 * 1024, enabled: true },
  audio: { maxBytes: 12 * 1024 * 1024, maxDurationMs: 10 * 60 * 1000, enabled: true },
  voice_note: { maxBytes: 12 * 1024 * 1024, maxDurationMs: 10 * 60 * 1000, enabled: true },
  video: { maxBytes: 25 * 1024 * 1024, maxDurationMs: 90 * 1000, enabled: false },
  document: { maxBytes: 15 * 1024 * 1024, enabled: true },
};

export class MediaProcessingService {
  constructor(private readonly policies: Record<MediaKind, MediaPolicy> = DEFAULT_POLICIES) {}

  validate(input: MediaInput): MediaAnalysis {
    const policy = this.policies[input.kind];
    if (!policy.enabled) return { kind: input.kind, status: 'DEFERRED', reason: 'media kind is feature-gated' };
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) return { kind: input.kind, status: 'REJECTED', reason: 'invalid media size' };
    if (input.sizeBytes > policy.maxBytes) return { kind: input.kind, status: 'REJECTED', reason: `media exceeds ${policy.maxBytes} byte limit` };
    if (policy.maxDurationMs !== undefined && input.durationMs !== undefined && input.durationMs > policy.maxDurationMs) return { kind: input.kind, status: 'REJECTED', reason: `media exceeds ${policy.maxDurationMs}ms duration limit` };
    if (!input.storageRef.trim()) return { kind: input.kind, status: 'REJECTED', reason: 'missing storage reference' };
    return { kind: input.kind, status: 'ACCEPTED', normalizedRef: input.storageRef };
  }

  policy(kind: MediaKind): MediaPolicy { return { ...this.policies[kind] }; }
}

export const mediaProcessingService = new MediaProcessingService();
