# Goose integration - what is real, and what is not

Status as of Phase F4.1. Everything below was verified against upstream
`block/goose` at commit `7c4ba22` (main), not from memory.

## What Goose actually is

Goose is Block's open-source, on-machine autonomous agent: it writes and
executes code, debugs, orchestrates workflows, drives MCP extensions, runs
subagents and recipes, and works with any LLM provider. It is a genuine
agent, not a model and not an inference API.

## What WhatchatAI currently does with it

`src/services/gooseService.ts` treats it as a **text completion endpoint**:

```
POST <GOOSE_SERVICE_URL>/generate
  { systemInstruction, contents } -> { text }
```

That call happens in exactly one place - `tryGooseFallback()` in
`aiReplyService.ts`, only after a real Gemini failure - and it generates the
reply using the **already-routed WhatchatAI agent's** persona and system
instruction. None of Goose's agency (tools, subagents, recipes, MCP) is
wired in.

## The gap you must know about before configuring it

**Goose does not expose that endpoint.** Its real surfaces are:

| Surface | Transport | Notes |
| --- | --- | --- |
| `goose-cli` | process (`goose run -t ...`) | headless mode |
| `crates/goose/src/acp/server` | JSON-RPC over **stdio** | Agent Client Protocol, for editors |
| `goose gateway` | chat-platform bridge | only `telegram.rs` exists upstream |

There is no `POST /generate` returning `{ text }`. So setting
`GOOSE_SERVICE_URL` to a Goose installation will not work. Something must
sit in between implementing the contract above - typically a small service
that shells out to `goose run` and returns the output.

Until such a service exists, the honest state is `not_configured`, which is
exactly what `/api/workspace/ai-engines` reports and what the AI panel
shows.

## Why we did not build that shim

Goose needs its own LLM provider. If Goose is configured with Gemini, then
"Gemini failed -> fall back to Goose" calls the provider that just failed.
The failover is circular and buys nothing in the one scenario it exists for.

A real failover for an unavailable Gemini is **a second provider**
(Anthropic, OpenAI, or a local model), not an agent framework wrapping the
same one. If reply resilience is the goal, that is the change to make - not
this.

## Where Goose genuinely fits this product

Not in the customer-facing agent panel. Those agents are routed **untrusted
text typed by strangers on WhatsApp**; Goose has shell, filesystem and MCP
access on the host. Joining those two populations in one graph - where an
operator can drag an escalation line from a bookings agent to Goose - puts
customer input one hop from code execution. That is the "AI as untrusted
interface" risk recorded in the Phase C audit.

The safe and genuinely useful fit is **operator-triggered internal
automation**, on the operator's own machine, never reachable from inbound
routing: invoice batch generation, CRM export reconciliation, scheduled
report builds. That is a separate surface with its own audit trail, and it
is not built yet.

## Installing Goose (for that future use, on your own machine)

From upstream's current documentation:

```bash
# CLI
curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash

# Desktop (macOS)
brew install --cask block-goose
```

Note on forks: `jackjackbits/goose` was evaluated and is a clean mirror -
0 commits ahead of upstream, but 4,009 behind, last commit 2025-06-10.
There is no reason to prefer it over `block/goose`.
