# Phase 3A: AI Reliability / Gemini 429 Protection — Audit and Proposal

**Status: read-only audit + design proposal. No code, schema, or
configuration changes in this document.** Mirrors the Phase 2A workflow:
audit → proposal → review gate → implementation. Scope is the AI reply
pipeline's reliability characteristics only — error classification,
circuit-breaker behavior, and inbound-message debouncing. Message
persistence, the Tiered Security Sentinel, agent configuration, and CRM/
knowledge-base context gathering are traced only far enough to establish
their real interaction with this pipeline, never modified or redesigned.

---

## 1. Current pipeline, traced

**Call chain for a live inbound text message**: `incomingMessagesWorker.ts`'s
`processJob` → (Sentinel, persistence — out of scope) → `runAiHandoff` →
`aiOrchestrator.orchestrateAiReply` → `agentRoutingService.routeInboundMessage`
(keyword routing, in parallel with context gathering) → `aiReplyService.generateAiReply`
→ Gemini (`@google/genai`) → on any non-'generated' outcome, **one**
escalation hop to a configured fallback agent (same `generateAiReply` call
again) → `whatsappOutboundMessageService.send`.

**`generateAiReply`'s own internal fallback chain**, every real call site:

1. `getGeminiClient()` returns `null` if `GEMINI_API_KEY` is unset →
   immediately `tryGooseFallback` (no real HTTP call attempted).
2. `geminiCircuitBreaker.canAttempt()` false (circuit `OPEN`, cooldown not
   yet elapsed) → immediately `tryGooseFallback` (no real HTTP call).
3. Otherwise, a real `generateContent` call. Two special-cased branches
   exist today:
   - A `400 ApiError` triggers exactly one bare-minimum retry (system
     instruction only, no tools/thinkingConfig) — a real, evidence-based
     fix for one specific proven-bad parameter combination.
   - A 404/410-equivalent for media downloads (Phase 2, different
     subsystem) — not applicable here.
4. **Every other outcome** — a 429 (quota/rate limit), a 500/503 (Google
   backend issue), a network timeout, a wrong model name, an expired key,
   a genuine bug in this codebase's own request construction — lands in
   one generic `catch (error)` block, becomes one generic `reason` string,
   and is fed to `geminiCircuitBreaker.recordFailure(reason)` **identically**.
5. `tryGooseFallback` is then attempted (workspace or env-configured Goose
   endpoint); if that also fails, the combined result is `'unavailable'`.
6. Back in `orchestrateAiReply`: if the primary agent produced anything
   other than `'generated'`, **one** escalation hop repeats the entire
   chain above (steps 1-5) for a second, operator-configured agent — with
   no awareness of *why* the first agent failed.

**The circuit breaker** (`aiCircuitBreaker.ts`) is a single, unclassified
per-process counter: `failureThreshold` (default 3) consecutive failures of
*any* kind open it for `cooldownMs` (default 60s), after which one
`HALF_OPEN` probe is allowed. It does not distinguish a 429 from an
invalid API key from a malformed request from a genuine bug in this
codebase.

**No debounce exists.** Each inbound WhatsApp message is its own
independent BullMQ job on `incoming_messages`. If a customer sends three
messages in quick succession ("hi" / "I need help" / "with my order"),
`processJob` runs three times, and — if each message independently
satisfies the AI-handoff conditions — three separate `orchestrateAiReply`
calls fire, each with its own conversation-history snapshot, each
potentially issuing its own real Gemini (and possibly Goose) call, each
capable of producing its own separate outbound reply. Keyword routing
(`routeInboundMessage`) also evaluates only the single triggering message's
text, never the customer's whole burst.

**A related, adjacent finding**: `runAiHandoff`'s final
`whatsappOutboundMessageService.send(...)` call is not wrapped in a
try/catch. If it throws (e.g. a transient DB error), the exception
propagates out of `processJob`, and the *whole* `incoming_messages` job
(already-committed Sentinel+persistence included) is retried by that
queue's own `attempts: 3`/backoff config. Persistence is idempotent
(`ON CONFLICT DO NOTHING`) so a retry there is safe, and the outbound send
itself is idempotency-keyed (`ai-reply:${messageId}`) so a duplicate
*send* is prevented — but nothing prevents a duplicate real *Gemini call*
on that retry. This directly compounds quota pressure in exactly the way
this phase is meant to protect against, even though its root cause is a
queue-retry interaction, not the Gemini call path itself.

