"""The DSPy program being optimized.

Mirrors the real, live prompt shape WhatchatAI actually sends to Gemini -
see src/services/aiReplyService.ts's buildSystemInstruction(). This
signature does not reproduce every field that function assembles (the
trusted TimeContext, the hard scope-limit rules for regulated trades, the
"never invent facts" rule) - those are fixed, code-owned safety rules that
must never be subject to prompt optimization. What DSPy is allowed to
improve is exactly one thing: the free-text operator-authored
`system_instruction` field (persona/tone/business_context are given as
real inputs here so the optimizer can propose an instruction that works
well *with* them, not instead of them).
"""

import dspy


class WhatsAppReply(dspy.Signature):
    """Reply to a WhatsApp customer message as this business's AI agent,
    in the agent's own configured persona and tone, using only the real
    business context and conversation history given - never invent facts,
    prices, or policies. Keep the reply concise and WhatsApp-appropriate:
    short, plain text, no markdown."""

    persona: str = dspy.InputField(desc="The agent's persona description, or empty if not set")
    tone: str = dspy.InputField(desc="The agent's tone, or empty if not set")
    business_context: str = dspy.InputField(desc="Real facts about the business the agent should know")
    conversation_history: str = dspy.InputField(desc="Prior turns of this conversation, oldest first, one per line")
    customer_message: str = dspy.InputField(desc="The customer's latest message")
    reply: str = dspy.OutputField(desc="A concise, WhatsApp-appropriate reply")


def build_program() -> dspy.Module:
    """A plain Predict module - deliberately not ChainOfThought. A visible
    chain-of-thought field has no analog in the live reply path (Gemini's
    thinkingConfig is explicitly disabled there, see aiReplyService.ts),
    so optimizing a program shape the live path can't actually use would
    produce an artifact that doesn't transfer.
    """
    return dspy.Predict(WhatsAppReply)
