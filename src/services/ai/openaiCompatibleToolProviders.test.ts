import { afterEach, describe, expect, it, vi } from 'vitest';
import { CerebrasProvider, GroqProvider, MistralProvider } from './openaiCompatibleToolProviders.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GROQ_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  delete process.env.MISTRAL_API_KEY;
});

describe('OpenAI-compatible tool providers', () => {
  it('maps a Groq tool call without forwarding tenant identity as metadata', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{
              id: 'provider-call-id',
              type: 'function',
              function: { name: 'take_a_message', arguments: '{"message":"hello"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const provider = new GroqProvider();
    const result = await provider.generate({
      tenantId: 'private-tenant-id',
      operation: 'whatsapp_reply',
      messages: [{ role: 'user', content: 'Please take a message.' }],
      tools: [{ name: 'take_a_message', description: 'Take a message', parameters: { type: 'object' } }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.tenantId).toBeUndefined();
    expect(body.chatId).toBeUndefined();
    expect(body.tools[0].function.name).toBe('take_a_message');
    expect(body.parallel_tool_calls).toBe(false);
    expect(result.toolCalls).toEqual([{ name: 'take_a_message', args: { message: 'hello' } }]);
  });

  it('reconstructs a safe single-step tool result turn for Cerebras', async () => {
    process.env.CEREBRAS_API_KEY = 'test-key';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Done' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const provider = new CerebrasProvider();
    await provider.generate({
      tenantId: 'private-tenant-id',
      operation: 'whatsapp_reply',
      messages: [{ role: 'user', content: 'Use the result.' }],
      pendingToolCalls: [{ name: 'lookup', args: { id: '123' } }],
      toolResponses: [{ name: 'lookup', response: { found: true } }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.messages.at(-2)).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'aura_tool_0',
        type: 'function',
        function: { name: 'lookup', arguments: '{"id":"123"}' },
      }],
    });
    expect(body.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'aura_tool_0',
      content: '{"found":true}',
    });
  });

  it('uses Mistral native completion token field', async () => {
    process.env.MISTRAL_API_KEY = 'test-key';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const provider = new MistralProvider();
    await provider.generate({
      tenantId: 'private-tenant-id',
      operation: 'reply',
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 300,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.max_tokens).toBe(300);
    expect(body.max_completion_tokens).toBeUndefined();
  });
});
