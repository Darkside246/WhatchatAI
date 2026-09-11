# Resolved: `take_a_message` was never reaching Gemini at all

**Status: FIXED.** This file previously described this as an open,
unsolved bug and told the next engineer to keep hunting for it. It was
solved shortly after that text was written, and left stale — which is worse
than having no note at all, because it sent people looking for a problem
that no longer existed. This is the postmortem that replaces it.

## What people saw

A customer would say something like *"can you tell Hasan to call me at 6"*.
The AI replied with confident text — *"I've noted that down and left a
message for Hasan"* — and **no row was ever written to `relayed_messages`**.
No error was logged either.

## Everything that looked like the cause, and wasn't

Each of these was a real gap, each was genuinely fixed, and **none of them
was the cause**:

| Fix | What it addressed |
|---|---|
| `bb22410` | The feature itself: tool, repository, migration `1008`, dashboard board |
| `dba250b` | `take_a_message` was missing from the Agents page capability list, so a restricted agent could never enable it |
| `8de378c` | Migration `1009` backfilled the tool into every pre-existing agent |
| `8bfed58` | A system-prompt rule forbidding the model from claiming an action it never took |

After all of that, tested live in production again: **still no row.** The
tool was available, no gate was blocking it, and the model still never
called it.

## The actual root cause

`2473015` added diagnostic logging of the tool calls Gemini really returned
per reply. That immediately showed the truth: **every single reply from this
agent was hitting a 400 on the primary Gemini call and silently retrying
without tools.**

The one difference between the failing primary request and the succeeding
bare retry was:

```ts
thinkingConfig: { thinkingBudget: 0 }
```

That parameter made the deployed model reject the request outright, with
tools and temperature present. The bare-retry fallback then produced a
normal-looking reply with **no tools available at all** — so
`get_current_time`, `take_a_message`, every tool, had been silently
unavailable the whole time, with no visible error anywhere.

`2a11ad7` removed it. `maxOutputTokens` alone remains as the response-length
safety net.

## The second bug hiding behind the first

The moment tool-calling actually worked, a real error surfaced:

> Function call is missing a thought_signature in functionCall parts

Gemini's newer models attach an opaque per-part `thoughtSignature` to a
function-call part and require it echoed back verbatim on the next turn.
`response.functionCalls` strips it. `2be3901` reads the original parts from
`response.candidates[0].content.parts` — the one place it actually lives —
to build the follow-up turn instead of reconstructing bare `{functionCall}`
objects.

## What to take from this

1. **A silent fallback is worse than a loud failure.** The bare-retry path
   was doing exactly what it was designed to do, and in doing so it hid a
   total loss of tool-calling behind replies that read perfectly well. The
   diagnostic logging added in `2473015` is what made it findable in
   minutes; it is still there, and still worth keeping.
2. **Four plausible causes were found and fixed before the real one.** Every
   one was a genuine gap worth closing — but none of them moved the needle,
   and that itself was the signal that the search was in the wrong layer.
3. **`check-ai-call-sites.ts` and the route-authorization guard exist for
   this class of problem.** Both caught real mistakes during later work on
   this branch.

## Still true, and worth knowing

- Message bodies are encrypted at rest (`EncryptionService`, per-tenant
  HKDF-derived key). A raw `SELECT text_content FROM whatsapp_messages`
  returns ciphertext. To read real reply text, use the dashboard (which
  decrypts server-side) or go through `WhatsAppMessageRepository`. This is
  why the original investigation could not simply read what the AI had said.
- Production deploy is `git pull && docker compose up -d --build` in
  `/opt/aura`; both `app-server` and `app-worker` rebuild and restart.
