import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesProvider } from './openaiResponsesProvider.js';

const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_GATEWAY_MODEL;

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_GATEWAY_MODEL = 'gpt-5.4-mini';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  if (originalModel === undefined) delete process.env.OPENAI_GATEWAY_MODEL;
  else process.env.OPENAI_GATEWAY_MODEL = originalModel;
});

describe('OpenAIResponsesProvider', () => {
  it('uses Responses API with store:false and never sends AURA tenant identifiers as metadata', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{
            type: 'message',
            content: [{ type: 'output_text', text: 'Hello from the safe adapter.' }],
          }],
          usage: { input_tokens: 12, output_tokens: 7 },
        }),
        { status: 200 },
      ),
    );

    const provider = new OpenAIResponsesProvider();
    const result = await provider.generate({
      tenantId: 'tenant-secret',
      operation: 'reply.generate',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.text).toBe('Hello from the safe adapter.');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.metadata).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('tenant-secret');
  });

  it('returns native function calls with their call_id preserved for a later tool result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{
            type: 'function_call',
            call_id: 'call_123',
            name: 'take_a_message',
            arguments: '{"message":"Please call me back"}',
          }],
        }),
        { status: 200 },
      ),
    );

    const provider = new OpenAIResponsesProvider();
    const result = await provider.generate({
      tenantId: 'tenant-1',
      operation: 'reply.generate',
      messages: [{ role: 'user', content: 'Please take a message.' }],
      tools: [{
        name: 'take_a_message',
        description: 'Record a message for a team member.',
        parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      }],
    });

    expect(result.toolCalls).toEqual([
      { name: 'take_a_message', args: { message: 'Please call me back' }, callId: 'call_123' },
    ]);
  });

  it('sends the exact call_id back with function_call_output and does not allow parallel tool execution', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }] }), { status: 200 }),
    );

    const provider = new OpenAIResponsesProvider();
    await provider.generate({
      tenantId: 'tenant-1',
      operation: 'reply.generate',
      messages: [{ role: 'user', content: 'Take the message.' }],
      tools: [{ name: 'take_a_message', description: 'Record a message.', parameters: { type: 'object' } }],
      pendingToolCalls: [{ name: 'take_a_message', args: { message: 'hello' }, callId: 'call_456' } as never],
      toolResponses: [{ name: 'take_a_message', response: { recorded: true } }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as {
      parallel_tool_calls: boolean;
      input: Array<Record<string, unknown>>;
    };
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.input).toContainEqual({
      type: 'function_call',
      call_id: 'call_456',
      name: 'take_a_message',
      arguments: '{"message":"hello"}',
    });
    expect(body.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_456',
      output: '{"recorded":true}',
    });
  });

  it('does not relay reasoning items - only output_text becomes customer-visible text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Sensitive internal reasoning.' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'Safe customer answer.' }] },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = new OpenAIResponsesProvider();
    const result = await provider.generate({ tenantId: 'tenant-1', operation: 'reply.generate', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.text).toBe('Safe customer answer.');
    expect(result.text).not.toContain('Sensitive internal reasoning');
  });

  it('never copies an OpenAI error body into the application error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Customer phone +15551234567 should never appear in an application error', { status: 400 }),
    );

    const provider = new OpenAIResponsesProvider();
    await expect(provider.generate({ tenantId: 'tenant-1', operation: 'reply.generate', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow('openai HTTP 400');
    await expect(provider.generate({ tenantId: 'tenant-1', operation: 'reply.generate', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.not.toThrow('+15551234567');
  });
});