**The Sentinel is architecturally independent** (confirmed, not assumed):
`security/sentinel/aiSentinel.ts` shares `getGeminiClient()`'s API key/
client singleton but has **no** circuit breaker of its own and fails
per-call to an honest `'unavailable'` verdict, deferring to the Stage 1
heuristic gate. It is not coupled to `geminiCircuitBreaker` in any way — a
change to that breaker's behavior cannot affect the Sentinel, and Phase 3
must keep it that way (the Sentinel's own fail-open-to-Stage-1 design is
already correct and out of scope).

**SDK constraint, confirmed by reading `node_modules/@google/genai`'s type
declarations**: `ApiError` exposes only `status` (HTTP status code) and
`message` — there is no `Retry-After` header or server-suggested delay
surfaced anywhere in this SDK version. Any backoff timing this phase
proposes must be our own scheme, not "honor the server's header," because
that signal genuinely does not exist here.

---

## 2. Findings

1. **No error classification.** A 429 is handled identically to an
   invalid API key, identically to a malformed request, identically to a
   bug in this codebase's own code. The master directive's 5-way taxonomy
   (capacity/transient, auth/authz, malformed-request, provider/
   model-config, application/programming) does not exist today, beyond
   the one narrow 400-retry special case.
2. **The circuit breaker conflates "will recover on its own" with "will
   never recover without a human."** A burst of 429s (which often clears
   in seconds) and three consecutive invalid-API-key failures (which will
   never clear until an operator fixes the key) open the exact same
   circuit for the exact same 60s cooldown. Neither is optimal: the
   429 case may still be blocking Gemini for 60s after quota already
   recovered, and the bad-key case silently re-attempts and re-fails
   forever, every `cooldownMs`, with no signal ever reaching an operator.
3. **No operator notification for a persistently broken Gemini
   configuration.** Compare to Phase 0's own finding (already fixed
   elsewhere in this codebase) that `'no_agent'`/`'escalate_to_human'`/
   `'unavailable'` outcomes now notify the business via `notifyBusiness`
   — that exists at the *orchestration* outcome level, but nothing
   distinguishes "Gemini is misconfigured and will stay broken until you
   fix it" from "Gemini had a rough minute" in the notification itself.
   An operator could be silently running on Goose-only (or fully
   unavailable) for weeks with no indication *why*.
4. **No debounce/coalescing for rapid-fire inbound messages**, per the
   master directive's explicit requirement. This is the mechanism most
   directly protective against burning quota unnecessarily — one customer
   sending a thought across several messages should ideally cost one
   Gemini call, not N.
5. **The escalation hop is failure-reason-blind.** It already avoids a
   wasted real call when the failure was "no API key" or "circuit open"
   (both short-circuit before any HTTP call), but for a genuine mid-call
   failure (a 429, a 500, a real network error) it retries the *identical*
   call shape against a second agent with no adjustment — a provider
   outage affecting agent A's call will, in virtually every real case,
   affect agent B's call identically, immediately after.
6. **Queue-level retry can duplicate a real Gemini call** (§1's adjacent
   finding) — a transient failure unrelated to AI at all (a DB blip on the
   outbound-send insert) can cost a second real API call for the same
   inbound message.

---

## 3. Proposed error taxonomy

Built from the real branches `generateAiReply`'s catch block can actually
observe today (an `ApiError` with a `status`, or a non-`ApiError` thrown
value):

| Class | Real signal | Retryable within this call? | Feeds circuit breaker? |
|---|---|---|---|
| **Capacity/transient** | `ApiError` with `status` 429, 500, 502, 503, 504; or a non-`ApiError` network-shaped failure (timeout, `ECONNRESET`, DNS) | Yes — falls to Goose this call, but classified so a *future* call can be retried sooner (§4) | Yes, on a short-cooldown breaker |
| **Auth/authz** | `ApiError` with `status` 401 or 403 | No — will not recover until a human changes the key | No (see §4 — a distinct, longer-lived signal instead) |
| **Malformed-request** | `ApiError` with `status` 400 | The existing one bare-minimum retry already handles this; if that also fails, non-retryable this call | No |
| **Provider/model-config** | `ApiError` with `status` 404, or a 400 whose message indicates an unknown/unsupported model (best-effort message match, since the SDK gives no structured field for this) | No — a wrong `GEMINI_REPLY_MODEL` will not fix itself | No (same distinct signal as auth/authz) |
| **Application/programming** | Any thrown value that is not an `ApiError` at all, or an `ApiError` with an unrecognized status | No — retrying a bug is not a capacity strategy | No, but logged loudly (see §5) |

