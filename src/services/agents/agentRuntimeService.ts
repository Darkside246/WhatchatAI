import type { AgentExecutionResult, AgentRuntimeAdapter, AgentTask } from '../../domain/platform/contracts.js';
import { BuzzAcpRuntimeAdapter } from './buzzAcpRuntimeAdapter.js';

export class AgentRuntimeService {
  private readonly runtimes = new Map<string, AgentRuntimeAdapter>();

  register(runtime: AgentRuntimeAdapter): void {
    if (this.runtimes.has(runtime.name)) throw new Error(`Agent runtime "${runtime.name}" is already registered`);
    this.runtimes.set(runtime.name, runtime);
  }

  list(): string[] {
    return [...this.runtimes.keys()].sort();
  }

  get(name: string): AgentRuntimeAdapter | null {
    return this.runtimes.get(name) ?? null;
  }

  async execute(runtimeName: string, task: AgentTask, context: unknown): Promise<AgentExecutionResult> {
    if (!task.tenantId) throw new Error('AgentTask requires tenantId');
    const runtime = this.runtimes.get(runtimeName);
    if (!runtime) throw new Error(`Agent runtime "${runtimeName}" is not registered`);
    return runtime.execute(task, context);
  }

  async health(): Promise<Record<string, { healthy: boolean; details?: string }>> {
    const entries = await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        try {
          return [runtime.name, await runtime.health()] as const;
        } catch (error) {
          return [runtime.name, { healthy: false, details: error instanceof Error ? error.message : String(error) }] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }
}

export const agentRuntimeService = new AgentRuntimeService();

let runtimesInitialised = false;

/** Runtime registration is explicit and opt-in. No deployment silently starts a local Buzz process. */
export function initializeAgentRuntimes(service = agentRuntimeService): void {
  if (runtimesInitialised) return;
  if (process.env.WHATCHATAI_AGENT_RUNTIME === 'buzz-acp') {
    service.register(new BuzzAcpRuntimeAdapter());
  }
  runtimesInitialised = true;
}
