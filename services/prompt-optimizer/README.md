# WhatchatAI Prompt Optimizer (DSPy)

A **separate, offline Python service**. It is not part of the Node/TypeScript
application, is never imported by it, is never given database credentials,
and is never called during a live customer conversation. It is a tool an
operator runs manually, by hand, when they want to try improving one AI
agent's `system_instruction` using DSPy against a real dataset of example
conversations.

The only thing that connects this to WhatchatAI is a JSON file: this tool
writes one, a human reads it, and if they like it they paste it into
`POST /api/workspace/agents/:agentId/prompt-optimizations` (or the
matching Settings UI). Nothing here can change what a live agent says on
its own - see "How this reaches a live agent" below.

## Why this exists

WhatchatAI's `aiReplyService.ts` builds a system prompt for Gemini out of
several pieces - persona, tone, business context, and one free-text field
an operator writes by hand (`ai_agents.system_instruction`). That field is
exactly the kind of thing [DSPy](https://github.com/stanfordnlp/dspy) is
built to optimize: instead of a human guessing at better wording, DSPy
runs a real optimizer (here, `BootstrapFewShot` by default, or `GEPA` -
the same one named in the original architecture proposal) against a real
labeled dataset and a real metric, and proposes a better instruction (plus,
optionally, worked few-shot examples) automatically.

## What is genuinely verified vs. not

**Verified in this sandbox, right now, with real (non-mocked) code:**
- `dspy-ai==3.3.0` installs cleanly and `import dspy` works.
- The `WhatsAppReply` DSPy signature constructs correctly and exposes
  exactly the fields the live Node reply path can actually supply
  (`test_optimize.py::test_the_real_signature_declares_exactly_the_fields...`).
- `dataset.py`'s JSONL loading and validation (20 tests, `pytest`) - malformed
  rows, missing fields, unrecognized fields, empty files, and nonexistent
  paths all fail loudly rather than silently, using no network calls.
- `optimize.py`'s pure logic - CLI argument parsing, the train/val split,
  extracting a flat instruction string out of a real (but never-called)
  `dspy.Predict` program including its demos, writing the JSON artifact in
  the exact shape the Node import endpoint expects, and failing closed
  with a clear error when `GEMINI_API_KEY` is unset - all covered by real,
  currently-passing tests with no live model call.

**NOT verified - genuinely cannot be, from this sandbox:** an actual
optimization run against a real Gemini API key. There is no
`GEMINI_API_KEY` available here, and this tool refuses to run without one
(see `require_api_key()`) rather than doing nothing silently or fabricating
a result. Running `python -m whatchat_prompt_optimizer.optimize` end to end
against a real dataset and a real key is the one thing left to actually try
in a real deployment - the code path to it is real, but has not itself been
exercised.

## Setup

```bash
cd services/prompt-optimizer
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## Running the tests (no API key required)

```bash
pytest
```

## Preparing a dataset

One JSON object per line (`.jsonl`). `customer_message` and `ideal_reply`
are required; everything else is optional context for that example
(defaults to empty if omitted):

```json
{"customer_message": "How much for a callout?", "ideal_reply": "It's $89, waived if you proceed with the repair.", "persona": "Friendly and concise", "tone": "warm", "business_context": "Plumbing company, standard callout fee $89.", "conversation_history": ""}
```

An unrecognized field, a missing required field, or invalid JSON on any
line is a hard error - see `examples/sample_dataset.jsonl` for a small,
real (if trivial) example. There is no synthetic dataset shipped for
production use: a real dataset has to come from your own real
conversations (or ones you write by hand as if they were real) - there is
no shortcut around needing real examples of what a good reply looks like.

## Running an optimization

```bash
export GEMINI_API_KEY=...   # real billed calls will be made with this key
python -m whatchat_prompt_optimizer.optimize \
  --dataset examples/sample_dataset.jsonl \
  --model gemini-3.5-flash \
  --optimizer bootstrap \
  --output artifact.json
```

- `--optimizer bootstrap` (default): cheaper, `dspy.BootstrapFewShot` -
  bootstraps a handful of few-shot demonstrations from your dataset.
- `--optimizer gepa`: DSPy's GEPA optimizer - more thorough (it reflects on
  its own failures and iterates), and makes substantially more model
  calls, so it costs more and takes longer.
- The metric (`metric.py`) is itself a real, separate LLM call per judged
  example - a dataset of N examples costs roughly N extra model calls just
  for scoring, on top of whatever the optimizer itself makes. There is no
  way around this cost for a task like reply quality, where exact-string
  matching is meaningless.

The output artifact looks like:

```json
{
  "optimizedInstruction": "...",
  "metricName": "reply_quality_metric",
  "metricScore": 0.87,
  "datasetSummary": {
    "exampleCount": 40,
    "trainCount": 32,
    "valCount": 8,
    "optimizer": "bootstrap",
    "model": "gemini-3.5-flash",
    "sourcePath": "examples/sample_dataset.jsonl"
  }
}
```

`metricScore` is computed on the held-out validation split only, never on
examples the optimizer trained on - a score computed on the training set
would overstate real quality.

## How this reaches a live agent

This file is never read directly by the Node application. A human:

1. Reads the artifact and judges whether the optimized instruction is
   actually good - DSPy proposing something does not make it correct.
2. Imports it: `POST /api/workspace/agents/:agentId/prompt-optimizations`
   with the artifact's JSON as the body (requires the `ai.edit`
   permission). This creates a `pending_review` row - the live agent is
   completely unaffected by this step.
3. Reviews it again in the Settings UI (or via
   `GET .../prompt-optimizations`), and either approves it
   (`POST .../prompt-optimizations/:id/approve`) - which copies the text
   into the live `ai_agents.system_instruction` through the exact same
   code path a manual Settings edit uses, audited the same way - or
   rejects it (`POST .../prompt-optimizations/:id/reject`), which never
   touches the live agent.

Every state transition writes a real `security_audit_logs` row
(`ai_prompt_optimization_imported` / `_approved` / `_rejected`) - there is
no silent path from "a Python script produced some text" to "a real
customer receives an AI reply built from that text."

## What this deliberately does not do

- It does not have any Postgres/Redis client, connection string, or
  credential anywhere in this directory - it cannot reach WhatchatAI's
  database even if you wanted it to.
- It does not run continuously and is not wired into any queue, worker, or
  API route in the Node app - there is no scheduled or automatic
  optimization pass. Re-running it is always a deliberate, manual action.
- It does not optimize the trusted, code-owned safety rules in
  `buildSystemInstruction()` (the current-time grounding, the
  advice-restricted-category hard scope limit, "never invent facts") -
  only the operator's own free-text `system_instruction` field is ever a
  candidate for optimization.
