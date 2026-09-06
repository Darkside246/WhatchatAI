# Handoff: `take_a_message` tool not firing in production

## Where things are
- Repo: this one. Branch `build/property-operations-os` (kept in sync with `checkpoint/property-operations-os-2026-09-05` — push to both after any commit).
- Production Droplet: `/opt/aura` on `sugarushbox.com`. Deploy = `git pull && docker compose up -d --build` (both `app-server` and `app-worker` rebuild/restart automatically; no other restart needed).
- Droplet currently deployed at commit **`8bfed58`** (confirmed via `git log -1` on the Droplet).
- Local dev: Windows box, real Postgres/Redis shared with a WSL2 Ubuntu distro at `localhost:5432`/`6379`. **Known flakiness**: this port-forwarding intermittently drops (`ECONNREFUSED` from Windows even though `pg_isready` from inside WSL says it's up) — if a local script/test hangs or fails to connect, check this first, don't assume the DB/Redis is actually down.

## The feature
`take_a_message` (`src/services/messages/takeMessageTool.ts`) is an AI tool: when a customer asks to have something relayed (e.g. "tell Hasan to call me at 6pm", or later just "remind him"), the AI should call this tool, which writes a row to `relayed_messages` and surfaces it on the Dashboard's "Messages for you" board (`MessageBoardCard` in `src/web/src/pages/DashboardRoute.tsx`). Repository: `src/repositories/relayedMessageRepository.ts`. Route: `GET/PATCH /api/workspace/relayed-messages`.

## The bug, still unresolved
Customer says something like "Can you tell Hasan to call me at 5:00" (or "remind me"). The AI replies with confident text like *"I've noted that down and left a message for Hasan"* — but **no row is ever written to `relayed_messages`**, and **no error is logged either** (the tool's execute branch in `aiReplyService.ts` only logs on a real write failure, not on "never called"). This proves Gemini simply never invokes the function — it's a prompt-reliability problem, not a wiring bug.

## What's already been fixed and confirmed deployed (in order)
1. `bb22410` — the whole feature: tool, repository, migration `1008_relayed_messages.sql`, dashboard board, tests.
2. `a252a02` — unrelated Docker build fix (Goose CLI needed `bzip2`).
3. `d96f7d7` — unrelated: auto-pause AI when a human replies from the dashboard composer.
4. `dba250b` — two real gaps found:
   - `take_a_message` was never added to the Agents page's "Capabilities" checkbox list (`TOGGLEABLE_TOOLS` in `src/web/src/pages/AgentsPage.tsx`) — an agent with "Restrict to selected capabilities" ON had no way to enable it at all. **Fixed.**
   - Strengthened the tool's own `FunctionDeclaration` description (`takeMessageTool.ts`) to explicitly treat "remind" as a trigger and default `recipientDescription` to "the owner" when no one is named.
5. **Confirmed live in production DB**: the specific agent handling the test chat (`52ad845e-e499-4693-8fb4-1490c37570c4`, named "A.U.R.A.") had `allowed_tools_enabled=true` with a stale `allowed_tools` list from before this tool existed — missing `take_a_message`. Patched directly via SQL, confirmed present afterward.
6. `8de378c` — migration `1009_backfill_take_a_message_tool.sql`: same fix as #5, applied globally to every existing agent across every business (not just this one).
7. Re-checked other possible gates on that same agent — **all clear**: `autonomy_level = 3` (Balanced, not the Read-only level-1 that would strip WRITE tools), `businesses.ai_actions_paused = false`.
8. `8bfed58` — added a universal, always-on system-prompt rule in `buildSystemInstruction()` (`src/services/aiReplyService.ts`, right after the existing "never use manipulative sales tactics" block, ~line 609): forbids the model from claiming an action (saved/noted/relayed/scheduled) was taken unless it actually called the tool and got a real success result this turn.

**Even after all of the above, tested live in production again — still no `relayed_messages` row.** The tool is available, no gate is blocking it, yet Gemini still doesn't call it.

## What we could NOT confirm yet, and why
We tried to check whether the AI's reply text itself changed (i.e. did it stop *claiming* success, even if it still didn't call the tool — that would prove rule #8 is at least partially working). **Could not read it**: `whatsapp_messages.text_content` is encrypted at rest (`EncryptionService`/`kmsKeyProvider.ts`, per-tenant DEK) — raw `SELECT text_content FROM whatsapp_messages` on the Droplet returns ciphertext, not plaintext. To actually read the real reply text, either:
- Look at the conversation directly in the AURA web dashboard (it decrypts server-side for display) — simplest, no code needed.
- Or write a small script that goes through the real `WhatsAppMessageRepository`/`EncryptionService` decryption path (not raw SQL) against the production DB.

We also attempted a **local repro**: call `generateAiReply()` directly against the real Gemini API (real key is in the local `.env`) with an agent object matching the production config exactly, to see directly whether Gemini calls the tool given identical inputs. This got interrupted repeatedly by the local WSL Postgres/Redis port-forwarding flakiness described above (connections would hang or ECONNREFUSED, not because of any app bug). **This local repro was never actually completed — worth finishing.** The temp script (`scripts/tmp-diagnose-take-a-message.ts`, already deleted, recreate from scratch or `git log -p` won't show it since it was never committed) did:
1. Insert a real test business/account/chat/inbound-message row directly via `pool.query`.
2. Call `gatherAiHandoffContext({businessId, chatId, contactId: null, queryText})` (the real function production uses) to get a valid, complete `AiHandoffContext`.
3. Build a fake `AiAgentRecord` matching production's confirmed config (`autonomyLevel: 3`, `allowedToolsEnabled: true`, `allowedTools` including `take_a_message`, `forbiddenTools: []`).
4. Call `generateAiReply(agent, context)` for real, print the result and whatever ended up in `relayed_messages`.
5. Clean up the test business (cascades).

## Recommended next steps, in priority order
1. **Read the real reply text** via the dashboard UI (fastest) to see if it still falsely claims success post-`8bfed58`. If it now hedges/refuses instead of lying, the prompt rule is working but the tool itself still isn't firing — that's a narrower, different problem (likely needs an even more explicit/example-driven tool description, or investigating this agent's own custom `persona`/`systemInstruction` text for something that competes with tool-calling).
2. **Finish the local repro** (once WSL networking is stable — check with `pg_isready -h localhost -p 5432` from both Windows Node and `wsl -d Ubuntu -e bash -lc "pg_isready ..."`; if Windows-side fails while WSL-side succeeds, the VM's `localhostForwarding` needs a nudge — try again after a few minutes, or `wsl --shutdown` and let it restart if truly stuck). A working local repro lets you iterate on the prompt fast without redeploying to the Droplet each time, and lets you inspect the *raw* Gemini response object (`result` from `generateAiReply`) directly — no decryption needed since this is a fresh local test DB.
3. **Add real, unencrypted diagnostic logging** in `aiReplyService.ts` right after the first Gemini call resolves (near where `first.toolCalls` is checked) — log the actual tool names Gemini returned for that turn (e.g. `console.log('[aiReplyService] tool calls:', first.toolCalls?.map(c => c.name))`). This is a small, safe, valuable change: it makes every future "is Gemini even trying to call the tool" question answerable directly from `docker compose logs app-worker`, without needing to decrypt anything or build a local repro each time.
4. Consider whether this specific agent's own `persona`/`systemInstruction` (it's an elaborate custom "A.U.R.A." persona built earlier in this project's history) contains anything that could be discouraging tool use in favor of "in-character" conversational responses. Worth reading the actual stored `persona`/`system_instruction` text for agent `52ad845e-e499-4693-8fb4-1490c37570c4` directly (also encrypted? — check; if not, `SELECT persona, system_instruction FROM ai_agents WHERE id = '52ad845e-e499-4693-8fb4-1490c37570c4';` on the Droplet).

## Everything else in this session (already shipped, working, not part of this bug)
- Dashboard "Messages for you" board + take_a_message tool (the base feature).
- Chat header no longer overlaps the Status panel (long member/team names were forcing it wider than available space — fixed in `ChatThread.tsx`).
- AI auto-pauses to Human Agent when you reply from the dashboard composer while AI Autonomous is selected (previously only detected replies typed directly on the phone).
- Goose fallback confirmed genuinely reachable in production (`docker compose exec app-server` → `http://goose:3284/health` returns `available` with the correct `Authorization: Bearer <GOOSE_SERVICE_API_KEY>` header).
- Full backend regression suite was green (259 files / 2183+ tests) as of the last full run before this bug's investigation began.
