import type { FunctionDeclaration } from '@google/genai';
import type { AIProviderToolDefinition } from '../../domain/platform/contracts.js';

/**
 * Translates this codebase's canonical tool definitions - written once as
 * Gemini `FunctionDeclaration`s, next to the tools that implement them - into
 * the provider-neutral JSON-Schema shape every AiGateway provider expects.
 *
 * Why this exists: the live reply path used to hand fallback providers no
 * tools at all, so a customer asking "tell Hasan to call me at 6" got a real
 * relayed_messages row when Gemini answered and nothing at all when a
 * fallback did - same persona, silently different capability. Rather than
 * maintaining a second, hand-written copy of every tool schema per provider
 * (which would drift the moment a description changed), the one existing
 * definition is converted here.
 *
 * The only real incompatibility is the type vocabulary: @google/genai's
 * `Type` enum is UPPERCASE ('STRING', 'OBJECT'), while JSON Schema - which
 * OpenAI, Groq, Cerebras and Mistral all expect - is lowercase ('string',
 * 'object'). Everything else (properties, required, items, enum,
 * description) is already shaped identically in both.
 */

/** Recursively lowercases `type` and walks the nested schema keywords that can contain further schemas. */
function toJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toJsonSchema);
  if (value === null || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'type' && typeof nested === 'string') {
      // TYPE_UNSPECIFIED carries no JSON Schema meaning - an omitted type is
      // the honest translation, not a guessed concrete one.
      if (nested === 'TYPE_UNSPECIFIED') continue;
      result[key] = nested.toLowerCase();
      continue;
    }
    result[key] = toJsonSchema(nested);
  }
  return result;
}

/**
 * Converts one Gemini FunctionDeclaration. Returns null for a declaration
 * with no name - unnamed tools are unaddressable by any provider, and
 * inventing a name for one would be worse than dropping it.
 */
export function toProviderToolDefinition(declaration: FunctionDeclaration): AIProviderToolDefinition | null {
  if (!declaration.name) return null;

  const parameters = declaration.parameters
    ? (toJsonSchema(declaration.parameters) as Record<string, unknown>)
    : // A genuinely parameterless tool still needs a valid empty object
      // schema - providers reject a missing `parameters`.
      { type: 'object', properties: {} };

  return {
    name: declaration.name,
    description: declaration.description ?? '',
    parameters,
  };
}

/**
 * Converts the exact `tools` array the primary Gemini call was built with
 * (`[{ functionDeclarations }]`) into the gateway's flat tool list, so a
 * fallback provider is offered precisely the tools this agent was already
 * allowed this turn - the agent's own allowlist, its forbidden list, its
 * autonomy level and the business-wide AI-actions pause have all already
 * been applied upstream by buildReplyTools. Nothing is added back here.
 */
export function toProviderToolDefinitions(
  geminiTools: Array<{ functionDeclarations?: FunctionDeclaration[] }> | undefined,
): AIProviderToolDefinition[] {
  if (!geminiTools?.length) return [];
  return geminiTools
    .flatMap((tool) => tool.functionDeclarations ?? [])
    .map(toProviderToolDefinition)
    .filter((tool): tool is AIProviderToolDefinition => tool !== null);
}
