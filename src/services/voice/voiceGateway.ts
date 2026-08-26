import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const VoiceCallStatusSchema = z.enum(['RINGING', 'ANSWERED', 'IN_PROGRESS', 'MISSED', 'ENDED', 'FAILED']);
export type VoiceCallStatus = z.infer<typeof VoiceCallStatusSchema>;

export interface VoiceCall { id: string; tenantId: string; externalCallId: string; from: string; to: string; status: VoiceCallStatus; startedAt: string; answeredAt?: string; endedAt?: string; }
export interface VoiceTranscript { callId: string; text: string; language?: string; segments?: Array<{ startMs: number; endMs: number; text: string }>; }
export interface VoiceProvider {
  readonly name: string;
  startOutbound(input: { tenantId: string; to: string; from: string }): Promise<{ externalCallId: string }>;
  answerInbound?(input: { tenantId: string; externalCallId: string }): Promise<void>;
  hangup?(input: { tenantId: string; externalCallId: string }): Promise<void>;
  transcribe?(input: { tenantId: string; audioRef: string; mimeType: string }): Promise<VoiceTranscript>;
  health(): Promise<{ healthy: boolean; details?: string }>;
}

export class VoiceGateway {
  private readonly providers = new Map<string, VoiceProvider>();
  register(provider: VoiceProvider): void { if (this.providers.has(provider.name)) throw new Error(`voice provider "${provider.name}" already registered`); this.providers.set(provider.name, provider); }
  list(): string[] { return [...this.providers.keys()].sort(); }
  get(name: string): VoiceProvider | null { return this.providers.get(name) ?? null; }
  createCall(input: { tenantId: string; from: string; to: string }): VoiceCall { return { id: randomUUID(), tenantId: input.tenantId, externalCallId: 'pending', from: input.from, to: input.to, status: 'RINGING', startedAt: new Date().toISOString() }; }
}

export const voiceGateway = new VoiceGateway();
