"""A separate, offline Python service - never imported by, or merged into,
the Node/TypeScript application. It is run manually by an operator; its
only interaction with WhatchatAI is the JSON artifact it writes, which a
human then reviews and imports through the app's own
POST /api/workspace/agents/:agentId/prompt-optimizations endpoint. It is
never given live database credentials and is never called at request time
from the customer-facing reply path.
"""
