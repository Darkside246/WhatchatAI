import { Type } from '@google/genai';
import { getGeminiClient } from '../../services/geminiClient.js';

export type OutboundLeakVerdict =
  | { allowed: false; eventType: 'ai_output_leak_blocked'; reason: string }
  | { allowed: true; eventType: 'ai_output_leak_check_unavailable'; reason: string }
  | { allowed: true; eventType: 'ai_output_leak_pass'; reason: string | null };

// Below this length a "fact" is too short to be a meaningful signal - it
// would only ever produce false positives (e.g. a 2-character fact
// matching inside unrelated words).
const MIN_FACT_LENGTH = 3;

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Stage 1: deterministic, no API call, cannot itself fail open. A
 * case-insensitive, whitespace-normalized substring match - the exact
 * signal that would have caught the real incident this guard exists for
 * (a protected name/fact reproduced verbatim in a generated reply).
 * Deliberately favors recall over precision: no word-boundary strictness,
 * so a fact appearing inside unrelated text still blocks. A false
 * positive here just means one conversation hands off to a human: a
 * trivial cost next to a real privacy breach.
 */
function matchProtectedFacts(text: string, protectedFacts: string[]): string | null {
  const normalizedText = normalize(text);
  for (const fact of protectedFacts) {
    const normalizedFact = normalize(fact);
    if (normalizedFact.length < MIN_FACT_LENGTH) continue;
    if (normalizedText.includes(normalizedFact)) {
      return `Reply contains a protected fact: "${fact}"`;
    }
  }
  return null;
}

const SEMANTIC_CHECK_SYSTEM_INSTRUCTION = `You are a confidentiality classifier for an AI assistant's outgoing WhatsApp reply.
You are given a list of protected facts that must never be disclosed to the recipient, and the reply text about to be sent.
Determine whether the reply reveals, confirms, or clearly implies any of the protected facts - directly, by paraphrase, or by confirming a guess the recipient made.
Respond only via the required JSON schema.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    safe: { type: Type.BOOLEAN },
    reason: { type: Type.STRING },
  },
  required: ['safe', 'reason'],
};

interface SemanticCheckVerdict {
  status: 'safe' | 'unsafe' | 'unavailable';
  reason: string;
}

/**
 * Stage 2: an AI semantic check for paraphrase/indirect leaks Stage 1's
 * literal match cannot catch. Mirrors aiSentinel.ts's shape closely (same
 * model selection, same structured-JSON pattern, same fail-to-
 * 'unavailable' behavior on a missing key or API error - this never
 * fabricates a safety verdict).
 */
async function runSemanticCheck(text: string, protectedFacts: string[]): Promise<SemanticCheckVerdict> {
  const genAi = getGeminiClient();
  if (!genAi) {
    return { status: 'unavailable', reason: 'GEMINI_API_KEY is not configured' };
  }

  const model = process.env.GEMINI_SENTINEL_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const prompt = `Protected facts:\n${protectedFacts.map((fact) => `- ${fact}`).join('\n')}\n\nReply text:\n${text}`;

  try {
    const response = await genAi.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: SEMANTIC_CHECK_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
      },
    });

    const raw = response.text;
    if (!raw) return { status: 'unavailable', reason: 'Outbound leak check model returned an empty response' };

    const parsed = JSON.parse(raw) as { safe?: unknown; reason?: unknown };
    if (typeof parsed.safe !== 'boolean' || typeof parsed.reason !== 'string') {
      return { status: 'unavailable', reason: 'Outbound leak check model returned a malformed verdict' };
    }

    return parsed.safe ? { status: 'safe', reason: parsed.reason } : { status: 'unsafe', reason: parsed.reason };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `Outbound leak check model call failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The Outbound Leak Guard: runs on every AI-generated reply before it is
 * sent, checking it against this agent's own declared protected facts.
 * The outbound counterpart to the inbound Sentinel (sentinel.ts) - same
 * two-stage shape, but deliberately different open/closed semantics:
 * inbound Sentinel fails OPEN when its Stage 2 is unavailable, because its
 * Stage 1 (executable payloads, rate limits) is a real gate on its own.
 * Here, Stage 1 passing only proves there's no verbatim string match - it
 * is not proof nothing was leaked by paraphrase - so a Stage 1 hit always
 * blocks regardless of Stage 2, but Stage 2 being unavailable still allows
 * the reply through (an honestly-logged coverage gap, never a fabricated
 * block or pass).
 */
export async function runOutboundLeakGuard(text: string, protectedFacts: string[]): Promise<OutboundLeakVerdict> {
  const stage1Match = matchProtectedFacts(text, protectedFacts);
  if (stage1Match) {
    return { allowed: false, eventType: 'ai_output_leak_blocked', reason: stage1Match };
  }

  // Same length filter as Stage 1 - a fact too short to be a meaningful
  // signal there is equally too short to hand to the semantic check,
  // which would otherwise flag any reply containing it as ordinary text
  // (e.g. a 2-character fact like "ok").
  const meaningfulFacts = protectedFacts.filter((fact) => normalize(fact).length >= MIN_FACT_LENGTH);
  if (meaningfulFacts.length === 0) {
    return { allowed: true, eventType: 'ai_output_leak_pass', reason: null };
  }

  const semantic = await runSemanticCheck(text, meaningfulFacts);

  if (semantic.status === 'unsafe') {
    return { allowed: false, eventType: 'ai_output_leak_blocked', reason: semantic.reason };
  }

  if (semantic.status === 'unavailable') {
    return { allowed: true, eventType: 'ai_output_leak_check_unavailable', reason: semantic.reason };
  }

  return { allowed: true, eventType: 'ai_output_leak_pass', reason: semantic.reason };
}
