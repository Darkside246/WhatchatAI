import type { TimeProvider, TimeProviderResult } from './timeProvider.js';
import { TIME_CONFIG } from './config.js';

const DEFAULT_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

export interface InternetTimeProviderOptions {
  url?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Cloudflare's edge trace endpoint as the calibration source: no API key,
 * thousands of globally distributed points-of-presence, and every response
 * carries a `ts=<unix-seconds>.<fraction>` line - chosen over a dedicated
 * "world time" API specifically because those tend to be small, single
 * region services with materially worse uptime than Cloudflare's edge.
 * Swappable behind the TimeProvider interface without touching TimeSyncService.
 */
export class InternetTimeProvider implements TimeProvider {
  readonly name = 'internet';
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: InternetTimeProviderOptions = {}) {
    this.url = options.url ?? process.env.TIME_SYNC_PROVIDER_URL ?? DEFAULT_URL;
    this.timeoutMs = options.timeoutMs ?? TIME_CONFIG.fetchTimeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getCurrentUtcTime(): Promise<TimeProviderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url, { signal: controller.signal, headers: { accept: 'text/plain' } });
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`Time provider request timed out after ${this.timeoutMs}ms`);
        throw error;
      }
      if (!response.ok) throw new Error(`Time provider responded with HTTP ${response.status}`);

      const body = await response.text();
      const match = /^ts=([\d.]+)$/m.exec(body);
      if (!match?.[1]) throw new Error('Time provider response did not contain a parseable ts= field');

      const seconds = Number.parseFloat(match[1]);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Time provider returned a non-finite timestamp');

      return { utcMillis: Math.round(seconds * 1000), source: this.name };
    } finally {
      clearTimeout(timeout);
    }
  }
}
