import { describe, expect, it } from 'vitest';
import { Type, type FunctionDeclaration } from '@google/genai';
import { toProviderToolDefinition, toProviderToolDefinitions } from './geminiToolSchemaBridge.js';

describe('geminiToolSchemaBridge', () => {
  it('lowercases Gemini\'s UPPERCASE Type enum into real JSON Schema types', () => {
    const declaration: FunctionDeclaration = {
      name: 'take_a_message',
      description: 'Relay a message to the owner.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          recipientDescription: { type: Type.STRING, description: 'Who the message is for.' },
          urgent: { type: Type.BOOLEAN },
        },
        required: ['recipientDescription'],
      },
    };

    const converted = toProviderToolDefinition(declaration);

    expect(converted).toEqual({
      name: 'take_a_message',
      description: 'Relay a message to the owner.',
      parameters: {
        type: 'object',
        properties: {
          recipientDescription: { type: 'string', description: 'Who the message is for.' },
          urgent: { type: 'boolean' },
        },
        required: ['recipientDescription'],
      },
    });
  });

  it('converts nested object and array schemas all the way down', () => {
    const declaration: FunctionDeclaration = {
      name: 'nested',
      description: 'Nested shapes.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { id: { type: Type.INTEGER }, tags: { type: Type.ARRAY, items: { type: Type.STRING } } },
            },
          },
        },
      },
    };

    const converted = toProviderToolDefinition(declaration);
    const parameters = converted!.parameters as Record<string, any>;

    expect(parameters.properties.items.type).toBe('array');
    expect(parameters.properties.items.items.type).toBe('object');
    expect(parameters.properties.items.items.properties.id.type).toBe('integer');
    expect(parameters.properties.items.items.properties.tags.items.type).toBe('string');
  });

  it('preserves enum values and descriptions verbatim - a tool\'s own wording is what steers the model', () => {
    const declaration: FunctionDeclaration = {
      name: 'update_conversation_state',
      description: 'Record the customer readiness.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          readiness: { type: Type.STRING, enum: ['BROWSING', 'READY', 'URGENT'], description: 'How ready they are.' },
        },
      },
    };

    const parameters = toProviderToolDefinition(declaration)!.parameters as Record<string, any>;
    expect(parameters.properties.readiness.enum).toEqual(['BROWSING', 'READY', 'URGENT']);
    expect(parameters.properties.readiness.description).toBe('How ready they are.');
  });

  it('drops TYPE_UNSPECIFIED rather than guessing a concrete type for it', () => {
    const declaration: FunctionDeclaration = {
      name: 'unspecified',
      description: 'Has an unspecified field.',
      parameters: { type: Type.OBJECT, properties: { anything: { type: Type.TYPE_UNSPECIFIED } } },
    };

    const parameters = toProviderToolDefinition(declaration)!.parameters as Record<string, any>;
    expect(parameters.properties.anything).not.toHaveProperty('type');
  });

  it('gives a parameterless tool a valid empty object schema - providers reject a missing parameters field', () => {
    const declaration: FunctionDeclaration = { name: 'get_current_time', description: 'The current time.' };
    expect(toProviderToolDefinition(declaration)!.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('drops an unnamed declaration instead of inventing a name for it', () => {
    expect(toProviderToolDefinition({ description: 'No name.' } as FunctionDeclaration)).toBeNull();
  });

  it('flattens the exact tools array shape the primary Gemini call is built with', () => {
    const tools = [
      {
        functionDeclarations: [
          { name: 'a', description: 'A', parameters: { type: Type.OBJECT, properties: {} } },
          { name: 'b', description: 'B', parameters: { type: Type.OBJECT, properties: {} } },
        ],
      },
    ];

    expect(toProviderToolDefinitions(tools).map((tool) => tool.name)).toEqual(['a', 'b']);
  });

  it('returns an empty list for undefined or empty tools, so a no-tools turn stays a no-tools turn', () => {
    expect(toProviderToolDefinitions(undefined)).toEqual([]);
    expect(toProviderToolDefinitions([])).toEqual([]);
    expect(toProviderToolDefinitions([{ functionDeclarations: [] }])).toEqual([]);
  });
});