This mirrors Phase 2B's own retryable/terminal discipline: classify first,
then decide whether to retry — never retry reflexively.

---

## 4. Proposed circuit-breaker changes

Two real problems to solve, kept as two small, targeted changes rather
than a new framework:

- **Only capacity/transient failures should feed the existing
  `geminiCircuitBreaker`.** Auth/authz, provider/model-config, and
  application/programming failures should **not** increment its
  consecutive-failure counter — retrying them via the existing breaker's
  probe mechanism cannot help, so counting them toward the same threshold
  as genuine capacity blips just makes the breaker trip (and block
  capacity-class recovery attempts) for the wrong reason.
- **A second, separate signal for "this will not recover without a
  human"** — auth/authz and provider/model-config failures. Proposed:
  reuse the existing `CircuitBreaker` class (it already models exactly
  "open until an operator-relevant condition changes") as a second named
  instance (e.g. `geminiConfigBreaker`) with a much longer cooldown (e.g.
  1 hour, configurable), whose sole purpose is **not** to gate whether a
  call is attempted (a config error should still surface honestly on
  every real call, never silently skipped) but to gate a **notification**:
  the first time it opens, fire one `notifyBusiness` (`AI_FAILURE`,
  reusing the existing pattern) saying plainly that Gemini is
  misconfigured and needs attention, and suppress repeat notifications
  until the cooldown elapses — so an operator is told once, promptly, not
  spammed on every message, and not left silently uninformed for weeks
  either.
- **Capacity breaker cooldown**: kept at the existing default (60s,
  `GEMINI_CIRCUIT_COOLDOWN_MS`, unchanged) — real evidence from this audit
  does not show that value to be wrong, only that it was being reached by
  the wrong kind of failure. No numeric change proposed without evidence
  a specific value is actually wrong.

---

## 5. Proposed debounce design

The core requirement: preserve ordering, never lose a message, coalesce a
rapid-fire burst into one real AI call rather than N.

**Rejected approach**: cancel-and-reschedule a delayed BullMQ job per
chat. BullMQ has no clean "reset an existing delayed job's timer"
primitive that fits this codebase's existing patterns, and building one
would be new queue-level machinery for a problem better solved at the data
level.

**Proposed approach — coalesce at handoff time, not at schedule time**:

1. When a genuinely new, live, inbound, AI-eligible message is persisted,
   instead of triggering `runAiHandoff` immediately, enqueue a small
   **debounce job** with a short fixed delay (proposed default 6s,
   `AI_DEBOUNCE_DELAY_MS`, configurable) and a **deterministic jobId keyed
   by `chatId`** (`ai-debounce-${chatId}`) — the same dedup primitive
   Phase 2B introduced for media downloads. A second, third, etc. message
   arriving for the same chat within that window enqueues the *same*
   jobId; BullMQ's existing duplicate-jobId rejection means only the
   *first* message in a burst actually schedules a real delayed job — no
   new BullMQ capability required, reusing exactly what Phase 2B already
   proved works.
2. When the debounce job fires (after the idle window), it does **not**
   carry a specific message's data. Instead it re-queries the chat for
   every inbound message **newer than the chat's last AI-authored/sent
   message** (a real, already-derivable condition from `whatsapp_messages`
   — no new column needed) and builds one combined query turn from all of
   them, in chronological order, then calls `orchestrateAiReply` **once**
   for the whole burst. This is what makes ordering-preserving and
   loss-safe true by construction: nothing is discarded because nothing
   was ever attached to an individual job; the job is only a "check now"
   signal, and the query at fire-time is the actual source of truth.
3. **Keyword routing** (`routeInboundMessage`) would run against the
   *concatenation* of the burst's message texts (chronological order,
   newline-joined), not just the first or last fragment — directly closes
   Finding 4's routing-fragment problem. This is a real behavior change
   to routing and is called out explicitly for review, not assumed
   acceptable.
