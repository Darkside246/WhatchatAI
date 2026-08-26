import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentExecutionRuntime, AgentTask, ActionRequest } from '../../domain/platform/contracts.js';

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

interface SessionUpdate {
  jsonrpc?: string;
  method?: string;
  params?: {
    sessionId?: string;
    update?: {
      sessionUpdate?: string;
      content?: Array<{ type?: string; text?: string }>;
      status?: string;
      title?: string;
      rawInput?: unknown;
    };
  };
}

export interface BuzzAcpRuntimeOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

/**
 * Executes one WhatchatAI AgentTask through Buzz's native ACP stdio boundary.
 *
 * Deliberate security boundary:
 * - no tenant authority is delegated to Buzz;
 * - no database credentials are passed to the subprocess;
 * - the task is serialized as data inside the prompt;
 * - the caller remains responsible for ActionRequest authorization/execution;
 * - the process is killed on timeout or protocol failure.
 *
 * Buzz's current `buzz-agent` exposes ACP over stdio and can run against
 * Anthropic/OpenAI-compatible/OpenRouter/other configured providers. Its
 * current ACP capability advertisement does not guarantee multimodal input,
 * so media interpretation remains in WhatchatAI's AI Gateway.
 */
export class BuzzAcpRuntimeAdapter implements AgentExecutionRuntime {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;

  constructor(options: BuzzAcpRuntimeOptions = {}) {
    this.command = options.command || process.env.BUZZ_AGENT_BIN || 'buzz-agent';
    this.args = options.args ?? (process.env.BUZZ_AGENT_ARGS ? process.env.BUZZ_AGENT_ARGS.split(/\s+/).filter(Boolean) : []);
    this.cwd = options.cwd;
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 1_000), 600_000);
    this.maxOutputChars = Math.min(Math.max(options.maxOutputChars ?? 20_000, 1_000), 100_000);
  }

  async createSession(input: { tenantId: string; agentId: string; taskId: string; capabilities: string[]; toolIds: string[] }): Promise<{ sessionId: string }> {
    const processHandle = this.startProcess();
    try {
      let nextId = 1;
      const initialize = await this.rpc(processHandle, nextId++, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      this.assertRpcSuccess(initialize, 'initialize');

      const session = await this.rpc(processHandle, nextId++, 'session/new', {
        cwd: this.cwd || process.cwd(),
        mcpServers: [],
      });
      this.assertRpcSuccess(session, 'session/new');
      const sessionId = typeof session.result?.sessionId === 'string' ? session.result.sessionId : null;
      if (!sessionId) throw new Error('Buzz ACP session/new returned no sessionId');

      // The process is intentionally not retained between createSession and
      // runTask yet. This v1 adapter is one task per process, which keeps
      // tenant/session isolation explicit while we validate the boundary.
      await this.terminate(processHandle);
      return { sessionId };
    } catch (error) {
      await this.terminate(processHandle);
      throw error;
    }
  }

  async runTask(input: { sessionId: string; task: AgentTask; context: unknown }): Promise<{ status: 'completed' | 'failed'; output: unknown; actionRequests: ActionRequest[] }> {
    const child = this.startProcess();
    const startedAt = Date.now();
    try {
      let nextId = 1;
      const initialized = await this.rpc(child, nextId++, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      this.assertRpcSuccess(initialized, 'initialize');

      const session = await this.rpc(child, nextId++, 'session/new', {
        cwd: this.cwd || process.cwd(),
        mcpServers: [],
      });
      this.assertRpcSuccess(session, 'session/new');
      const actualSessionId = typeof session.result?.sessionId === 'string' ? session.result.sessionId : null;
      if (!actualSessionId) throw new Error('Buzz ACP session/new returned no sessionId');

      const prompt = this.buildPrompt(input.task, input.context);
      const promptRequest = {
        sessionId: actualSessionId,
        prompt: [{ type: 'text', text: prompt }],
      };
      const result = await this.rpcCollectUpdates(child, nextId, 'session/prompt', promptRequest);
      const output = {
        text: result.text.trim().slice(0, this.maxOutputChars),
        runtime: 'buzz-acp',
        durationMs: Date.now() - startedAt,
        executionSessionId: actualSessionId,
        toolCalls: result.toolCalls,
      };

      if (!output.text && result.toolCalls.length === 0) {
        return { status: 'failed', output: { ...output, reason: 'Buzz completed without a text result or tool call' }, actionRequests: [] };
      }
      return { status: 'completed', output, actionRequests: [] };
    } catch (error) {
      return {
        status: 'failed',
        output: { runtime: 'buzz-acp', durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) },
        actionRequests: [],
      };
    } finally {
      await this.terminate(child);
    }
  }

  async cancelTask(_taskId: string): Promise<void> {
    // v1 uses one subprocess per execution, so cancellation is represented
    // by terminating the owning process at the call site. The method is kept
    // explicit to preserve the AgentExecutionRuntime contract.
  }

  async health(): Promise<{ status: 'healthy' | 'degraded' | 'unavailable'; detail?: string }> {
    try {
      const child = this.startProcess();
      try {
        const response = await this.rpc(child, 1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
        this.assertRpcSuccess(response, 'initialize');
        return { status: 'healthy' };
      } finally {
        await this.terminate(child);
      }
    } catch (error) {
      return { status: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private startProcess(): ChildProcessWithoutNullStreams {
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    });
    return child;
  }

  private buildPrompt(task: AgentTask, context: unknown): string {
    const envelope = JSON.stringify({
      contract: 'whatchatai.agent-task.v1',
      instruction: 'Execute only the requested reasoning task. Do not assume authority to mutate WhatchatAI state. Return concise conclusions and, where a business action is suggested, describe it as a recommendation rather than claiming it was executed.',
      task,
      context,
    });
    return envelope;
  }

  private async rpc(child: ChildProcessWithoutNullStreams, id: number, method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const lines = createInterface({ input: child.stdout });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const deadline = Date.now() + this.timeoutMs;
      for await (const line of lines) {
        if (Date.now() > deadline) throw new Error(`Buzz ACP timeout waiting for ${method}`);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as JsonRpcResponse;
        if (message.id === id) return message;
      }
      throw new Error(`Buzz ACP process ended before responding to ${method}`);
    } finally {
      lines.close();
    }
  }

  private async rpcCollectUpdates(
    child: ChildProcessWithoutNullStreams,
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ text: string; toolCalls: Array<Record<string, unknown>> }> {
    const lines = createInterface({ input: child.stdout });
    const deadline = Date.now() + this.timeoutMs;
    let text = '';
    const toolCalls: Array<Record<string, unknown>> = [];
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for await (const line of lines) {
        if (Date.now() > deadline) throw new Error(`Buzz ACP timeout waiting for ${method}`);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as JsonRpcResponse & SessionUpdate;
        const update = message.params?.update;
        if (message.method === 'session/update' && update) {
          if (update.sessionUpdate === 'agent_message_chunk') {
            const chunk = update.content?.find((item) => item.type === 'text')?.text;
            if (chunk) text += chunk;
          } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            toolCalls.push({ sessionUpdate: update.sessionUpdate, title: update.title, status: update.status, rawInput: update.rawInput });
          }
        }
        if (message.id === id) {
          this.assertRpcSuccess(message, method);
          return { text, toolCalls };
        }
      }
      throw new Error(`Buzz ACP process ended before responding to ${method}`);
    } finally {
      lines.close();
    }
  }

  private assertRpcSuccess(response: JsonRpcResponse, method: string): void {
    if (response.error) throw new Error(`Buzz ACP ${method} failed: ${response.error.message || 'unknown error'}`);
  }

  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.killed || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
