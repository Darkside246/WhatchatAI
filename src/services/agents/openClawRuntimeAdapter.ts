import { randomUUID } from 'node:crypto';
import type { AgentExecutionResult, AgentRuntimeAdapter, AgentTask } from '../../domain/platform/contracts.js';

export interface OpenClawRuntimeOptions {
  endpoint?: string;
  token?: string;
  timeoutMs?: number;
  maxPromptBytes?: number;
  maxResponseBytes?: number;
}

/**
 * Optional OpenClaw gateway boundary. AURA remains the authority for
 * tenant identity, permissions, action approval and audit. This adapter only
 * transports a bounded AgentTask to a separately controlled runtime.
 *
 * No shell access, database credentials, arbitrary headers or caller-supplied
 * endpoint are accepted. The endpoint and bearer token come from deployment
 * configuration, and HTTPS is mandatory outside localhost development.
 */
export class OpenClawRuntimeAdapter implements AgentRuntimeAdapter {
  readonly name = 'openclaw';
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxPromptBytes: number;
  private readonly maxResponseBytes: number;

  constructor(options: OpenClawRuntimeOptions = {}) {
    this.endpoint = options.endpoint ?? process.env.OPENCLAW_GATEWAY_URL ?? '';
    this.token = options.token ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 90_000, 1_000), 300_000);
    this.maxPromptBytes = Math.min(Math.max(options.maxPromptBytes ?? 512_000, 16_384), 2_000_000);
    this.maxResponseBytes = Math.min(Math.max(options.maxResponseBytes ?? 1_000_000, 4_096), 5_000_000);

    if (this.endpoint) {
      const url = new URL(this.endpoint);
      const localDevelopment = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
      if (url.protocol !== 'https:' && !(localDevelopment && process.env.NODE_ENV !== 'production')) {
        throw new Error('OpenClaw gateway URL must use HTTPS outside local development');
      }
    }
  }

  async execute(task: AgentTask, context: unknown): Promise<AgentExecutionResult> {
    const executionId = randomUUID();
    if (!this.endpoint) return this.failed(executionId, 'OpenClaw gateway is not configured');
    if (!this.token) return this.failed(executionId, 'OpenClaw gateway token is not configured');
    if (!task.tenantId) return this.failed(executionId, 'AgentTask requires tenantId');

    const body = JSON.stringify({
      contract: 'whatchatai.openclaw-task.v1',
      executionId,
      task,
      context,
      constraints: {
        noDirectDatabaseAccess: true,
        noUnapprovedActions: true,
        tenantScope: task.tenantId,
      },
    });
    if (Buffer.byteLength(body, 'utf8') > this.maxPromptBytes) {
      return this.failed(executionId, `OpenClaw task exceeds ${this.maxPromptBytes} bytes`);
    }

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > this.maxResponseBytes) {
        return this.failed(executionId, `OpenClaw response exceeds ${this.maxResponseBytes} bytes`);
      }
      if (!response.ok) return this.failed(executionId, `OpenClaw gateway HTTP ${response.status}`);
      let output: unknown;
      try { output = JSON.parse(raw); } catch { output = { text: raw }; }
      return { status: 'completed', executionId, output, actionRequests: [] };
    } catch (error) {
      return this.failed(executionId, error instanceof Error ? error.message : String(error));
    }
  }

  async cancel(executionId: string, tenantId: string): Promise<void> {
    if (!executionId || !tenantId) throw new Error('executionId and tenantId are required to cancel an OpenClaw execution');
    // Cancellation is intentionally a no-op until the configured OpenClaw
    // endpoint advertises a tenant-scoped cancellation contract. We never
    // guess an endpoint or send an unbounded control request.
  }

  async health(): Promise<{ healthy: boolean; details?: string }> {
    if (!this.endpoint) return { healthy: false, details: 'OpenClaw gateway is not configured' };
    if (!this.token) return { healthy: false, details: 'OpenClaw gateway token is not configured' };
    try {
      const response = await fetch(this.endpoint, {
        method: 'HEAD',
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)),
      });
      return response.ok ? { healthy: true } : { healthy: false, details: `OpenClaw gateway HTTP ${response.status}` };
    } catch (error) {
      return { healthy: false, details: error instanceof Error ? error.message : String(error) };
    }
  }

  private failed(executionId: string, reason: string): AgentExecutionResult {
    return { status: 'failed', executionId, output: { runtime: this.name, reason }, actionRequests: [] };
  }
}