4. **Media-triggered messages are explicitly excluded from debouncing** —
   `maybeTriggerMediaAiHandoff` fires only after a real download outcome
   is already known, which is its own natural, already-correct timing
   signal; folding it into the text debounce window would entangle two
   different triggers for no real benefit.
5. **Failure/crash safety**: if the worker process dies between step 1
   and step 2, the debounce job is simply gone (same class of gap as
   Phase 2B's crash-recovery finding, and for the same reason — nothing
   unrecoverable is lost, since the *messages themselves* are already
   durably persisted; only the "please check this chat" signal is lost).
   Proposed mitigation, mirroring Phase 2B's sweep pattern: a scheduled
   sweep that finds AI_ACTIVE chats with an inbound message newer than
   the last AI-authored message and no debounce job outstanding, and
   re-triggers one — the same "reconcile a state a crash could have
   interrupted" pattern this codebase already uses six times.

**Open question this proposal surfaces rather than silently resolves**:
6 seconds is a real guess, not evidence-derived. The right default trades
off "wait long enough that a genuine multi-message burst is captured"
against "reply quickly enough that a single, complete message doesn't
feel sluggish." This needs your judgment on the number, not mine.

---

## 6. What Phase 3B would actually touch

- **`aiCircuitBreaker.ts`**: add the classification-aware `recordFailure`
  signature (accepts a category), and a second `geminiConfigBreaker`
  instance for the notification-gating purpose in §4.
- **`aiReplyService.ts`**: classify the catch block's error per §3 before
  deciding whether to feed which breaker; no change to the existing
  400-retry-once behavior, only formalizing its classification.
- **`aiOrchestrator.ts`**: the escalation hop gains awareness of whether
  the first failure was capacity/transient (worth a second real attempt)
  vs. anything else (skip straight to Goose/unavailable for the
  escalation agent too, since retrying a config/programming error against
  a second agent cannot succeed).
- **New**: a debounce job type on `realtimeEventsQueue` (or a new small
  queue — a design choice for the proposal review, not decided here),
  the burst-coalescing query, and the crash-recovery sweep from §5.
- **`incomingMessagesWorker.ts`'s `processJob`**: the immediate
  `runAiHandoff` call for a live text message is replaced by the debounce
  enqueue from §5.
- **Fix for the adjacent finding (§1/§2.6)**: wrap
  `whatsappOutboundMessageService.send` in `runAiHandoff` with a
  try/catch that logs and swallows rather than lets the whole
  `incoming_messages` job retry — the AI reply itself already succeeded
  by that point; a failed *send* should not re-run AI generation.
- **Explicitly untouched**: the Sentinel (`aiSentinel.ts`,
  confirmed architecturally independent in §1), message persistence,
  agent CRUD, CRM/knowledge-base context gathering, WhatsApp connection/
  pairing, and everything from Phases 1-2.

## 7. Regression test plan (for Phase 3B)

1. A 429 (mocked `ApiError`, status 429) is classified capacity/transient,
   falls back to Goose for that call, and feeds only the capacity breaker.
2. Three consecutive 429s open the capacity breaker; a 401 immediately
   after does **not** additionally count toward it (already a fresh
   counter class).
3. A 401 opens the config breaker and fires exactly one `AI_FAILURE`
   notification; a second 401 within the cooldown does not re-notify.
4. The existing 400-bare-retry behavior is unchanged (regression, not new).
5. A rapid burst of 3 messages to the same chat within the debounce window
   produces exactly one `orchestrateAiReply` call, combining all 3 texts
   in order.
6. A single, isolated message (no burst) still gets a reply — debouncing
   must never turn into "always wait needlessly."
7. A message arriving after the debounce window has already fired
   correctly starts a *new* debounce window (never merged into the
   already-fired one, never dropped).
8. Crash-recovery sweep: a chat with a newer inbound message than its last
   AI reply, and no live debounce job, gets a real reply after the sweep
   runs.
9. `whatsappOutboundMessageService.send` throwing no longer causes the
   whole `incoming_messages` job (and a duplicate Gemini call) to retry.
10. Cross-tenant: the debounce job's chat lookup is business-scoped
    (`findByIdForBusiness`), never a bare id lookup.

No code, schema, or configuration changes were made in this phase.
Awaiting explicit approval of this proposal — in particular the debounce
window value and the debounce-queue design choice in §6 — before Phase 3B
begins.
