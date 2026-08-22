# CHANGELOG_SECURITY.md

## 2026-08-22 - OpenClaw Cell Runtime: per-cell relay - real network policy enforcement boundary (Phase 1: implemented, unit-tested; real-hardware Phase 2 verification pending)

**Branch:** `openclaw-cell-runtime`. New: `src/relay/openclawRelayServer.ts`,
`src/relay/privateAddressCheck.ts`, `src/relay/index.ts`,
`test/openclawRelayServer.test.ts`, a `relay-runtime` Dockerfile stage.
Modified: `src/services/dockerCellRuntime.ts` (relay lifecycle wiring) and
its test suite.

**Why:** real Stage 0 evidence (this session, on the user's machine) showed
`--internal` blocks host-gateway routing entirely, not just general
internet egress - a hardened cell cannot reach the WhatchatAI MCP endpoint
at all as things stood. A candidate fix (`enable_ip_masquerade=false` on a
second bridge network) was tested for real and disproven - it did NOT
block general internet egress on this Docker Desktop/WSL2 setup
(`example.com`/`1.1.1.1` both returned real 200/301, not blocked). A
second candidate (host-level `DOCKER-USER` iptables allow-listing) was
ruled out for a different reason: no `iptables`/`nft` tooling exists in
this Docker Desktop VM at all, and more importantly, host-level firewall
administration isn't something `dockerCellRuntime.ts` could portably
manage in production anyway - it only orchestrates containers/networks
through the Docker API, never the host OS.

**Approved design:** a dedicated, per-cell relay container - not a
general-purpose proxy, a destination-specific egress gateway with a
structural two-route allow-list (`/mcp`, `/gemini/*`) and no mechanism
anywhere in its code capable of accepting a caller-supplied forwarding
target. One relay per cell (not shared across tenants), attached into
that cell's own existing `--internal` network (so the cell can reach it,
exactly as it always could reach anything else on that network) plus a
second, dedicated, NOT-`--internal` egress network that only the relay
ever joins - the cell itself never touches it. A compromised relay has no
network membership anywhere near another cell or its relay.

**`openclawRelayServer.ts` - the enforcement logic itself:**
- Fixed upstream identities only (`mcpUpstreamUrl`, optional
  `geminiUpstreamHost`), read once at server-construction time - never
  derived from a request. Any path outside `/mcp` (POST) or `/gemini/*`
  returns 404 before any outbound attempt at all.
- DNS-rebinding defense on the Gemini route: resolves the configured
  hostname itself, connects to the resolved IP directly (not a second,
  separate lookup at connect time), and rejects private/loopback/
  link-local/CGNAT-range results outright. The MCP route's target
  (`host.docker.internal`) is the deliberate, sole exception.
- No redirect-following - a 3xx from either upstream passes straight back
  to the cell; since the cell has no route anywhere except the relay,
  an attempted redirect to an unapproved host is simply unreachable.
- Bounded request body size (413 before forwarding, not after), bounded
  request timeout (60s default - a firm cap, learning from the earlier
  `security audit --deep` hang that came from an uncapped outbound call).
- Logging is metadata-only by construction: timestamp, route, method,
  *path only* (never the query string - Gemini's own convention can put
  the API key there, not just in a header), upstream status, latency,
  byte counts. The `Authorization` header passes through untouched and
  is never logged, matching the credential-handling discipline already
  used for Gateway/callback tokens.

**Tested standalone, no Docker required (30 tests):** real HTTP requests
against the real relay via two local stand-in upstream servers - exact
forwarding (method/headers/body verbatim), the full unknown-path 404
allow-list (including a path-traversal-style segment that normalizes to
a real route rather than bypassing the check), no-Gemini-upstream-
configured 404, real private-address rejection (`localhost` resolving to
loopback), oversized-body rejection, and two dedicated tests proving
nothing sensitive - not the body, not the Authorization header, not the
query string - ever reaches a log line. A private-address-check unit
suite covers real IPv4/IPv6 private/loopback/link-local/CGNAT ranges
against real public-range shapes.

**`dockerCellRuntime.ts` wiring:** `create()` now also creates the
relay's dedicated egress network, runs the relay container (own,
lighter hardening profile: `--cap-drop ALL`, `--security-opt
no-new-privileges`, `--read-only`, `--pids-limit 64`, `--memory 256m`,
`--cpus 0.5`, no published port), connects it to the egress network, and
health-gates on the relay the same way it already does for the cell
itself. `stop()`/`start()`/`upgrade()`/`remove()` all extended
symmetrically - relay stop is best-effort (a stopped cell can't reach it
anyway), relay removal happens before cell removal in `remove()`, and
`upgrade()` removes the pre-upgrade relay before `create()` re-runs it
(otherwise the container-name collision would fail the upgrade). 37
tests covering the full new lifecycle (mocked `execFile`, same pattern
this file's tests already used - no real Docker daemon available in this
sandbox to build/run the relay's own image against).

**Relay image:** built from this same repository (new `relay-runtime`
Dockerfile stage), not pulled from a registry - `docker build --target
relay-runtime -t whatchatai-openclaw-relay:local .`. Needs no
`node_modules` at all (the relay's own code imports nothing but Node
built-ins), keeping its own supply-chain surface as small as its role -
network policy enforcement boundary - calls for.

**Status: `IMPLEMENTED AND UNIT-TESTED`, real-hardware Phase 2
verification not yet run.** 657/657 tests passing, full typecheck clean,
a real `tsc` build confirmed producing `dist/relay/{index,
openclawRelayServer,privateAddressCheck}.js`. Per the user's own Phase
1/Phase 2 split: this entry covers Phase 1 (design + implementation +
unit tests) only. Phase 2 - proving `cell → relay → MCP` works, `cell →
internet` fails, `cell → another cell` fails, `cell → arbitrary IP`
fails, `relay A cannot become a path to cell B`, removing a cell removes
its relay, restarting doesn't broaden access - requires the real Docker
image build and real container tests this sandbox cannot run, and is the
explicit next step on the user's own machine. No credential of any kind
is involved yet; the feature flag and any live-agent wiring remain
untouched.

## 2026-08-22 - OpenClaw Cell Runtime: real WhatchatAI MCP server (`update_lead`), standalone-tested against a real MCP client

**Branch:** `openclaw-cell-runtime`. New files: `src/services/openclawMcpServer.ts`,
`src/server/openclawMcpRouter.ts`, `test/openclawMcpServer.test.ts`. Modified:
`src/server/index.ts` (feature-gated mount), `package.json`
(`@modelcontextprotocol/sdk` added, the official SDK - not hand-rolled).

**Scope, exactly as approved:** a thin MCP protocol-translation layer in
front of the existing, unmodified `OpenClawToolGateway.invoke()`. Exposes
exactly one tool, `update_lead`. No new WRITE tools, no direct database
or repository access from the MCP layer, no second policy engine, no
second rate limiter, no bypass around `openclawToolGateway.ts` - the
gateway remains the sole authorization authority, unchanged.

**Authentication mirrors the existing REST adapter exactly:**
`authenticateOpenClawMcpCaller()` in `openclawMcpServer.ts` is the same
Bearer-token, hash-looked-up mechanism `openclawAdapterService.ts`
already uses (`OpenClawCellRepository.findByCallbackTokenHash`) - just
read from the MCP transport's own request headers instead of an Express
`req`. `businessId`/`cellId` come ONLY from the authenticated cell record
this resolves to, never from an MCP tool argument - a cell cannot
present its own real token and then claim to act as a different tenant
or cell by writing a different value into `tools/call` arguments.

**`chat_id`/`cell_generation` are ordinary tool arguments, not a new
design decision:** the existing, already-reviewed REST adapter already
treats both as caller-claimed body fields (see its own doc comment) -
a wrong `cell_generation` only ever produces a real gateway DENY via the
existing fencing check, never a privilege escalation, so exposing it as
a model-visible MCP argument carries the same safety property the REST
path already has. No new trust boundary was invented for this.

**Idempotency:** the model's own `idempotency_key` argument is passed
straight through to the gateway's existing conflict-detection logic - no
second idempotency scheme.

**Feature-gated, disabled by default:** `openclawMcpRouter` is only
mounted at `/api/openclaw/mcp` when `OPENCLAW_MCP_SERVER_ENABLED=true`.
Stateless Streamable HTTP transport (`sessionIdGenerator: undefined`) - a
fresh `McpServer`/transport pair per request, bound to that request's own
authenticated identity, no session state.

**Tested standalone against a real MCP client, twice, before any
live-agent wiring:**
1. `test/openclawMcpServer.test.ts` (24 tests, real Postgres, real
   `OpenClawToolGateway`) drives the real `@modelcontextprotocol/sdk`
   `Client` class against the real `createOpenClawMcpServer()` via the
   SDK's own `InMemoryTransport.createLinkedPair()` - a genuine MCP
   client/server session, not a hand-rolled protocol fake. Covers:
   `tools/list` exposes only `update_lead`; a real `tools/call` reaches
   the gateway and actually mutates the lead; a stolen token from a
   different tenant is denied even when arguments claim the victim's
   entity/chat; invalid auth never reaches tool registration; idempotent
   replay; conflicting idempotency-key reuse denied; stale generation
   denied by the real fencing check; a quarantined cell denied; an
   unrecognized field denied by the existing allow-list.
2. Separately, a real disposable end-to-end round trip: the actual
   server booted with `OPENCLAW_MCP_SERVER_ENABLED=true`, a real
   business/cell/lead provisioned against a real dev Postgres, then
   driven over genuine HTTP (raw `curl` JSON-RPC, not a library) through
   `initialize` -> `notifications/initialized` -> `tools/list` ->
   `tools/call`. Confirmed real protocol negotiation
   (`protocolVersion: "2025-11-25"`), the real tool schema, a real DENY
   on a bad token (401, correct JSON-RPC error shape), and a real lead
   row mutation (`status: QUALIFIED`, `notes` set) driven purely through
   the wire protocol. Disposable server/DB rows only - no production
   data, no real OpenClaw cell involved.

**Explicitly NOT done yet, per the user's own ordering:** this MCP
server is not wired into any live OpenClaw agent or cell config, and the
feature flag is not enabled anywhere - both remain the next, separate
step once the user reviews this standalone verification.

**Full 12-point acceptance criteria - all met:** `tools/list` exposes
only `update_lead`; `tools/call` reaches the real
`OpenClawToolGateway.invoke()`; no direct database mutation from the MCP
layer; cell identity authenticated server-side; `business_id`/`cell_id`
not overridable by model-controlled parameters; existing entity-ownership,
fencing, idempotency, and quarantine checks all still execute unmodified;
cross-tenant attempts denied; invalid authentication denied; replayed
operations remain idempotent; conflicting idempotency reuse denied; the
existing Gemini/Baileys AI-reply path is completely untouched; the
component is feature-gated and disabled by default.

**Status: `IMPLEMENTED AND VERIFIED (standalone)`.** Full test suite (624
tests) and typecheck (backend + frontend) both pass with no regressions.
Live-agent wiring and feature-flag activation remain a deliberately
separate, later step.

## 2026-08-22 - OpenClaw Cell Runtime: state-directory permission fix confirmed correct on a real Linux filesystem

**Branch:** `openclaw-cell-runtime`. Verification only - no code changed.

**Context:** the `ensureStateDir()` chmod(0o700) fix (an earlier entry
today) still showed `fs.state_dir.perms_world_writable` (CRITICAL,
`mode=777`) in a real in-cell audit even after the fix landed. The
suspected cause was that the test host's bind-mount source was a genuine
Windows NTFS path (`C:\Users\...`), and NTFS has no real POSIX permission
model for Docker Desktop's bind-mount translation to honor - a `chmod`
from inside the Linux container can't achieve anything there regardless
of the value requested. A differential test was run to confirm or refute
this rather than accept it as a plausible-sounding guess.

**Real differential test:** the exact same code, same container command,
run twice - once with the state directory on a Windows NTFS path (prior
entry, `mode=777`, 1 CRITICAL finding), once with `OPENCLAW_CELL_STATE_DIR`
pointed at a genuine WSL2-native (ext4) path under `/home/<user>/...`,
confirmed via `uname -a` reporting a real `microsoft-standard-WSL2` Linux
kernel (not a Windows-emulating shell) before running.

**Result on the real Linux filesystem:**
- `ls -la` on the host: `drwx------` on the cell's state directory -
  exactly `0700`, matching what the code sets.
- The in-cell audit: `"critical": 0` - `fs.state_dir.perms_world_writable`
  does not appear at all.

**Conclusion, now confirmed rather than inferred:** the fix is correct
and effective on a real Linux filesystem, which is what production
actually runs on. The `mode=777` finding was genuinely specific to
Docker Desktop's NTFS bind-mount handling on the Windows test machine,
not a defect in `dockerCellRuntime.ts`. No code change needed - this
entry exists to record the real evidence rather than leave the earlier
"not yet confirmed whether this is environment-specific" caveat
unresolved.

**Status: `IMPLEMENTED AND VERIFIED`**, unconditionally now (previously
verified only for the mocked test suite, with a real but unresolved
platform question). `tools.elevated`/browser control were also
reconfirmed disabled in this same run - no regression.

**Still open, per the user's ordering:** design the real WhatchatAI MCP
server implementation - this closes out the last open item from the
hardening pass.

## 2026-08-22 - OpenClaw Cell Runtime: disable elevated tools + browser control by default (attack-surface reduction)

**Branch:** `openclaw-cell-runtime`.

**Context:** the prior entry's in-cell audit reconfirmed `tools.elevated`
and browser control are both enabled by default in a fresh, unconfigured
cell. Real config paths for both were found and live-verified by the
user directly - `tools.elevated.enabled` and `browser.enabled`, both real
boolean keys in `openclaw config schema` - and manually confirmed via a
live audit re-run that setting both to `false` shrinks the
`summary.attack_surface` finding from `tools.elevated: enabled /
browser control: enabled` to `tools.elevated: disabled / browser
control: disabled`. Both keys' own schema descriptions directly match
this deployment's use case: `tools.elevated.enabled` - "Keep disabled in
public/shared channels and enable only for trusted owner-operated
contexts"; `browser.enabled` - "Disable when browser automation is not
needed to reduce surface area and startup work." Nothing in the current
architecture (CRM tool invocation via MCP only) needs either.

**Fix (`dockerCellRuntime.ts`, `buildRunArgs`):** the container's command
is now `sh -lc 'openclaw config set tools.elevated.enabled false &&
openclaw config set browser.enabled false && exec node dist/index.js
gateway ...'` - reusing the exact real `openclaw config set` CLI already
proven (by the user, live) to write these settings correctly, rather than
hand-constructing a config file whose on-disk schema/merge behavior with
`--allow-unconfigured` was never separately verified. `exec` hands off to
the actual gateway process as the effective PID 1 replacement rather than
leaving the shell as an extra parent process. The config write lands on
the bind-mounted (not read-only) state directory, so it persists across
restarts - idempotent and harmless to re-run on every `docker start`.

**Tests:** the existing hardening-profile test now asserts the command
tail is exactly this `sh -lc` wrapper containing both `config set` calls
before the `exec node dist/index.js gateway` invocation. 613/613 tests
passing, typecheck clean - against the mocked test double.

**Status: `IMPLEMENTED BUT NOT FULLY VERIFIED`** - the *values* being set
are proven correct (the user verified them live, manually, against a real
cell), but this specific *mechanism* (the shell-wrapped boot command
itself) has not yet been re-run against a real container. Needs one more
real-hardware pass: create a fresh cell with this commit, confirm it
still boots healthy, then run `docker exec <cid> openclaw security audit
--deep --json` with **no manual `config set` step** and confirm the
attack-surface summary already shows both disabled by default.

**Still open, per the user's ordering:** once that re-verification lands,
design the real WhatchatAI MCP server implementation (the disposable test
proved OpenClaw's client behavior, not our own server yet).

## 2026-08-22 - OpenClaw Cell Runtime: real in-cell security audit + state-directory permission fix

**Branch:** `openclaw-cell-runtime`.

**Context:** ran `openclaw security audit --deep --json` from inside a
real, provisioned, hardened cell for the first time (previous audit runs
were against the bare host, which was already caught giving a misleading
result for an unrelated reason - see the prior entry).

**A real operational discovery, not a code bug:** the first `--deep` run
hung for ~3.8 minutes (`durationMs=227986` in the Gateway's own logs).
Root cause,
confirmed directly from the Gateway's log output: `--deep` fires a real
*embedded agent run* as part of its self-check, and that attempted an
outbound HTTPS request to `https://api.openai.com/v1/responses` (the
unconfigured `openai/gpt-5.5` default, no credential present). Because
`--internal` blocks all egress, that request didn't fail fast - it hung
until a genuine TCP-level connect timeout. Egress blocking worked
correctly; the operational lesson is that `openclaw security audit
--deep` needs a `timeout` wrapper when run against a hardened cell, or it
can hang for minutes. A second `--deep` run (wrapped in `timeout 30`)
took a different internal path and returned quickly with a distinct
finding (`gateway.probe_failed: "missing scope: operator.read"`) -
`--deep`'s exact behavior isn't fully understood to be deterministic
across runs; recorded honestly rather than papering over the
inconsistency with an invented explanation.

**Confirmed, real findings from the in-cell audit:**
- `tools.elevated: enabled`, `browser control: enabled` - as suspected
  from the earlier bare-host/boot-log evidence, now independently
  reconfirmed from inside a real hardened cell. Not yet remediated -
  needs the real config path (next research step), not a guess.
- Gateway auth: clean, no longer flagged (unlike the bare-host run,
  which was auditing an unrelated unconfigured local install with no
  gateway even running).
- **New: `fs.state_dir.perms_world_writable` (CRITICAL)** -
  `/home/node/.openclaw mode=777`. Likely Docker Desktop/WSL2's NTFS
  bind-mount translation, though not confirmed whether that's specific
  to that dev environment or also occurs on a native Linux host -
  addressed either way (see fix below), not assumed to be environment-
  specific without evidence.

**Fix (`dockerCellRuntime.ts`):** `create()` now calls a new
`ensureStateDir()` that explicitly `mkdir`s and `chmod(0o700)`s the host
state directory itself, before Docker's bind mount can rely on whatever
the daemon's own auto-creation default produces. Correctness no longer
depends on host OS/Docker-daemon defaults.

**Tests:** the existing `create()` hardening-profile test now asserts the
real created directory's mode is exactly `0o700` (real filesystem, temp
root, not mocked - `node:fs/promises` was never mocked in this file, only
`node:child_process`). 613/613 tests passing, typecheck clean. Pure
Node `fs` logic, same as `purgeData` - no real-hardware re-test needed;
`IMPLEMENTED AND VERIFIED`.

**Still open, per the user's ordering:** research the real config path
for disabling `tools.elevated`/browser control (do not guess a key name);
re-run the in-cell audit to confirm the attack-surface summary shrinks;
only then design the real WhatchatAI MCP server implementation.

## 2026-08-22 - OpenClaw Cell Runtime: MCP wire-protocol verified against a real, disposable server

**Branch:** `openclaw-cell-runtime`. Pure research - no application code changed.

**Context:** Phase 3's own research (below) found OpenClaw's tool-invocation
mechanism is genuinely MCP-based (`openclaw mcp` config surface). Before
building any adapter/translation layer against that assumption, the user
required real proof of the actual wire protocol and, specifically,
whether the `--include` tool allow-list is really enforced or just
advisory - against a fully disposable target (a throwaway Node HTTP
server, two harmless fake tools, a disposable low-limit API key, host-
only, never a hardened cell).

**Real evidence captured:**
- Registration (`openclaw mcp add ... --no-probe`) writes to the real
  local `openclaw.json` - confirmed via the tool's own printed path.
- `openclaw mcp probe`: real `initialize` -> `notifications/initialized`
  -> `tools/list` JSON-RPC 2.0 sequence, captured verbatim by the
  disposable server's own request log (not inferred from OpenClaw's
  side). Real client info: `{"name":"openclaw-bundle-mcp","version":
  "0.0.0"}`. Real negotiated protocol version: `"2025-11-25"` -
  corrected from an initial assumption of `"2025-03-26"` in the test
  server's own default, which the real client's explicit request
  overrode; recorded here as the real value, not the guess.
- `openclaw mcp tools <name> --include echo_test` persists a real
  `toolFilter: {"include": ["echo_test"]}` structure in `openclaw.json`.
- `openclaw config set --help` confirmed a real `--ref-source env
  --ref-id <ENV_VAR>` mode for `config set` - a credential can be
  configured as a pointer to an environment variable rather than a
  literal value written into a persisted config file, which is what the
  disposable test used (nothing to scrub from a file afterward, only an
  env var to unset).
- **Allowed tool (`echo_test`), real agent turn:** the model decided to
  call it; the disposable server's log shows a real `tools/call` request
  with the exact arguments the prompt specified, and returned cleanly.
- **Excluded tool (`blocked_test`), real agent turn:** `blocked_test` was
  **not present in the tool schema sent to the model at all** - not
  merely declined, structurally absent from what the model could see or
  attempt to call. The disposable server's own independent log shows
  **zero** `tools/call` requests for it. This is the strongest form of
  the guarantee the user asked to prove: the allow-list operates before
  the LLM ever has the tool in context, not as an after-the-fact
  behavioral nudge a prompt-injection attempt could try to talk around.

**Cleanup, confirmed:** the disposable API key's env var unset, the model
config unset, the MCP server registration removed, the test server
process stopped and its files deleted. No credential, real or disposable,
touched any hardened cell, WhatchatAI code, or persisted config beyond
the disposable local `openclaw.json` on the test machine, which was
itself reverted.

**What this proves, concretely, for the real integration design still to
come:** WhatchatAI's own Tool Gateway/adapter can plausibly be registered
as an `openclaw mcp` HTTP/streamable-http server, with an explicit
`--include` list matching exactly the tools we intend to expose (today,
only `update_lead`), and that inclusion boundary is real, not
theoretical. **What this does NOT yet prove:** the actual JSON-RPC
request/response shape our adapter would need to implement to *be* a
correct MCP server (this test only exercised OpenClaw acting as an MCP
*client* against a hand-written, not-necessarily-fully-spec-compliant
stand-in) - a real MCP server implementation (likely via the official
MCP SDK rather than another hand-rolled server) is still a real design
task for a later step, not yet started.

**Status: `IMPLEMENTED AND VERIFIED`** for the transport/enforcement
questions this test was scoped to answer. No code in this repository was
touched - this was infrastructure-external research using a throwaway
server and a disposable credential, matching the user's explicit scope
boundary.

**Next, per the user's own ordering:** run `openclaw security audit
--deep --json` from *inside* a real, provisioned, hardened WhatchatAI
cell (not the bare host, which was already caught giving a misleading
result for this exact reason in the prior research pass) - only after
that should real MCP-adapter design work begin.

## 2026-08-22 - OpenClaw Cell Runtime: encrypted Gateway-token storage

**Branch:** `openclaw-cell-runtime`, on top of `2e3f1a8`.

Replaces the prior gap (the Gateway token was generated, passed to a
cell's container env, and returned once, but never persisted anywhere -
"an explicitly tracked gap, not an oversight") with real encrypted
storage, using the same AES-256-GCM envelope mechanism every other
tenant secret in this codebase already uses (`business_email_settings`,
`business_goose_settings`) - not a new encryption scheme invented for
this one field.

**Migration `066_openclaw_gateway_token_encrypted.sql`:** adds
`gateway_token_encrypted TEXT` to `openclaw_cells`. Deliberately
different from `callback_token_hash` (migration 064): that credential is
only ever verified by equality, so a one-way hash was correct; the
Gateway token is the opposite direction - WhatchatAI would need it back
as plaintext to call OUT to a cell's own Gateway API - so it needs
reversible encryption, not a hash.

**`openclawCellRepository.ts`:** `setGatewayToken`/`getGatewayToken`/
`hasGatewayToken`, using the identical `encryptSecret`/`decryptSecret`
helper shape `integrationSettingsRepository.ts` already established.
Deliberately kept out of `OpenClawCellRecord`/`toRecord()` entirely
(mirroring `callback_token_hash`'s own exclusion) - an ordinary
`findByBusinessId`/`listAll` read can never carry the token, encrypted or
not; only the three dedicated methods touch that column.

**`openclawCellService.ts`:** `provisionCellForBusiness` now calls
`repo.setGatewayToken` right after creation. `CellProvisionResult
.gatewayToken` still returns the plaintext once, at the moment of
provisioning - the same "shown once" pattern the callback token already
used - but every read after that point requires the narrow, explicit
`getGatewayToken` accessor rather than being present on any general
record.

**Verification:** 613/613 tests passing (20 new - repository round-trip,
raw-column-never-contains-plaintext, `hasGatewayToken` without
decrypting, ordinary-record-never-carries-it, plus service-level
provisioning coverage), typecheck clean, migration 066 applies cleanly
against real Postgres. (One unrelated, pre-existing flaky test in
`agentGuard.test.ts` - a regex occasionally matching a random UUID's
digit run - failed once and passed on immediate retry; not touched by
this change, not fixed here.) **`IMPLEMENTED AND VERIFIED`** - same as
`purgeData`, this is pure application/DB logic with no Docker dependency,
so no real-hardware re-test is needed.

**Still open, per the user's ordering:** the OpenClaw internal-agent/
tool-invocation research (next); the feature flag, only after that. No
provider credential enters a cell - this phase only secured the
credential WhatchatAI itself already generates and controls.

## 2026-08-22 - OpenClaw Cell Runtime: purgeData containment implemented

**Branch:** `openclaw-cell-runtime`, on top of `65a3daf`.

Replaces `DockerCellRuntime.remove()`'s `purgeData` no-op (which logged a
warning and left state on disk) with real, containment-checked deletion.

**`resolveContainedCellStateDir(cellId)`** (new, exported for direct
testing) - every check runs before any filesystem mutation is even
considered:
- Rejects empty strings, path separators (`/`, `\`), null bytes, and
  absolute paths outright.
- Validates `cellId` against a strict allow-list regex (lowercase
  alphanumerics and hyphens only) - deliberately independent of
  `validateCellId()` in `openclawCellService.ts` rather than trusting an
  upstream check to stay correct forever, the same mirror-not-share
  pattern already used for the callback-token service vs. the session-
  token service in this codebase.
- Resolves `stateRootDir()` and the candidate target with `path.resolve`,
  then confirms via `path.relative` that the target is exactly one direct
  child of the root - never the root itself, never nested, never outside
  it.

**`purgeCellStateDir(cellId)`** (new, exported for direct testing):
- `lstat`, never `stat` - a symlink at the target is rejected outright,
  regardless of where it points (inside or outside the state root),
  rather than followed.
- Rejects anything at the target that isn't a real directory.
- A second `realpath` + containment re-check on the (now confirmed
  non-symlink) directory itself, catching the case where the state root
  or an ancestor path component was itself replaced with a symlink.
- Only then: `fs.rm(target, { recursive: true })` - a real Node fs call,
  not a shelled-out `rm -rf`.
- A target that doesn't exist is treated as an idempotent success, not an
  error - matching this runtime's existing "already absent" semantics for
  `stop`/`start`/`remove` on a missing container.

**`remove()`'s two steps stay explicitly separate**, per the requirement
that a purge failure never gets reported as a silent successful cleanup:
container/network removal remains idempotent best-effort (unchanged);
`purgeData`, when requested, now throws a real `Error` naming the cell if
containment checks or the deletion itself fail - the message explicitly
states that container/network removal already succeeded but state
deletion did not, rather than conflating the two into one ambiguous
outcome.

**Tests (`test/dockerCellRuntime.test.ts`), real filesystem, not
mocked** - `node:child_process` stays mocked (container/network removal
isn't under test here), `node:fs/promises` is not, because this is
exactly the class of bug a mocked fs would hide:
- Valid cell directory is actually deleted from disk.
- Idempotent no-op against a directory that never existed.
- 11 parametrized rejection cases (`../` traversal, deeper traversal,
  nested paths, bare `.`/`..`, empty string, malformed identifiers -
  hyphen-prefixed, uppercase, null byte, percent-encoded) - each asserts
  a real canary file *outside* the state root survives untouched, not
  just that the call threw.
- Absolute path rejected.
- Resolved path is always exactly one level below the root, never the
  root itself.
- A symlink at the target pointing *inside* the state root is rejected -
  neither the symlink nor its real target is touched.
- A symlink at the target pointing *outside* the state root is rejected -
  the real external directory and its contents survive untouched.
- A file (not a directory) at the target is rejected rather than deleted.
- Through `DockerCellRuntime.remove()`: container/network removal
  succeeds independent of `purgeData`; `purgeData: true` actually deletes
  a real directory on disk end to end; a purge failure surfaces as a
  thrown error while confirming container/network removal still ran
  first.

**Verification:** 609/609 tests passing (589 + 20 new), typecheck clean.
Unlike the Docker-orchestration code elsewhere in this file, this is pure
Node `fs` logic with no Docker/GHCR dependency - the tests above run
against a real filesystem in this sandbox, not a mock, so this is
**`IMPLEMENTED AND VERIFIED`**, no real-hardware re-test required the way
the Docker-specific changes needed one.

**Still open, per the user's ordering:** encrypted Gateway-token storage
(next); the OpenClaw internal-agent/tool-invocation research; the feature
flag, only after both. No provider credential enters a cell before token
storage is done.

## 2026-08-22 - OpenClaw Cell Runtime: real 5-step lifecycle re-verification, docker-exec health-check fix VERIFIED

**Branch:** `openclaw-cell-runtime`, on top of `645a0ab`.

Real re-run on the user's machine, one cell through the full lifecycle,
raw output captured at every step:
- `create()`: succeeded in 22.7s (well within the 60s deadline; no
  timeout, unlike before the fix).
- `status()`: `{"state":"running","healthy":true}`.
- `stop()`: succeeded.
- `start()`: succeeded in 16.8s, `healthy: true` - the exact restart path
  that was previously broken twice over (first the 5s-cap timing bug,
  then the `--internal`/published-port conflict), now confirmed working
  end to end.
- `status()` again: `{"state":"running","healthy":true}`.
- `remove()`: container + network cleaned up.

**Status: `VERIFIED`.** This closes out the docker-exec health-check fix
from the entry below - moves from `IMPLEMENTED BUT NOT FULLY VERIFIED` to
confirmed against a real container. Combined with the earlier real
evidence for general-egress blocking and cross-cell isolation, the full
`DockerCellRuntime` lifecycle (create/status/stop/start/remove) and its
egress-containment properties are now real-runtime `VERIFIED`, not
assumed from code review or mocked tests alone.

**Still open, per the user's explicit ordering:** `purgeData` containment
(next); encrypted Gateway-token storage; the OpenClaw internal-agent/
tool-invocation research (including whether `host.docker.internal`
reachability is ever actually needed, and the `openai/gpt-5.5` default
observed in boot logs); the feature flag, only after all of the above. No
provider credential goes into a cell before the credential-storage item
is done.

## 2026-08-22 - OpenClaw Cell Runtime: health checking moved off the published port (CONFIGURATION MISMATCH, confirmed and fixed)

**Branch:** `openclaw-cell-runtime`, continuing on top of `bcec22a`.

**Context:** real re-verification of the egress-containment change (below)
found two of three properties confirmed clean with raw evidence -
general-internet egress genuinely blocked (`curl` exit 6/7 against
`example.com` and `1.1.1.1`), cross-cell isolation genuinely enforced
(`curl` exit 6 from one cell's container to another's IP) - but
`create()` itself now reliably fails: `"Cell verify-cell-3 did not become
healthy within 60000ms of starting"`, reproduced cleanly.

**Full diagnostic evidence, not just the failure:**
- `docker logs --timestamps` on the still-running container: a completely
  clean boot, `[gateway] ready` at +3.15s, no errors.
- `docker exec <cid> curl http://127.0.0.1:18789/healthz` (inside the
  container's own namespace): real `200 OK`, real body
  `{"ok":true,"status":"live"}`.
- `curl http://127.0.0.1:<published-port>/healthz` (from the host): real
  `curl: (7) Failed to connect... Could not connect to server`.

**Root cause, confirmed rather than inferred:** Docker's `--internal`
network flag - the same flag that correctly blocks general egress -
excludes the network from the NAT/forwarding plumbing `--publish` needs
to work at all. The Gateway process itself is completely healthy; only
its host-side reachability via the published port is broken. This is
real, documented Docker behavior once looked into, not a bug in OpenClaw
or in the hardening profile.

**User's explicit design decision** (deliberately separating two
concerns rather than conflating them): don't remove `--publish` yet - it
was built around a not-yet-answered question (does the Tool Gateway/
adapter ever need a host-side transport to a cell's own Gateway?) that
removing it prematurely would foreclose. Instead: move health checking
onto a mechanism that doesn't depend on the published port at all, and
keep `--publish`/`gatewayEndpoint`/`port` as *transport metadata* for a
possible future authenticated Gateway path, explicitly not currently
functional and explicitly not the health-check mechanism.

**Fix (`dockerCellRuntime.ts`):** `waitForHealthy()` (used by `create()`,
`status()`, `start()`) now runs `docker exec <cid> curl ... http://127.0.0.1:18789/healthz`
inside the container's own network namespace, replacing the host-side
`fetch` against the published port. This never crosses the
`--internal`/`--publish` boundary at all, so it's unaffected by the
finding above. `readPublishedPort()` (now unused) was removed rather than
left as dead code. `--publish`, `findFreePort()`, and the
`gatewayEndpoint`/`port` fields on `CellCreateResult` are unchanged -
kept deliberately, per the decision above, not because they currently
function for anything.

**Test changes (`test/dockerCellRuntime.test.ts`):** every health-check
assertion now mocks the `docker exec ... curl` call instead of `fetch`;
the now-unused `fetchMock`/`vi.stubGlobal('fetch', ...)` scaffolding was
removed rather than left dangling.

**Verification:** 589/589 tests passing, typecheck clean - against the
mocked test double. **Not yet re-run against the real container** - this
sandbox has no GHCR access. That re-run (confirm `create()`/`status()`/
`start()` all succeed via the new mechanism, and that everything
previously verified - hardening, resource limits, auth, egress
containment, cross-cell isolation - is unaffected) is the immediate next
step.

**Status: `IMPLEMENTED BUT NOT FULLY VERIFIED`** for the health-check
change specifically. Egress containment and cross-cell isolation
themselves are `VERIFIED` (real evidence, unaffected by this fix -
`--internal` still applies to both networks). Everything else previously
verified (auth, hardening, resource limits, restart-timing budget) is
unaffected and remains `VERIFIED`.

## 2026-08-22 - OpenClaw Cell Runtime: egress containment - per-cell networks are now `--internal`

**Branch:** `openclaw-cell-runtime`, continuing on top of `ac36817`.

**Context:** while discussing OpenClaw's own internal agent capability
(the `openai/gpt-5.5` default observed in a real boot log - see the entry
below), the user asked whether using Gemini instead of OpenAI changes
anything. Answering that honestly required checking `buildRunArgs()`
against the *original* hardening requirement list from when this
architecture was first designed - which included "minimal outbound
access." It was never actually implemented: the per-cell network was a
plain `docker network create --driver bridge`, which has full outbound
internet access via normal Docker NAT, identical to any default bridge
network. The provider question (Gemini vs. OpenAI) was a distraction from
the real gap - nothing restricted what a cell could reach at all, for any
provider, if a credential were ever placed inside one. The user's explicit
decision: fix this before touching credentials or researching the
internal agent path further, and do it without weakening any existing
hardening.

**Fix (`dockerCellRuntime.ts`):**
- `ensureNetwork()`: per-cell network creation now passes `--internal` -
  Docker's own primitive for "the daemon never wires up an outbound
  route for this network." A container attached only to an internal
  network cannot reach the general internet at all; this is enforced by
  Docker itself, not custom iptables rules bolted on separately.
- `buildRunArgs()`: adds `--add-host host.docker.internal:host-gateway` -
  the one deliberate exception, letting the cell still reach the Docker
  host machine (where WhatchatAI's own Tool Gateway/adapter listens) via
  a name Docker resolves locally, not a real DNS lookup. No external DNS
  is granted or needed for this - satisfies "DNS only if required" by
  requiring none.
- Existing loopback-only host-side port publish (`127.0.0.1:<port>:18789`
  for the cell's own inbound Gateway) is unaffected - `--internal` only
  blocks the container's own *outbound* route, not inbound
  Docker-managed port forwarding from the host.

**An honest, explicitly-tracked remaining gap:** `host.docker.internal`
reachability is host-wide, not narrowed to the Tool Gateway's specific
port. A cell today can reach anything else the host happens to have
listening, not just the adapter endpoint. Closing that further needs
either a host-side firewall rule scoped to the docker bridge subnet, or a
dedicated egress-proxy sidecar per cell - both bigger, separate design
decisions not built in this pass, flagged rather than silently treated as
"solved."

**What this does NOT yet prove:** two real-world behaviors this design
depends on have not been verified against a real daemon:
1. That `host.docker.internal` / `host-gateway` actually resolves and
   stays reachable from *inside* an `--internal` network (expected,
   per Docker's documented behavior that host-gateway reachability is
   local-bridge traffic rather than "outside world" traffic that
   `--internal` blocks - but expected is not verified).
2. That two cells' separate dedicated networks genuinely cannot reach
   each other (expected, per Docker's standard bridge-network isolation
   - same caveat).
This sandbox cannot verify either (no GHCR/Docker Hub blob access here,
confirmed again this session - `dockerd` itself won't even start under
this sandbox's process restrictions). Both need a real 2-cell test on the
user's machine before being called `VERIFIED`.

**Test changes (`test/dockerCellRuntime.test.ts`):** updated the network-
creation assertion to require `--internal`, and added an assertion that
`buildRunArgs()` includes `--add-host host.docker.internal:host-gateway`.
These prove the *construction* of the Docker invocation is correct: they
cannot prove Docker's daemon actually enforces the isolation this pass
assumes.

**Verification:** 589/589 tests passing, typecheck clean - both against
the mocked test double only, same caveat as above.

**Status: `IMPLEMENTED BUT NOT FULLY VERIFIED`** - specifically the two
items listed above. Everything previously verified (auth enforcement,
resource limits, restart lifecycle, the rest of the hardening profile) is
unaffected by this change and remains `VERIFIED`.

**Still explicitly out of scope for this pass, per the user's own
ordering:** no provider credential (OpenAI, Gemini, or otherwise) is to
be added to a cell until this egress containment is itself verified;
`purgeData` containment; encrypted Gateway-token storage; the OpenClaw
internal-agent/tool-invocation research; the feature flag. All unchanged
from the prior entry's ordering.

## 2026-08-22 - OpenClaw Cell Runtime: real DockerCellRuntime verification against a live container, restart-timing fix

**Branch:** `openclaw-cell-runtime`, continuing directly on top of `9613421`
(the Fleet-to-Docker pivot below).

**Context:** the user ran the actual 12-step real-Docker verification
against a live, disposable cell on their own machine - the step this
engagement's prior entry explicitly left open ("no real `docker run` of
this exact command combination has ever been attempted"). Two passes were
run: an initial pass, then a targeted re-test (raw, timestamped captures
only, no narrative summaries) of the two properties the first pass left
unproven.

**Verified with real evidence, against a live container (`containerId
7601ea8a...`, image digest `sha256:8789721d...2ed72c8ac`):**
- `create()`: succeeded, container reached healthy within the 60s
  deadline.
- Hardening profile: `docker inspect` confirmed every field matches the
  intended profile exactly - `User: 1000:1000`, `CapDrop: [ALL]`,
  `SecurityOpt: [no-new-privileges]`, `ReadonlyRootfs: true`, `Tmpfs:
  {"/tmp":""}`, dedicated per-cell bridge network, loopback-only
  `PortBindings` (`127.0.0.1:<port>:18789`).
- Resource limits: `Memory 2147483648` (2GiB), `NanoCpus 2000000000`
  (2.0), `PidsLimit 512`, `Init true` - all real `docker inspect` values,
  not assumed.
- Token authentication: real HTTP layer is only `/healthz` (liveness) and
  a static Control UI shell at `/`; all actual gateway operations run
  over WebSocket via `openclaw gateway call ... --token`. A wrong token
  was rejected at the transport level with a real WS close 1008
  (`GatewayTransportError: gateway closed (1008): unauthorized: gateway
  token mismatch`), the correct token returned a real health payload.
  Proves the property the threat model actually needs (a foreign/stolen
  token is rejected by the server, not just by client-side validation).
- `stop()`/`status()`: correctly report `stopped, healthy: false` after a
  real `docker stop`.

**A real bug found and now fixed - `start()` timing:** the first pass
found `start()` reliably throwing `"started but did not report healthy"`
even though the container logs showed it reaching `ready`. Reproduced 3/3
times with raw, timestamped evidence (not summarized): real restart-to-
`ready` time was consistently 5.1-5.8s (elapsed_ms 6224 / 6379 / 6001
across three independent stop/start cycles, converging in a tight band,
never once completing under the old cap - a deterministic mismatch, not
an intermittent race). The cause: `status()` capped its post-restart
health poll at a hardcoded `Math.min(5_000, this.healthCheckDeadlineMs)`
(effectively 5s in production), and `start()` delegated to that same
capped call instead of getting the same full boot budget `create()` gets.

**Fix (`dockerCellRuntime.ts`), narrowly scoped to exactly this:**
`start()` no longer delegates through `status()`. It now polls the
published port directly via the same `waitForHealthy()` helper `create()`
already uses, with the same `healthCheckDeadlineMs`/
`healthCheckPollIntervalMs` this instance is already configured with - no
new magic constant introduced. `status()`'s own short 5s-style cap is
unchanged for its own routine "is this running cell still answering right
now" callers (checkHealth polling, the security watcher) - only the
restart path's budget changed. Nothing about hardening, resource limits,
auth, network isolation, `create()`, `stop()`, `quarantine()`,
`aiOrchestrator.ts`, Baileys, the Gemini path, or WhatsApp transport was
touched.

**Test changes (`test/dockerCellRuntime.test.ts`):** updated the existing
`start()` tests for the new two-call sequence (`docker start` + port
lookup, no longer a separate `.State.Running` inspect), and added a
regression test proving `start()` now honors the full configured deadline
rather than a short cap - a slow (but within-deadline) boot now succeeds
instead of throwing.

**Verification:** 589/589 tests passing (588 + the new regression test),
typecheck clean, `npm run db:migrate` unaffected (no schema change this
entry) - run in the sandbox against the mocked `execFile`/`fetch` test
double first, then **re-run for real** against a live container on the
user's machine (this sandbox has no GHCR blob access): 3 consecutive
stop/start cycles on the same cell, each printing raw `t0_iso`/`t1_iso`/
`elapsed_ms` from the script itself rather than a narrative summary -
`elapsed_ms 19047 / 24814 / 23359`, all three returning `RESULT: start()
returned successfully (healthy).` Notably slower than the 5.1-5.8s
boot-to-`ready` time the earlier container-log capture showed (this
run's `create()` was also slower than its own earlier run - 28.8s vs
21.7s - consistent with host-load variance, e.g. WSL2/Docker Desktop
contention, rather than anything code-related) - which is itself
supporting evidence for the fix's shape: a hardcoded short cap would have
failed all three cycles just as it failed before, while giving `start()`
the same full budget `create()` gets absorbed that variance and still
succeeded, every time, well within the deadline.

**Honest status after this pass:**
- Auth enforcement: **VERIFIED** (real wrong-token rejection at the
  WebSocket transport layer, real correct-token success).
- Container hardening: **VERIFIED** (every flag confirmed via real
  `docker inspect`).
- Resource limits: **VERIFIED** (real `docker inspect` values).
- Restart lifecycle (`stop()`/`start()`): **VERIFIED** - 3/3 real
  stop/start cycles against a live container, each returning healthy
  within the deadline (see raw evidence above).
- OpenClaw's internal agent/model behavior (its own independent
  `openai/gpt-5.5`-defaulting agent capability, observed in boot logs but
  never exercised): **NOT YET INVESTIGATED** - genuinely out of scope for
  this pass, tracked as a follow-up research item, not guessed at.
- OpenClaw-to-WhatchatAI production traffic: **NOT ACTIVATED** - nothing
  in this pass touched the feature flag, tenant allowlist, or wired a
  real cell to the Tool Gateway/adapter for live traffic.

**What's still open, in order:** (1) implement `purgeData` state-
directory deletion with real containment checks (unchanged gap, not
addressed this pass); (2) encrypted Gateway-token storage (unchanged
gap); (3) research OpenClaw's real external-tool-webhook mechanism -
genuinely unresearched, do not guess at a config format; (4) feature flag
with tenant allowlist, only after the above.

## 2026-08-22 - OpenClaw Cell Runtime: real-environment verification found Fleet doesn't exist in stable OpenClaw - pivoted to direct Docker orchestration

**Branch:** `openclaw-cell-runtime` (split from `phase-2-ai-repair` at commit
`02add1a` specifically for this pivot, per the user's own instruction not
to touch the working, deployed branch while rearchitecting an unproven
piece - merge back once this is itself verified)

**Context:** the user personally ran real verification on their own
Windows/WSL2 Docker machine, following this engagement's own "verify
before trusting" discipline rather than accepting the prior four slices'
"IMPLEMENTED BUT NOT FULLY VERIFIED" label at face value. That
verification surfaced a critical, real finding that changes the
architecture of everything built in the four prior OpenClaw entries.

**The finding, in the user's own real terminal output:**

```
$ openclaw fleet --help
[openclaw] Could not start the CLI.
[openclaw] Reason: Unknown command: openclaw fleet. No built-in command or plugin CLI metadata owns "fleet".
```

Run against a genuinely installed `openclaw@2026.7.1-2` (`npm install -g
openclaw`, confirmed via `openclaw --version` -> `OpenClaw 2026.7.1-2
(0790d9f)`) - the exact version this platform had pinned. The CLI's real
top-level command list confirms it has no multi-tenant orchestrator at
all: `agent, agents, approvals, audit, channels, config, configure,
cron, daemon, dashboard, doctor, gateway, health, mcp, nodes, sandbox,
security, status`. Two commands sound adjacent but are not equivalents,
also confirmed via real `--help` output on the user's machine:
`sandbox` manages OpenClaw's own *internal* per-agent tool-execution
containers (not a per-tenant multi-instance orchestrator); `nodes`
manages *paired remote devices* (phones/laptops - camera, screen,
location, notifications), a companion-app pairing feature, unrelated to
SaaS multi-tenancy.

**Root cause, traced back:** `docs/cli/fleet.md` - the source every
prior OpenClaw slice in this engagement was built against - was read
from a clone of the `openclaw/openclaw` repository's `main` branch HEAD,
which was already ahead on the in-development `2026.8.1` line (the same
line that, per the first OpenClaw slice's own changelog entry, only ever
had beta tags published: `2026.8.1-beta.1`, `-beta.2`). Fleet is real
documentation for real, in-progress work - it was verified against the
wrong version's source. It should have been checked against the actual
tagged release being pinned, not the tip of `main`.

**Independently reconfirmed, not just asserted:**
- `npm view openclaw` against the real npm registry: `latest:
  2026.7.1-2`, `beta: 2026.8.1-beta.2` - same story as GHCR.
- `openclaw doctor` on the real install: no mention of Fleet anywhere in
  its plugin/skill inventory (32 plugins loaded, 0 disabled unrelated to
  Fleet).
- `openclaw gateway --help`: confirms the stable release's real
  single-instance model - `run/start/stop/restart/status/install`
  against exactly one Gateway service per host, config-driven
  (`--port`/`--bind`/`--token`/`--auth`), no multi-instance concept at
  all. This is the honest, narrower truth behind what
  `docs/gateway/multi-tenant-hosting.md` already said in this
  engagement's very first OpenClaw research pass ("one trusted operator
  boundary per Gateway") - Fleet was supposed to be the exception to
  that; in the stable release, it isn't there yet.

**Decision (the user's, made explicit rather than assumed):** proceed
with Option 2 of three real choices - build the per-tenant orchestration
directly on Docker + the stable `openclaw gateway run` command, behind a
clean runtime abstraction, rather than either waiting indefinitely for
Fleet to ship or quietly pretending the old Fleet-CLI-wrapper code still
described reality. Explicitly rejected: silently rewriting
`OpenClawFleetService`'s internals while keeping its old name - the user
called this out directly as something that "would make the code
misleading."

**What was built:**

- Migration `065_openclaw_cell_rename.sql`: `openclaw_fleet_cells` ->
  `openclaw_cells`, `fleet_cell_id` -> `cell_id` (both tables). No
  production data existed under the old names - no real cell was ever
  created, since Fleet was never actually callable - so this is a clean
  rename, not a live data migration.
- `openclawCellRuntime.ts`: the new abstraction boundary -
  `OpenClawCellRuntime` (`create/status/stop/start/upgrade/remove`).
  `DockerCellRuntime` is the real implementation for right now.
  `FleetCellRuntime` is deliberately NOT built yet - implementing
  against a CLI command that doesn't exist would be exactly the
  speculative-code pattern this codebase's own governing principle
  warns against - the interface exists so a future stable Fleet release
  can implement it without any other code changing.
- `dockerCellRuntime.ts`: real Docker orchestration - per-cell bridge
  network, the full hardening profile independently sourced from real
  OpenClaw documentation (`--cap-drop=ALL`, `--security-opt
  no-new-privileges`, `--init`, `--pids-limit 512`, `--memory 2g`,
  `--cpus 2`, read-only rootfs + `/tmp` tmpfs, loopback-only host port
  publish), state-directory bind mount, and a real `/healthz` polling
  health gate before `create()`/`start()` return successfully. The
  container's own command line (`node dist/index.js gateway --bind lan
  --port 18789`) is likewise taken directly from the same real
  `fleet.md` source; `--auth token`/`--allow-unconfigured` come from the
  real, verified `openclaw gateway --help` output gathered this session
  - but the *combination* has never been run against a real container.
- `openclawCellService.ts` (renamed from `openclawFleetService.ts`):
  same DB-facing responsibilities as before (idempotent provisioning,
  digest-pin enforcement on upgrade, quarantine, callback-token
  issuance), now runtime-agnostic - delegates the actual container
  lifecycle to whichever `OpenClawCellRuntime` it's given, defaulting to
  `DockerCellRuntime`. The Gateway token is now generated by this
  service itself (previously Fleet generated and returned it) - still
  returned exactly once and NOT YET given real encrypted storage (an
  explicitly tracked gap, not silently swept aside - nothing built so
  far needs to call a cell's own Gateway API to retrieve it again, only
  `docker` CLI operations, so this doesn't block anything currently
  implemented).
- `openclawCellRepository.ts` (renamed), `openclawToolExecutionRepository.ts`,
  `openclawToolGateway.ts`, `openclawAdapterService.ts`,
  `openclawSecurityWatcherService.ts`, `incomingMessagesWorker.ts`: all
  downstream references to the old Fleet naming updated.

**A real, explicitly-flagged gap left in `DockerCellRuntime.remove()`:**
`purgeData` does not yet delete the host state directory. Doing that by
shelling out an `rm -rf` from a string-built path is exactly the kind of
operation that deserves the same containment checks Fleet's own docs
described (resolve the real path, confirm it's the exact expected
tenant leaf, never a symlink) rather than a quick, unguarded delete. It
logs an explicit warning and leaves the directory in place rather than
silently doing nothing or unsafely doing something.

**Verification:** 588/588 tests passing (9 new `DockerCellRuntime`
tests mocking `execFile`/`fetch`, `OpenClawCellService`'s own tests
rewritten to exercise a fake `OpenClawCellRuntime` instead of a mocked
CLI - a cleaner test architecture the interface split enabled).
Typecheck clean. `npm run db:migrate` applies 065 cleanly against a real
Postgres.

**Status: `IMPLEMENTED BUT NOT FULLY VERIFIED`**, same honest label as
before, for a different and more specific reason now: no real
`docker run` of this exact command combination has ever been attempted
against the real, pinned image. The user's own machine has the real
image pulled (`docker inspect` confirmed the exact digest,
`sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac`,
present locally, 1.73GB) and a working `openclaw` CLI installed - the
next real step is running `DockerCellRuntime.create()` there and
confirming the container actually reaches a healthy state, not assuming
it from the code.

**What's still open, in order:** (1) run `create()` for real on a
Docker-capable machine and fix whatever the real container doesn't like
about the assumed command/env combination; (2) implement the
`purgeData` state-directory deletion with real containment checks; (3)
encrypted Gateway-token storage; (4) wiring an actual OpenClaw cell's
own tool-calling configuration to call the adapter (still genuinely
unresearched - OpenClaw's real mechanism for pointing its own agent loop
at an external tool/webhook has not been confirmed against real docs);
(5) OpenClaw behind a feature flag, tenant-allowlisted, only after all
of the above. The existing Gemini/Baileys production path on
`phase-2-ai-repair` remains completely untouched - this entire pivot
happened on its own branch specifically so a mid-flight architecture
change never put the working system at risk.

## 2026-08-21 - OpenClaw Tool Gateway adapter: the HTTP seam a real cell would call (fourth slice)

**Branch:** `phase-2-ai-repair`

**Context:** the user drew a clear, correct distinction after the third
slice: the Tool Gateway's *authorization logic* was proven, but nothing
yet connected an actual OpenClaw cell to it - "OpenClaw Security
Boundary: COMPLETE, OpenClaw Runtime Integration: NOT YET VERIFIED." This
slice builds the missing HTTP seam (`OpenClaw Cell -> Authenticated
Gateway Adapter -> OpenClawToolGateway.invoke()`), which the runtime
integration still needs regardless of Fleet availability.

**A real environment finding, checked before deciding scope, that
matters for every future OpenClaw slice, not just this one:** this
sandbox actually has a working Docker daemon (`dockerd` starts and runs
fine - `docker info` reports a real Engine 29.3.1) - the "Docker
unavailable" framing carried since Phase 1 was imprecise. What's
actually blocked is narrower and confirmed directly: `docker pull` (both
`hello-world` from Docker Hub and the real pinned
`ghcr.io/openclaw/openclaw@sha256:...` image) resolves the registry API,
auth, and manifest correctly, then fails at the layer-download step -
Docker Hub redirects blobs to `production.cloudfront.docker.com`, GHCR
redirects to `pkg-containers.githubusercontent.com`, and both CDN domains
are outside this sandbox's egress allowlist while the registries' own
API domains stay reachable. `openclaw fleet create` shells out to
`docker pull` internally, so it would fail at the identical point - real
Fleet verification (steps the user proposed: cell start/stop, health,
cross-tenant isolation, quarantine actually stopping a cell, digest
pinning enforcement, upgrade behavior) needs an environment whose egress
allows those two CDN domains, not achievable in this one regardless of
Docker daemon presence. The daemon was stopped and no containers were
left running after this check.

**Decision, per the user's own choice when presented with this
blocker:** build what's honestly testable without a live cell now (this
slice), and leave "OpenClaw Runtime Integration: NOT YET VERIFIED" as
the accurate label until a Docker/Podman-capable environment is
available for the real Fleet + real cell work.

**What was built:**

- Migration `064_openclaw_callback_token.sql`: `callback_token_hash` on
  `openclaw_fleet_cells` - the credential a Fleet cell presents (as a
  Bearer token) to call *into* WhatchatAI's own adapter endpoint, the
  opposite direction from Fleet's own Gateway token (which WhatchatAI
  would use to call *out* to a cell, and is deliberately never stored -
  see migration 061). Only a SHA-256 hash is ever persisted, mirroring
  this codebase's existing `sessionTokenService.ts` pattern exactly -
  there is nothing to decrypt back to, so a hash-only lookup is the
  correct primitive here, not reversible envelope encryption.
- `openclawCallbackTokenService.ts` - a deliberate mirror (not a shared
  import) of `sessionTokenService.ts`'s generate/hash shape, kept
  separate so the two credentials stay independently reviewable.
- `OpenClawFleetService.provisionCellForBusiness` now mints a real
  callback token before calling `fleet create`, passes it to the cell via
  `--env OPENCLAW_CALLBACK_TOKEN=<token>` (Fleet's own documented `--env`
  mechanism), stores only its hash, and returns the raw value exactly
  once in the result - the same "shown once" contract Fleet's own
  Gateway token follows.
- `openclawAdapterService.ts` (`handleOpenClawToolInvokeRequest`) - the
  actual authorization-adjacent logic: Bearer-token extraction, hash
  lookup to resolve the calling cell's real identity, request-shape
  validation, then a call-through to `OpenClawToolGateway.invoke()`.
  **The businessId/fleetCellId used for that call come only from the
  authenticated cell record the token resolves to - never from anything
  the request body claims**, so a cell cannot present its own valid token
  and then ask to act as a different tenant by writing a different value
  into the JSON body.
- `openclawAdapterRouter.ts` - a five-line Express `Router` wrapper
  (`POST /tools/invoke`), mounted at `/api/openclaw` in `server/index.ts`,
  outside the session-cookie `requireAuth` gate every `/api/workspace`
  route sits behind. All real logic lives in the plain function above,
  exported and tested directly - no HTTP test harness (no `supertest`
  dependency added) needed for a wrapper this thin, consistent with how
  every other part of this codebase is tested.

**Verification:** 13 new tests (adapter) + 1 new assertion in the
existing Fleet-service suite confirming a real random callback token is
minted, passed via `--env`, and resolvable by its hash. Notably: a
**stolen valid token from a different tenant, used against this tenant's
real lead/chat IDs in the request body, is denied by the gateway** (a
real cross-tenant business-logic DENY, not merely an HTTP 401) - proving
the "body claims are never trusted" property end-to-end through the
adapter, not just inside the gateway's own unit tests. Full suite
575/575. Typecheck clean. Server boots cleanly with the new route
mounted (manual check, no crash on import/listen).

**Status: `IMPLEMENTED AND VERIFIED`** for the adapter's own logic (same
standard as the third slice - every scenario is a real Postgres/HTTP-
shaped outcome). **Runtime integration is still `NOT YET VERIFIED`**: no
real OpenClaw cell has ever called this endpoint, and per the finding
above, this sandbox cannot produce one. That milestone now depends on an
environment with real access to Docker/GHCR blob storage - it is
otherwise ready to be exercised the moment one is available.

**What's still open:** real Fleet verification (blocked here, not
elsewhere); wiring an actual OpenClaw cell's own tool-calling
configuration to call this adapter; encrypted storage for Fleet's own
Gateway token (the *other* direction of credential, deferred since
slice one); OpenClaw behind a feature flag, tenant-allowlisted, only
after the above.

## 2026-08-21 - OpenClaw Tool Gateway + first WRITE-tier tool, update_lead (third slice)

**Branch:** `phase-2-ai-repair`

**Context:** the third piece of the finalized OpenClaw architecture -
the one the user correctly called "the real security milestone." The
governing invariant, stated explicitly and enforced here in code and
tests, not just prose: **OpenClaw can request an action, but it can
never authorize one.** Every consequential mutation an OpenClaw cell
could ever request passes through this gateway; nothing about the
gateway's decision depends on anything the cell's request itself claims
(no "I'm the owner" field, no identity carried in the tool arguments).

**Two real schema findings, checked before writing any code, that
narrowed scope below what was originally proposed:**

- `update_lead`'s allowed fields are **`status`, `stage`, `notes`
  only** - not the originally proposed list including "assigned
  agent/user" and "tags"/"follow-up date." Checked the real schema:
  `tags` and `follow_up_date` are columns on `crm_contacts`, a different
  entity than `leads`; `owner_user_id` exists as a raw column on `leads`
  but was never wired into `LeadRepository` by any prior phase (no FK to
  `users`, no read/write method touches it). Extending the tool to cover
  it would mean wiring a previously-unused column and validating a real
  assignee - genuine scope beyond "the first tool should be boring."
  Deferred to a future `update_crm_contact` tool with its own resolver.
- **`aiToolPolicy.ts` and `agentGuard.ts` are untouched, and OpenClaw's
  tool registry is a fully separate table/file**, not a shared registry
  with the live Gemini function-calling path. A registered-but-unused
  entry there would likely have been harmless in practice, but both
  files are named explicitly in the user's own diagram as the existing
  critical path being protected - genuine file-level isolation was
  chosen over a defensible-but-shared-state argument. A test asserts
  `aiToolPolicy.ts`'s registered-tool list is still exactly
  `get_current_time`, proving this rather than just claiming it.

**What was built:**

- Migration `063_openclaw_tool_gateway.sql`: `generation` column on
  `openclaw_fleet_cells` (a fencing counter, bumped only on genuine
  container replacement - initial provision and `fleet upgrade`, never
  start/stop) and `openclaw_tool_executions` (one row per tool-invocation
  *attempt*, approved or denied - the real idempotency store and the
  full audit trail in one table).
- `OpenClawToolExecutionRepository`.
- `entityOwnershipRegistry.ts`: `EntityOwnershipRegistry` +
  `LeadOwnershipResolver` - resolves the requesting WhatsApp chat to its
  real CRM contact (`whatsapp_chats.contact_id -> crm_contacts` via the
  existing `findByWhatsAppContact`), then checks that contact against the
  lead's own `crm_contact_id`. An entity type with no registered resolver
  returns `NOT_FOUND`, never an implicit pass.
- `openclawToolGateway.ts` (`OpenClawToolGateway.invoke`): the full
  pipeline - idempotency-key lookup and conflict detection (same key,
  different parameters, is a DENY, never a silent re-execution or a
  silent replay of stale results) -> tenant-real check -> Fleet cell
  match -> `SECURITY_QUARANTINED` check -> fencing-generation check ->
  rate limit (20/5min, its own counter against `openclaw_tool_executions`,
  not shared with `agentGuard`'s) -> field/value validation against the
  tool's explicit allowlist -> entity ownership -> execution via a small,
  explicit `execute()` switch (never a data-driven "call any repository
  method by name" dispatcher) -> a durable, auditable record either way.

**Verification, matching the acceptance table the user required before
registering any additional WRITE-tier tool** - all real Postgres
outcomes, not mocked:

| Scenario | Result |
|---|---|
| OpenClaw updates its own tenant's authorized lead | APPROVED, row actually changed |
| Another tenant's lead | DENIED (`not found`), other tenant's row untouched |
| A different customer's lead in the *same* tenant | DENIED (`no authorized relationship`) |
| Unregistered tool (`approve_refund`) | DENIED |
| Unknown entity id | DENIED |
| Unwritable field (`owner_user_id`) | DENIED |
| Invalid field value | DENIED |
| Same operation submitted twice | First APPROVED, second replayed (no second DB write) |
| Same idempotency key, different fields | DENIED, original fields never overwritten |
| Stale/expired fencing generation | DENIED, lead untouched |
| `SECURITY_QUARANTINED` cell | DENIED, lead untouched |
| Prompt-injection-style claimed identity in the request fields | DENIED - the extra field alone is rejected; nothing inspects it for a claim |
| `execute_sql`-shaped tool name | DENIED - same as any other unregistered tool, no SQL capability exists anywhere in this path |
| Existing Gemini/Baileys path | Unaffected - `aiToolPolicy.ts` still registers exactly one tool |

15 new tests, all passing on the first real run against Postgres. Full
suite 562/562. Typecheck clean.

**Status: `IMPLEMENTED AND VERIFIED`** for the gateway's own authorization
logic (every scenario above is a real, asserted Postgres outcome, not a
mocked unit). **Still `NOT FULLY VERIFIED` end-to-end**: nothing yet
calls this gateway from an actual running OpenClaw cell (no real Fleet
`fleet create` has ever been run anywhere in this engagement - Docker Hub
pulls remain blocked in this sandbox), so this proves the authorization
boundary is correct in isolation, not that a real cell's real tool-call
protocol reaches it correctly.

**What's still open, in order:** (1) encrypted Gateway-token storage
(deferred from slice order, not forgotten - see prior entry); (2) a real
`fleet create` run against an actual Docker/Podman daemon; (3) wiring an
actual OpenClaw cell's tool-call protocol to call `invoke()`; (4) OpenClaw
behind a feature flag for controlled testing against the existing
Gemini/Goose path, with an immediate rollback. The existing Gemini/Baileys
production path remains completely untouched by all three slices so far.

## 2026-08-21 - OpenClaw Security Watcher (second slice)

**Branch:** `phase-2-ai-repair`

**Context:** the second piece of the user's finalized OpenClaw architecture,
in the agreed order (Security Watcher -> encrypted Gateway credentials ->
Tool Gateway/`agentGuard.ts` wiring -> real Fleet verification -> feature
flag). Requirement, verbatim: monitor GitHub Security Advisories against
the exact deployed OpenClaw version, distinguish severity, quarantine
affected cells automatically where policy requires it, never silently
upgrade, and record every security decision in PostgreSQL.

**What was built:**

- Migration `062_openclaw_security_watcher.sql`: `openclaw_security_advisories`
  (one row per (GHSA ID, deployed version) actually evaluated, upserted on
  every run so a re-check updates the classification rather than
  duplicating) and `openclaw_security_watcher_runs` (one row per watcher
  run, success or failure - the real audit trail "record every security
  decision" depends on).
- `OpenClawSecurityAdvisoryRepository`.
- `openclawSecurityWatcherService.ts` (`runSecurityWatcher`): fetches
  `GET /repos/openclaw/openclaw/security-advisories` (paginated via the
  `Link` header, capped at 10 pages), evaluates every non-withdrawn
  advisory against every version `listDistinctDeployedVersions()` reports,
  and calls `OpenClawFleetService.quarantineCell` (added last commit - it
  really stops the Fleet cell, not just a DB flag) for every business on a
  version with a CRITICAL-classified advisory. Already-quarantined cells
  are skipped, never re-quarantined.

**A real design correction made before finishing this slice, not after:**
the first draft tried to positively clear an advisory as SAFE via a
semver range/exact-match check against `patched_versions`/
`vulnerable_version_range`. Two real problems ruled that out: (1) this
sandbox cannot make a live call to `api.github.com` (blocked by its own
egress policy, confirmed via `curl` returning 403 during this
engagement's research pass), so the exact response field shapes couldn't
be verified against a real payload; (2) OpenClaw's own calendar-plus-
rebuild-revision versioning (`2026.7.1`, `2026.7.1-1`, `2026.7.1-2`)
doesn't follow semver precedence for the `-N` suffix - semver reads
`2026.7.1-2` as an older *pre-release* of `2026.7.1`, when it's actually
the same-or-newer rebuild, so a lower-bound range check could wrongly
report a current version as "not in range" (falsely SAFE) - exactly the
failure direction a fail-closed control must never produce. Classification
is severity-only in this slice: CRITICAL/HIGH severity -> CRITICAL,
everything else -> WARNING, **nothing is ever auto-classified SAFE**. The
`SAFE` enum value stays valid in the schema for a later slice (an
operator-confirmed override, or a verified parser once the real API shape
and OpenClaw's version-ordering intent are both confirmed) - it's just
unreachable by this function today, which is documented in its own
comment rather than silently left ambiguous.

Also removed the `semver` dependency added mid-slice once nothing in the
final design actually used it - keeping an unused dependency around
because it was already installed would have been exactly the kind of
premature abstraction the governing principle warns against.

**Wired into the scheduler:** `openclaw-security-watcher` runs every 6
hours via `realtimeEventsQueue`'s existing `upsertJobScheduler` pattern
(`incomingMessagesWorker.ts`), registered now even though no tenant has a
Fleet cell provisioned yet, so there is no window where a deployed cell
exists without a watcher already checking it.

**Status: `IMPLEMENTED BUT NOT FULLY VERIFIED`.** 9 new tests (`fetch`
mocked - this sandbox cannot reach `api.github.com` directly, the same
constraint noted above), full suite 547/547 (one pre-existing, unrelated
flake observed and re-run clean: `agentGuard.test.ts`'s PII-regex
assertion occasionally collides with a randomly-generated UUID that
happens to contain a 7-digit run - not touched by this change, not fixed
here since it's outside this slice's scope), typecheck clean. Never
exercised against a live GitHub API response, so the exact JSON shape
this code parses is inferred from GitHub's public REST API documentation,
not confirmed against a real payload from this environment.

**What's still open, in order:** (1) encrypted Gateway-token storage,
(2) Tool Gateway/`agentGuard.ts` wiring so OpenClaw output is never
trusted with authorization - including the entity-ownership check and
per-tool-invocation idempotency key the user's own review of the first
slice called out as real gaps agentGuard.ts doesn't yet cover, (3) a real
`fleet create` run against an actual daemon, (4) OpenClaw behind a feature
flag for controlled testing against the existing Gemini/Goose path, with
an immediate rollback.

## 2026-08-21 - OpenClaw Fleet: authoritative tenant-cell mapping + lifecycle service (first slice)

**Branch:** `phase-2-ai-repair`

**Context:** the user's finalized OpenClaw governing architecture (agreed
this session after independently verifying OpenClaw's real trust model,
`SECURITY.md`, and its published GHSA advisory volume against the
`openclaw/openclaw` repository - see the OPENCLAW TRUST MODEL / OPENCLAW
FLEET REQUIREMENTS / SECURITY ADVISORY WATCHER sections the user added to
the standing directive): one isolated Fleet cell per tenant, never a
shared Gateway, because OpenClaw's own docs state "session IDs select
routing; they do not authorize one tenant against another." This is the
first real slice of that architecture: the authoritative mapping the
control plane must keep, and the lifecycle operations to act on it.

**What was verified before writing any code:**

- Re-cloned `openclaw/openclaw` and read `docs/cli/fleet.md` directly for
  the exact `fleet create/status/start/stop/upgrade/rm` flag syntax,
  defaults (`--memory 2g`, `--cpus 2`, `--pids-limit 512`, loopback-only
  publish, `--cap-drop=ALL`), the tenant-ID grammar
  (`^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`), and the digest-pinning
  syntax (`--image ref@sha256:<digest>`).
- Obtained a **real** image digest directly from the GHCR registry API
  (token exchange against `ghcr.io/token`, then a manifest HEAD against
  `ghcr.io/v2/openclaw/openclaw/manifests/<tag>`) rather than inventing
  one, per the standing instruction. Listed the full tag set via the
  registry's own paginated `tags/list` endpoint and found the
  `openclaw/openclaw` repository's own HEAD version (`2026.8.1`,
  `package.json`) had **only** `2026.8.1-beta.1`/`-beta.2` published to
  the registry - no stable `2026.8.1` tag exists yet. The newest
  published, non-beta, non-architecture-specific stable tag is
  `2026.7.1-2`; its digest
  (`sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac`)
  is what's pinned, not the in-development `2026.8.1`.

**What was built:**

- Migration `061_openclaw_fleet_cells.sql`: `openclaw_fleet_cells`, one
  row per business, holding exactly the mapping the directive specifies -
  `business_id -> fleet_cell_id -> gateway_endpoint -> deployment_version
  -> image_digest -> security_status` - plus a `cell_state` lifecycle
  column and quarantine bookkeeping. Deliberately has **no Gateway token
  column**: Fleet itself doesn't store the token in its own registry
  either (fleet.md), and persisting a live credential in a plain column
  here without the codebase's existing envelope-encryption path
  (`EncryptionService`) would be a real security shortcut - out of scope
  for this slice, called out explicitly rather than worked around.
- `OpenClawFleetCellRepository` - CRUD plus `quarantine`/`clearQuarantine`/
  `listDistinctDeployedVersions` (the shape the Security Watcher will need
  next, to check each *distinct* deployed version once, not once per
  tenant).
- `OpenClawFleetService` - shells out to the real `openclaw` CLI via
  `execFile` with an argument array (never a shell string, matching the
  existing `audioTranscodeService.ts` pattern), never invokes Docker/Podman
  directly. `fleetCellIdForBusiness()` derives the tenant ID from the
  business's own UUID (never user-controlled text) and every ID is
  re-validated against OpenClaw's documented regex regardless. Idempotent
  create/start/stop/remove. `upgradeCell()` refuses any reference that
  isn't `@sha256:`-pinned or that contains `:latest`. `quarantineCell()`
  actually stops the Fleet cell (not just a DB flag) so "quarantined cells
  must not process new AI requests" is real even before the Tool Gateway
  itself checks `security_status` - and still records the quarantine in
  Postgres even if the stop call itself fails, so a security decision is
  never lost to a transient Docker/runtime problem.

**Status: `IMPLEMENTED BUT NOT FULLY VERIFIED`.** The migration, repository,
and CLI-invocation logic are real and covered by tests (9 new tests, all
passing against real Postgres with `execFile` mocked - this sandbox
cannot install the `openclaw` binary or run a real Docker/Podman daemon,
the same constraint that has blocked Docker re-verification since Phase
1). No `fleet create` has been run against a real daemon from this
environment. Full suite: 538/538 passing. Typecheck clean.

**What's still open, in order:** (1) a Security Watcher that polls GitHub
Security Advisories for the exact deployed version and calls
`quarantineCell` on a CRITICAL finding - `listDistinctDeployedVersions()`
above exists for it; (2) real encrypted storage for the Gateway token
returned once by `provisionCellForBusiness`, before any Tool Gateway code
can actually call a cell's Gateway; (3) the Tool Gateway/`agentGuard.ts`
wiring that treats OpenClaw cell output as fully untrusted and mediates
every consequential action through the existing authorization pipeline;
(4) an actual `fleet create` run against a real Docker/Podman host once
one is available, to close the "not fully verified" gap honestly rather
than asserting it from code alone.

## 2026-08-21 - enqueueWithTimeout on the remaining producers (with a correction to the prior audit)

**Branch:** `phase-2-ai-repair` (continues on the same branch as the prior
phases - see the Phase 3 entry for why this branch wasn't split further)

**Context:** Priority 4 from `docs/PRODUCTION_READINESS_DIRECTIVE.md` -
Phase 19's own changelog entry stated the `enqueueWithTimeout` fix was
applied to the two producers on a synchronous request path
(`whatsappOutboundMessageService.send()`, the funnel `WAIT` step) and
that the other four (`enqueueMediaDownload`, message-revocation enqueue,
scheduled-status-publish enqueue, email-send enqueue) were "left unwrapped
- a bounded decision, not an oversight" because "none of those sit in a
synchronous request a user is actively waiting on."

**That claim was checked against the actual call graph for this pass, and
was wrong for three of the four.** Tracing each producer's real callers
back to `server/index.ts`:

- `scheduleStatus()` (→ `enqueueScheduledStatus`) is awaited directly by
  `POST /.../scheduled-statuses/:id/schedule`.
- `approveAndSend()` (→ `enqueueEmailSend`) is awaited directly by
  `POST /.../emails/:id/approve`.
- `revokeMessage()`/`recallCampaign()`/`revokeScheduledStatus()` (→
  `enqueueRevocation`, four call sites total) are awaited directly by
  three separate revoke/recall routes.
- `sendFunnelEmail()`'s `enqueueEmailSend` call is reached from a
  funnel's `SEND_EMAIL` step, which runs synchronously inside
  `enrollContact()` during *initial* enrollment (a real HTTP request) as
  well as from the background `funnelAdvanceWorker` on a WAIT resume -
  the same code path serves both, so it can never be assumed to be
  off-request.

Only `enqueueMediaDownload` (two call sites, both inside the incoming-
messages/status worker, never a synchronous HTTP handler) was genuinely
off the request path as originally claimed.

**What changed:** all six remaining call sites now use
`enqueueWithTimeout`, wrapped after their own durable Postgres write
already committed (`markRevokeRequested`, `updateStatus('SCHEDULED')`,
`emailRepository.approve()`, the message/media insert transaction) -
matching the exact precondition `enqueueWithTimeout`'s own doc comment
requires. A slow or unreachable Redis can no longer hang a real HTTP
request (schedule a status post, approve-and-send an email, delete a
message/campaign/status for everyone) indefinitely; it now returns within
5 seconds with the underlying job left retrying in the background, the
same guarantee the original two producers already had.

**Tests:** no new tests - each wrapped function is exercised by existing
tests (`funnelService.test.ts`, `emailService`/route-level coverage,
message revocation tests) whose continued passing proves the success
path is unchanged, and `enqueueWithTimeout`'s own generic timeout/logging
mechanics are already covered by `test/enqueueWithTimeout.test.ts`
(Phase 19) - six more per-call-site Redis-down integration tests would
duplicate that same generic proof six times over with no new logic to
verify. Full suite: 84/84 test files, 529/529 tests, zero regressions.
Typecheck and production build both clean.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Rollback:** `git revert` the commit, or discard the branch. No schema
migration - purely wraps existing enqueue calls, nothing new persisted.

---

## 2026-08-21 - Phase 18: scheduled security scans (real, finally built)

**Branch:** `phase-2-ai-repair` (continues on the same branch as the prior
phases - see the Phase 3 entry for why this branch wasn't split further)

**Context:** Priority 3 from `docs/PRODUCTION_READINESS_DIRECTIVE.md` -
Phase 18 of the original directive, flagged `NOT IMPLEMENTED` twice
(Phase 20's production audit, and this document) because it needed a real
scoping decision before it could be built at all: "a scan" of *what*,
concretely? The concrete answer found by auditing the actual codebase: two
real, security-relevant denial event types
(`lock_unlock_failure` in `securityLockService.ts`,
`ai_tool_denied` in `agentGuard.ts`) were already being written to
`security_audit_logs` on every real occurrence, but neither ever
triggered a live notification anywhere - confirmed by grepping for
`notifyBusiness`/`notifyUser` near both call sites and finding nothing. A
real brute-force attempt against a business's screen lock, or a pattern
of denied AI tool calls, was invisible unless someone happened to read
the raw audit log by hand.

**What changed:**

- Migration 060: adds `SECURITY_ALERT` to `notifications`' type CHECK
  constraint. Renders automatically in the existing `NotificationCenter`
  UI with zero frontend changes needed - that component styles purely by
  `severity`, not per-type icon logic, confirmed before deciding this
  needed no UI work.
- New `src/services/securityScanService.ts`'s `runSecurityScan()`:
  counts real `security_audit_logs` rows per business, per pattern, over
  a real rolling window (default 24h, env-overridable); when a real count
  crosses a real, per-pattern threshold (5 lock failures, 10 AI tool
  denials - both env-overridable), dispatches one real `SECURITY_ALERT`
  notification. Deliberately only these two patterns to start - not a
  speculative taxonomy of a dozen hypothetical signals.
- Never re-alerts on the same still-ongoing pattern more than once per
  cooldown (default 24h): checks for an existing `SECURITY_ALERT` with
  the same `target_type` (the pattern's own stable key, e.g.
  `security_pattern:lock_unlock_failure` - stored in `target_type` TEXT,
  never `target_id`, which is a strict UUID column) within the cooldown
  window before writing a new one. A real, ongoing brute-force attempt
  produces one alert, not one per scan run.
- Registered as a new `security-scan` BullMQ repeatable job in
  `incomingMessagesWorker.ts`, checked hourly - reuses the existing
  `realtimeEventsQueue`/`upsertJobScheduler` infrastructure the other
  sweeps already use, no new service or external dependency.

**Why not the "02:00-03:00" cron window from the originally pasted
directive:** that specific framing came from an unverified source (see
`docs/PRODUCTION_READINESS_DIRECTIVE.md`'s "explicitly not adopted"
section); an hourly interval-based schedule, matching every other sweep
in this codebase's own established convention, is a real, working
design that does not depend on trusting that detail.

**Tests:** new `test/securityScanService.test.ts` (7 tests, real
Postgres) - a real threshold crossing for each of the two patterns
dispatches a real alert; staying under threshold never alerts; a
still-ongoing pattern is never re-alerted within the cooldown window (one
alert per real incident, not one per scan run); a genuinely elapsed
cooldown does allow a fresh alert; events outside the scan window (an old,
resolved incident) never trigger a fresh alert; and a pattern in one
business is proven to never leak a notification into a different
business's account. Full suite: 84/84 test files, 529/529 tests (up from
522 - the expected +7), zero regressions. Migration 060 applied cleanly.
Typecheck and production build both clean.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Risks:** the default thresholds (5 lock failures, 10 AI tool denials in
24h) and the hourly cadence are reasoned defaults, not tuned against a
real observed attack - both are env-overridable, the same
honestly-flagged category as every other untested-at-scale default in
this codebase (Phase 7's rate limits, this pass's own funnel-sweep
grace window). Scoped to two patterns deliberately; expanding the
pattern list is a config-array addition in `securityScanService.ts`, not
a redesign, whenever a third real signal is identified.

**Rollback:** `git revert` the commit, or discard the branch. Migration
060 is additive (one new allowed `type` value on an existing CHECK
constraint) - reversible via the same drop/re-add pattern used in every
prior migration of this kind.

---

## 2026-08-21 - Funnel stale-instance reconciliation sweep

**Branch:** `phase-2-ai-repair` (continues on the same branch as the prior
phases - see the Phase 3 entry for why this branch wasn't split further)

**Context:** Priority 2 from `docs/PRODUCTION_READINESS_DIRECTIVE.md` - a
gap first flagged (not built) in the Phase 20 production audit: outbound
messages, sync jobs, and emails all have a real sweep reconciling a row
stuck mid-flight with no BullMQ retry left to resolve it
(`sweepStaleOutboundMessages`/`sweepStaleSyncJobs`/`sweepStaleEmails` in
`incomingMessagesWorker.ts`); funnel instances stuck `WAITING` with a lost
`funnel_advance` job did not.

**The real design problem this isn't the other three sweeps' pattern:** a
WAITING funnel instance can legitimately stay WAITING for days by design -
a WAIT node's own configured delay. "How long has it been WAITING" is
therefore the *wrong* staleness signal here, unlike the other three
sweeps where the operation is expected to take seconds. The real signal
is whether the instance's own **recorded, computed resume time** has
passed while it's still WAITING - meaning the delayed job that was
supposed to wake it never fired.

**What changed:**

- Migration 059: `funnel_instances.resume_at` - the real moment (computed
  from the WAIT step's own delay, the same value passed to
  `enqueueFunnelAdvance`) the instance is expected to resume. Set only
  when transitioning into `WAITING`.
- `FunnelRepository.findStaleWaiting(staleSeconds)`: real query -
  `status = 'WAITING' AND resume_at < now() - staleSeconds`. Never
  matches a genuinely-still-waiting instance, however long its WAIT
  delay is, since that comparison is against its own `resume_at`, not a
  fixed age.
- `funnelService.ts`'s `sweepStaleFunnelInstances()`: reconciles a stale
  instance to `FAILED` (existing terminal status, reused) with a real,
  specific `lastError`, and notifies the business
  (`AUTOMATION_FAILURE`) - same honesty discipline as the other three
  sweeps: never silently left claiming to be in-flight forever. **Never
  auto-resumes it** - an automatic resume this sweep triggered could race
  a delayed job that actually still exists and is merely running late
  under real concurrency pressure; reconciling to a visible failure and
  letting the operator re-enroll the contact is the same
  give-up-honestly choice `sweepStaleEmails` already makes rather than
  guessing at a retry.
- Registered as a new `funnel-instance-timeout-sweep` BullMQ repeatable
  job in `incomingMessagesWorker.ts`, checked every 5 minutes (coarser
  than the other sweeps' 1-2 minute cadence, matching how much less
  time-sensitive detecting a lost job is here) with a default 600s grace
  window past `resume_at` before considering a job lost rather than
  merely running behind.

**Tests:** new `test/funnelStaleInstanceSweep.test.ts` (7 tests, real
Postgres) - a real WAIT step records a real future `resume_at`; an
instance whose `resume_at` passed long ago is reconciled to `FAILED` with
an honest error and a real notification; an instance whose `resume_at` is
still genuinely in the future (a long WAIT, working as designed) is left
untouched; an instance only recently past its `resume_at` (inside the
grace window) is left untouched; a non-`WAITING` instance is never
touched regardless of its `resume_at`. Full suite: 83/83 test files,
522/522 tests (up from 516 - the expected +6, plus 1 test proving the
WAIT step now records `resumeAt`), zero regressions. Migration 059
applied cleanly. Typecheck and production build both clean.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Risks:** the 600s default grace window and 5-minute sweep cadence are
reasoned from the existing sweeps' conventions, not tuned against a real
observed lost-job incident (none has been demonstrated in this codebase's
own failure-injection testing) - both are env-overridable
(`FUNNEL_INSTANCE_STALE_SECONDS`), not a claim of having been tuned
against production load, the same honestly-flagged category as Phase 7's
rate-limit defaults.

**Rollback:** `git revert` the commit, or discard the branch. Migration
059 is additive (`resume_at`, nullable, no data migration needed for
existing rows) - reversible via `ALTER TABLE ... DROP COLUMN`.

---

## 2026-08-21 - Context Trust Builder: untrusted-data boundaries around CRM notes and knowledge base content

**Branch:** `phase-2-ai-repair` (continues on the same branch as the prior
phases - see the Phase 3 entry for why this branch wasn't split further)

**Context:** the user asked for a comparison between a second pasted
architecture proposal and the actual current state of this codebase. That
proposal's "Context Trust Builder" section identified a real, independently
confirmed gap that the earlier assessment flagged as the highest-priority
item in `docs/PRODUCTION_READINESS_DIRECTIVE.md` (which supersedes
`PRODUCTION_AUDIT.md` for planning purposes and records the rest of the
still-open backlog, including two items - a funnel stale-instance sweep
and Phase 18's scheduled security scans - carried over unchanged from that
prior audit): `buildSystemInstruction()` in `aiReplyService.ts`
concatenated CRM notes and knowledge-base excerpts directly into the
system prompt as plain text, with no boundary distinguishing "real
business data" from "an instruction this system wrote."

**What changed:** `aiReplyService.ts` gains a real trust boundary:

- `wrapUntrustedData(source, text)` wraps a value in
  `<untrusted_data source="...">...</untrusted_data>`.
- `escapeUntrustedDataBoundary(text)` neutralizes any literal occurrence
  of `<untrusted_data...>` or `</untrusted_data>` *inside* content about
  to be wrapped - without this, a CRM note containing the literal text
  `</untrusted_data>` could forge a close tag and make whatever text
  follows it in that same note appear to be trusted system instructions
  again. Runs on every value passed to `wrapUntrustedData`, unconditionally.
- `buildSystemInstruction()` now wraps CRM `notes` (free text) and every
  knowledge-base excerpt's snippet in this boundary, and - only when there
  is real untrusted data present at all - prepends an explicit rule
  telling the model what the boundary means: real reference material,
  never a command, a role, or a new instruction, regardless of what text
  inside it claims or how it's phrased.
- Deliberately narrow: CRM `stage`/`leadStatus` are controlled enum
  values, not free text, and are left unwrapped - only genuinely
  free-text fields (`notes`, KB `snippet`) go through the boundary. The
  boundary-meaning sentence itself is only added when there is real
  untrusted data to explain (an agent with no CRM match and no KB hits
  gets the exact same prompt as before this change).

**Why this matters regardless of whether any of these fields have
actually been abused yet:** CRM notes are operator-editable free text -
an operator could paste in something copied from a customer email or
complaint without noticing it contains injection-style phrasing, and a
future integration writing to either table would inherit the same risk
automatically. This is the same reasoning the codebase already applies to
input validation generally: not skipped just because most input happens
to be honest.

**Tests:** 8 new tests in `test/aiReplyService.test.ts` -
`escapeUntrustedDataBoundary` neutralizes both a bare close tag and an
open tag with attributes while preserving the surrounding text;
`wrapUntrustedData` produces the exact well-formed boundary string;
`buildSystemInstruction` wraps real CRM notes and real KB excerpts and
adds the boundary-meaning rule; a CRM note engineered to forge a close
tag is proven to never actually produce more than the one real
`</untrusted_data>` this function itself appends; structured CRM fields
are proven to stay unwrapped; and the boundary/rule are proven absent
entirely when there is no untrusted data (no CRM match, no KB hits) - the
prompt for that case is unchanged from before this pass. Full suite:
82/82 test files, 516/516 tests (up from 508 - the expected +8), zero
regressions. Typecheck and production build both clean.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Risks:** this raises the bar against prompt injection via CRM/KB
content, it does not eliminate the risk category - a sufficiently capable
model could still be manipulated by text framed as data rather than as an
instruction. This is defense-in-depth, not a claimed-complete fix; the
existing "reply only using the real information above... never invent
facts" hard rule in the same prompt remains the other half of this
defense, unchanged.

**Rollback:** `git revert` the commit, or discard the branch. No schema
migration - this is a prompt-construction change only, nothing new
persisted to the database.

---

## 2026-08-21 - DSPy prompt optimization: a real, separate offline service with a human-approval-only interface into the live app

**Branch:** `phase-2-ai-repair` (continues on the same branch as the prior
phases - see the Phase 3 entry for why this branch wasn't split further)

**Context:** the user asked to evaluate installing several external
repositories (OpenClaw, DSPy, OpenPanel, Apache Cloudberry, "Pic Smaller")
as real, running parts of the architecture - explicitly not merged into
this codebase, each behind a controlled interface, WhatchatAI remaining
the orchestrator. Given the size of that ask (one of the five is a
distributed MPP data warehouse), the current architecture was described
back to the user first, and they chose to sequence DSPy in first: lowest
cost/risk of the five (an offline Python tool, no new always-on service,
no Docker pull needed - unlike a container-based dependency, which this
sandbox's egress policy has blocked since Phase 1).

**What changed - the Node/Postgres side (the "controlled interface" the
user's own architecture note called for):**

- Migration 057: `ai_agent_prompt_optimizations` - a real table holding
  each optimization attempt as `pending_review` / `approved` / `rejected`,
  with a snapshot of the agent's `system_instruction` at import time
  (`baseline_instruction`) so the diff is always visible.
- Migration 058: extends `security_audit_logs`' event-type CHECK
  constraint with `ai_prompt_optimization_imported` / `_approved` /
  `_rejected` - every state transition writes a real, visible audit row,
  same discipline as Phase 7's `ai_tool_invoked`/`ai_tool_denied`.
- New `src/repositories/aiAgentPromptOptimizationRepository.ts` and
  `src/services/ai/promptOptimizationService.ts`: `importPromptOptimization()`
  only ever creates a `pending_review` row - the live agent is provably
  unaffected by import alone (asserted directly in the tests, not just
  implied). `approveOptimization()` is the one function that changes a
  live agent's behavior, and it does so through the *exact same*
  `AiAgentRepository.update()` a manual Settings edit already uses -
  not a separate, lesser-audited code path for changing what an agent
  says. A row can only be decided once (`markApproved`/`markRejected`
  both `WHERE status = 'pending_review'` - a second approve/reject on an
  already-decided row is rejected, proven in the tests).
- 4 new API routes under `/api/workspace/agents/:agentId/prompt-optimizations`
  (list, import, approve, reject), gated by the existing `ai.view`/`ai.edit`
  permissions - no new permission was invented for this.
- New `PromptOptimizationsPanel` component, shown when editing an existing
  agent in `AgentsPage.tsx`: paste an artifact's JSON to import it for
  review, then approve or reject each pending one. Approving asks for
  explicit confirmation before applying.

**What changed - the actual DSPy tool (`services/prompt-optimizer/`, real
Python, genuinely separate):**

- No Postgres/Redis client or credential anywhere in the directory - it
  cannot reach WhatchatAI's database even by accident. Not imported by,
  or wired into, any queue/worker/route in the Node app - there is no
  automatic or scheduled optimization pass; re-running it is always a
  deliberate, manual, by-hand action, and its only interaction with the
  live app is the JSON file it writes.
- `dspy-ai==3.3.0` installed and verified importable in this sandbox
  (network egress for `pip` is not blocked the way Docker Hub pulls are).
  Includes `gepa` as a transitive dependency - the same optimizer named
  explicitly in the user's own architecture note.
- `whatchat_prompt_optimizer/signature.py`: a real DSPy `Signature`
  mirroring the actual live prompt shape in `aiReplyService.ts`'s
  `buildSystemInstruction()` - deliberately narrower than that function:
  the trusted TimeContext grounding, the advice-restricted-category hard
  scope limit, and "never invent facts" are fixed, code-owned safety
  rules and are never a candidate for optimization. Only the operator's
  own free-text `system_instruction` field is.
- `dataset.py`: strict JSONL loader/validator - a malformed row, an
  unrecognized field, or an empty dataset is a hard error, never silently
  skipped or defaulted.
- `metric.py`: a real LLM-judge metric (the standard DSPy pattern for a
  task where exact-string-match is meaningless) - scores a candidate
  reply against the operator's own `ideal_reply`, using the same
  configured LM as the optimizer itself.
- `optimize.py`: the CLI entrypoint - loads a dataset, requires a real
  `GEMINI_API_KEY` (refuses to run without one rather than doing nothing
  silently), runs `BootstrapFewShot` (default) or `GEPA`, and writes a
  JSON artifact in exactly the shape the Node import endpoint expects,
  with the metric score computed on a held-out validation split only
  (never on the training set, which would overstate real quality).

**What is genuinely verified vs. not:** everything Node-side is real,
migrated, and tested against live Postgres (see Tests below). On the
Python side, package installation, the signature/program construction,
dataset validation, artifact writing, and CLI argument handling are all
covered by 20 real, currently-passing, non-mocked tests. What is **not**
verified from this sandbox: an actual end-to-end optimization run against
a real Gemini API key - there is no `GEMINI_API_KEY` available here, and
the tool refuses to run without one rather than fabricating a result. This
mirrors the same standing constraint noted for Phase 4/Phase 5 - the one
remaining step is trying it against a real key and a real dataset in a
real deployment.

**Deliberately not built in this pass:** OpenClaw, OpenPanel, Apache
Cloudberry, and "Pic Smaller" remain unstarted - the user chose to
sequence DSPy first specifically because it carries the least
infrastructure risk of the five; OpenPanel needs a scoping answer
(operator-facing vs. customer-facing analytics) before wiring events,
Cloudberry is a materially larger commitment (a distributed data
warehouse) that should not be stood up without a real, named analytical
problem driving it, and "Pic Smaller" was never identified (no repository
URL was provided). No auto-apply path was built for an optimization
result under any condition - every application requires an explicit,
authenticated `POST .../approve` call, by design.

**Tests:** new `test/promptOptimizationService.test.ts` (8 tests, real
Postgres) - import creates a real `pending_review` row and provably never
touches the live agent; import is rejected for a nonexistent or
cross-tenant agent; an empty or 8001-character instruction is rejected;
approve applies through the real `AiAgentRepository.update()` path and
preserves every other field; reject never touches the live agent; a
decided optimization can never be re-decided; cross-tenant/cross-agent
approve-or-reject is rejected; list is scoped to one agent, newest first.
New `services/prompt-optimizer/tests/` (20 tests, `pytest`, no live model
call) - see that service's own README for the exact breakdown. Full
backend suite: 82/82 test files, 508/508 tests passing (up from 500 - the
expected +8), zero regressions. Migrations 057-058 applied cleanly against
a real database. Typecheck (backend + web) and production build both
clean.

**Status:** `IMPLEMENTED BUT NOT FULLY VERIFIED` - the Node-side controlled
interface is `IMPLEMENTED AND VERIFIED` (real DB, real tests, all passing).
The Python tool's own logic is verified the same way, but the actual value
proposition - DSPy producing a genuinely better instruction - has not been
observed end-to-end, since that requires a real API key and a real
dataset neither of which exist in this sandbox.

**Risks:** an operator could paste a low-quality or adversarially-crafted
artifact into the import form by hand (bypassing the Python tool
entirely) - the service-level validation (non-empty, ≤8000 chars) is real
but shallow; the actual safeguard against a bad instruction reaching
customers is the mandatory human review step before approval, not
automated content validation. The `system_instruction` field an approved
optimization replaces was already fully operator-editable before this
phase (via a plain Settings form) with no stronger validation - this adds
a second way to reach the same field, not a new risk class.

**Rollback:** `git revert` the commit, or discard the branch. Migrations
057-058 are additive (`ai_agent_prompt_optimizations` is a new table with
no existing FKs into it from elsewhere; the CHECK constraint change is the
same reversible drop/re-add pattern used in every prior migration of this
kind). `services/prompt-optimizer/` can be deleted outright with zero
effect on the Node application - nothing in `src/` imports from it.

---

## 2026-08-21 - Phase 5: multimodal AI - real image/audio/video understanding for inbound media messages

**Branch:** `phase-2-ai-repair` (continues on the same branch as the prior
phases - see the Phase 3 entry for why this branch wasn't split further)

**Context:** the user asked which next step would be the biggest real
step forward, delegating the judgment call. Reading the actual AI-handoff
trigger in `src/queue/workers/incomingMessagesWorker.ts` found a genuine,
significant, customer-facing gap: `needsAiHandoff` required
`Boolean(result.message.textContent)`, and `textContent` is only ever
populated from a real caption (`imageMessage.caption` etc.) - so any
WhatsApp message that was *only* a photo, video, voice note, or document
with no caption text never reached the AI at all, silently, regardless of
how the agent was configured. Voice notes in particular can never carry a
caption (not a WhatsApp feature), so every voice message a customer ever
sent was unanswerable by design. Gemini (already the only model in use via
`aiReplyService.ts`) natively accepts inline image/audio/video/PDF bytes in
the same `generateContent` call shape already used, so closing this gap
needed no new external dependency - only wiring real, already-downloaded,
already-decrypted media bytes into the existing call.

**What changed:**

- **New `src/services/ai/mediaContext.ts`:** `resolveInlineMediaPart()`
  turns a real, already-downloaded, checksum-verified `whatsapp_media` row
  into the exact `{mimeType, data}` (base64) shape Gemini's `inlineData`
  part expects - decrypting through the existing
  `localEncryptedMediaStorage.retrieveMedia()`. Returns `null` (never
  throws, never fabricates bytes) when the media hasn't finished
  downloading yet, its mimeType isn't one of Gemini's documented supported
  inline types (an allowlist - unsupported types like `.docx` degrade to
  text-only rather than being force-fed to the model), or it exceeds a
  15MB inline-request budget. `mediaFallbackText()` produces an honest,
  factual placeholder ("[The customer sent a photo.]" /
  "...but it could not be retrieved.]") for a caption-less media turn -
  distinguishing "the model can actually see/hear this" from "we only know
  it was sent" so the model is never left assuming it saw something it did
  not.
- **`aiContextGathererService.ts` / `aiOrchestrator.ts`:** `AiHandoffContext`
  now carries a `media: InlineMediaPart | null` field, resolved in the same
  `Promise.all` as the rest of the context (CRM, knowledge base, history).
- **`aiReplyService.ts`'s `toContents()`:** previously filtered out *any*
  message with no `textContent` - meaning a caption-less media message was
  silently dropped from the conversation Gemini ever sees, not just
  unanswered. Now keeps any message with real text **or** real media,
  attaching the actual decoded image/audio/video bytes as an `inlineData`
  part on the triggering (most recent) turn only, when real bytes
  resolved. Historical media turns are described, never re-attached - this
  codebase never stored retroactive image/audio understanding. Goose
  failover (`tryGooseFallback`) strips inline bytes back to text-only
  before calling out, since Goose's own contract has no multimodal
  understanding to hand them to.
- **`incomingMessagesWorker.ts`:** media download is a separate, async
  BullMQ job (`processMediaDownload`) that can complete well after the
  triggering message is persisted - so a media message's AI handoff can no
  longer fire at persist time (`processJob`) the way a text-only message's
  does; it would either reply before it could see the media, or (for a
  caption-less one) never fire at all. The handoff decision + every real
  side effect (notifications, `ai_mode` transitions, the outbound send)
  was extracted into a shared `runAiHandoff()`, now called from two real
  places: immediately in `processJob` for text-only messages (unchanged
  behavior), and from a new `maybeTriggerMediaAiHandoff()` in
  `processMediaDownload`, once a media message's real download outcome
  (success, failure, or unavailable) is durably recorded. `processMediaDownload`
  itself was restructured to compute that outcome once and record/react to
  it exactly once, instead of five duplicated `setDownloadResult()` calls
  each returning early - a failed/expired download now still reaches the
  message lookup and triggers a real (mediaId: null, honest fallback text)
  AI handoff, instead of leaving the customer's message permanently
  unanswered the way an early return previously would have.

**Deliberately not built in this pass:** sticker messages are excluded
from the AI-relevant media set (low informational value, high risk of an
odd reply to meme content). Non-PDF documents (`.docx`, `.xlsx`, etc.)
degrade to text-only/caption-only - Gemini's inline document support is
scoped to `application/pdf` here, not attempted for types it cannot
reliably parse inline. Media over the 15MB inline budget is never
chunked or summarized - it degrades to text/caption-only rather than a
partial or fabricated description. `whatsapp_media.transcript` /
`ai_interpretation` (pre-existing, unused schema columns since Phase A)
were not wired up to persist a description back onto the media row -
the model's understanding is used live for the one reply, not stored;
that remains a real, separate, un-built feature if ever wanted.

**Tests:** new `test/mediaContext.test.ts` (9 tests) - real Postgres media
rows + real encrypted-at-rest bytes throughout, proving
`resolveInlineMediaPart` returns the exact original bytes for a real
downloaded/verified image, and returns `null` (never throws, never
fabricates) for not-yet-downloaded, unsupported-mimeType, oversized, and
nonexistent-mediaId cases; plus pure unit tests for `mediaFallbackText`'s
honest phrasing. `test/aiReplyService.test.ts` updated: the old "no real
text to reply to" test used a caption-less media message as its example,
which is exactly the case this phase fixes - split into a genuine
empty-history test (still short-circuits) and a new test proving a
caption-less media message now really does attempt a reply (honestly
reporting `GEMINI_API_KEY` unavailability in this environment, never a
silent no-op). No existing test exercised the old, narrower
`needsAiHandoff`/`processMediaDownload` behavior directly, so no other
test required updating; the existing `test/mediaDownloadWorker.test.ts`
and `test/aiReplyWorkerIntegration.test.ts` (text-only messages) both
continued to pass unmodified. Full suite: 81/81 test files, 500/500 tests
passing (up from 491 - the expected +9), zero regressions. Typecheck
(backend + web) and production build both clean.

**Status:** `IMPLEMENTED BUT NOT FULLY VERIFIED` - the code path is real
(no mocks, no fabricated data, real DB/encryption round-trips proven in
tests) and reasoned through carefully for the async-download timing
issue, but an actual end-to-end WhatsApp photo/voice message producing a
real Gemini reply that correctly describes the media has not been
observed live in this sandbox - there is no live Baileys connection or
`GEMINI_API_KEY` available here (the same standing constraint as Phase 4
and every other live-model/live-WhatsApp verification in this engagement).

**Risks:** the 15MB inline-media cap and the Gemini-supported-mimeType
allowlist are reasoned from the provider's documented limits, not proven
against a real deployed model/key from this sandbox - the exact same
category of gap Phase 7's changelog entry already flagged for its
rate-limit defaults. Deferring a media message's AI handoff until its
download completes adds real latency (typically seconds) to the reply for
a captioned image/video that previously replied instantly on the caption
alone - an accepted, documented tradeoff for actually seeing the image,
not a regression missed.

**Rollback:** `git revert` the commit, or discard the branch. No schema
migration in this phase - `media`/`inlineData` is a request-shape and
in-memory addition only, nothing new persisted to the database.

---

## 2026-08-21 - Phase 7 (scoped): the AI Security Governor - real tenant/actor/tier/rate authorization for every AI tool call

**Branch:** `phase-2-ai-repair` (continues on the same branch as the prior
phases - see the Phase 3 entry for why this branch wasn't split further)

**Context:** the user asked to evaluate integrating OpenClaw
(`github.com/openclaw/openclaw`), a large, actively-developed standalone
"multi-channel AI gateway" product, as Phase 7. Before writing any code,
the real OpenClaw repository was cloned and read directly rather than
trusting a pasted architecture proposal at face value:

- Confirmed real: OpenClaw's own Docker hardening guidance (non-root,
  `--read-only`, `--cap-drop=ALL`), its default-deny bind-mount list
  (`/etc`, `/proc`, `/sys`, `/dev`, `/root`, Docker socket paths,
  credential directories), and its documented HTTP tool-invoke auth model
  (any valid Gateway credential = full trusted-operator access - no
  narrower per-caller scope exists on that surface).
- Corrected: a cited `CVE-2026-27002` does not exist in OpenClaw's own
  security advisories. The two real CVEs referenced there
  (`CVE-2025-59466`, `CVE-2026-21636`) are Node.js runtime vulnerabilities
  addressed by a minimum Node version, not OpenClaw application CVEs.
- Flagged as unverifiable/likely fabricated and dropped: a closing
  paragraph referencing a "deaf session detector," "reachout timelock
  guard," and "463 spam errors" - none of these exist anywhere in
  WhatchatAI's actual codebase.
- The decisive, repo-verified fact: OpenClaw's own `SECURITY.md` states
  its trust model explicitly - *"personal assistant (one trusted
  operator), not shared multi-tenant bus"* - and recommends one Gateway
  per trust boundary, ideally one host/VPS per operator. For a
  multi-tenant SaaS, that means one full OpenClaw deployment per
  business, not a shared instance - a real infrastructure and cost
  decision, not just an engineering one. Separately, this sandbox's own
  egress policy already blocks Docker Hub pulls (hit in Phase 1), so an
  actual OpenClaw container cannot be built or booted from here.

Given that, the user chose to build the authorization layer first
(their own "Wall 1: WhatchatAI Authorization" concept) - real,
testable in this sandbox today, and useful regardless of whether or when
an actual OpenClaw deployment happens, since it is the same gate any
future external-tool-execution surface would have to pass through.

**What changed:** `src/services/ai/agentGuard.ts`'s `guardToolInvocation`
- previously a single "is this tool name registered?" check - is now a
real, five-stage authorization pipeline, run in this order:

1. **Tool registered?** (existing, unchanged)
2. **SYSTEM-tier tool?** Always denied - new `isTierAlwaysDenied()` in
   `aiToolPolicy.ts` enforces the directive's own rule ("no AI agent
   given SYSTEM permissions in the production conversation path") as
   code, not just a convention future tool additions have to remember.
3. **Tenant real?** (new) `businessId` is now checked against a live
   `businesses` row - previously trusted blindly.
4. **Actor real?** (new) `agentId` is now checked against a live,
   `ACTIVE` `ai_agents` row that belongs to *this exact* `businessId` -
   closes a real gap where a forged or cross-tenant `agentId` was
   previously only ever logged, never verified. Proven directly: a test
   creates a real, active agent belonging to a *different* business and
   confirms it is rejected for this one.
5. **Rate limit.** (new) A real, Postgres-backed per-business-per-tool
   ceiling over a rolling window (default 5 minutes), tiered by risk
   (READ 120, WRITE 30, SEND 15, HIGH_RISK 5, SYSTEM 0 - proportionate to
   what exists today, a single READ tool, not tuned against real
   WRITE/SEND traffic that has never run). Uses the same convention as
   the existing login rate limiter (count real rows in a window), not a
   new Redis counter: `SecurityAuditLogRepository.countRecentByBusinessAndTool()`.

**Also fixed:** previously, any denial (the one unregistered-tool case
that existed before this phase) threw an error but wrote nothing to the
audit trail - an operator had no way to see a rejection had even
happened, only the customer-facing "unavailable" reply. Every denial now
writes a real `ai_tool_denied` audit event (`severity: 'critical'`,
migration 056 extends the event-type constraint) before throwing - except
where a business genuinely does not exist, where `security_audit_logs`'
own FK to `businesses(id)` makes attribution impossible; the throw itself
still stops the call in that case, verified in the test.

**Deliberately not built in this pass:** `ai_agents.allowed_tools` /
`forbidden_tools` - real JSONB columns that already exist in the schema
(migration 022) but are not mapped into `AiAgentRecord`, not read
anywhere, and have no UI to set them. Wiring up enforcement for a
completely dark, un-settable field would be dead code; flagged as a real,
pre-existing gap for a future pass that also adds the missing UI, not
built speculatively here. Actual OpenClaw container/deployment work
(Dockerfile, network policy, version pinning, a GitHub Security Advisory
watcher) also remains undone, pending the user's own infrastructure
decision on per-tenant deployment cost.

**Tests:** `test/agentGuard.test.ts` expanded from 3 to 9 tests - unknown
tenant denied, unknown actor denied, a real active agent belonging to a
*different* business denied (the cross-tenant case), an archived agent
denied, the rate limit enforced and audited once the ceiling is reached,
and the SYSTEM-tier-always-denied rule unit-tested directly. Two existing
tests in `test/agentGuard.test.ts` were updated to reflect the new
denial-is-audited behavior and to use a real registered agent instead of
a fake string id. Three tool-calling tests in `test/aiReplyServiceRetry.test.ts`
were updated to use a real business + real active agent (via `register()`
+ `AiAgentRepository.create()`) instead of fake ids, since the governor's
new actor check is real and those tests exercise the real tool-call path
through `generateAiReply`. Full suite: 80/80 test files, 491/491 tests
passing (up from 485 - the expected +6), zero regressions. Typecheck and
production build both clean; migration 056 applied cleanly against a
real database.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Risks:** the rate-limit defaults are genuinely untested against real
traffic (only one READ tool exists) - they are a reasonable starting
point, explicitly env-overridable, not a claim of having been tuned
against production load.

**Rollback:** `git revert` the commit, or discard the branch. Migration
056 is additive (`ai_tool_denied` added to an existing CHECK constraint) -
reversible via the same drop/re-add pattern with that value removed.

---

## 2026-08-21 - Phase 6: real knowledge base backend for AI agents

**Branch:** `phase-2-ai-repair` (continues on the same branch as Phases
2-3, 16-17, 19-20 - see the Phase 3 entry for why this branch wasn't
split further)

**Context:** `src/services/knowledgeBaseSearchService.ts` already existed
as an honest stub (`available: false`, zero results, `reason: 'not yet
implemented'`), already wired through `aiContextGathererService.ts` into
`AiHandoffContext` and already surfaced in the Gemini prompt in
`aiReplyService.ts` (`context.knowledgeBase.available && ... results`).
This phase replaces the stub with a real backend behind the exact same
interface - no downstream code changed.

**Added:**
- Migration 055: `knowledge_base_documents` (business-scoped title/content
  documents with a generated, GIN-indexed `tsvector` column), plus a
  `max_knowledge_base_documents` entry in the existing generic
  `plan_entitlements` mechanism (same pattern campaigns/funnels already
  use - Starter 10, Growth 50, Business 200, Enterprise unlimited).
- `src/repositories/knowledgeBaseRepository.ts` / `src/services/
  knowledgeBaseService.ts` - real CRUD with tenant scoping and entitlement
  enforcement, following the funnel/campaign service conventions exactly.
- Real search: `knowledgeBaseSearchService.ts` now calls Postgres native
  full-text search (`ts_rank` over the generated `tsvector`) - deliberately
  not an embeddings/vector store, since that would add a new external
  per-query API dependency and, most likely, a Postgres extension
  (pgvector) not present in this project's `postgres:16-alpine` image, for
  a feature with no demonstrated need for semantic matching yet.
- `GET/POST/PATCH/DELETE /api/workspace/knowledge-base`, gated by the
  existing `settings.manage` permission.
- `KnowledgeBaseCard.tsx` - a real Settings panel (add/edit/delete, real
  entitlement-limit error surfaced from the API) following the existing
  `IntegrationSettingsPanel`/card conventions exactly.

**Real bug found and fixed during this phase, not assumed correct from
reading the code:** the first working version used `plainto_tsquery`,
Postgres's default for a plain-text query, which ANDs every term
together - wrong for this use case, since the AI passes a whole natural-
language customer message as the query (e.g. "how long does shipping
take"). Verified empirically against a real document ("Standard shipping
takes 5 to 7 business days") that `plainto_tsquery` returned zero results
for that exact query, because the document doesn't contain the word
"long". Fixed by OR-combining the query's own stemmed lexemes
(`strip(to_tsvector(...))` + a `|`-joining `regexp_replace`, a documented
Postgres idiom) so a document matching any significant term is found,
ranked by how many terms it actually matches. A second, unrelated bug
surfaced while fixing the first: the regex literal `\s+` written directly
in a TypeScript template-literal SQL string is silently stripped by JS's
own string-escaping to `s+` (JS treats an unrecognized backslash-letter
escape as just the letter) - verified by reproducing the exact corrupted
query Postgres received, then fixed by escaping it as `\\s+` so the
literal backslash actually reaches Postgres.

**What was deliberately not built:** a `deleteFunnel`-style safety check
against in-use documents doesn't apply here (a document has no dependent
state to strand); no dedicated `security_audit_logs` events for KB CRUD
(matching the existing CRM-contact precedent - static reference content a
business writes itself, not a security-relevant event class like
locks/auth/campaigns-that-send-real-messages).

**Verification:** full click-through browser verification (add/edit/
delete via the real Settings UI) was attempted with a real Playwright-
driven Chromium session against the real dev stack, but the app correctly
gates all authenticated routes on a live Baileys WhatsApp connection
(`useAppGate`) - there is no dev-only bypass, and this sandbox has no real
phone to pair, so the gate could not be passed. This is the same
constraint already documented for Phase 4, not a gap introduced here. In
its place: a production build (`tsc` + `vite build`) confirms the
component compiles and type-checks cleanly, and the backend is proven
end-to-end by 9 real-Postgres tests: full CRUD, empty-title/content
rejection, cross-tenant update/delete refusal, the real per-plan
entitlement limit, a real full-text match ranked correctly, an honest
empty-result case distinguished from unavailability, and cross-tenant
search isolation. Full suite: 80/80 test files, 485/485 tests passing (up
from 478 - the expected +7 in the new file), zero regressions. Typecheck
and production build both clean; migration 055 applied cleanly against a
real database.

**Status:** `IMPLEMENTED AND VERIFIED` at the backend/API level;
`IMPLEMENTED BUT NOT BROWSER-VERIFIED` for the Settings UI specifically,
for the reason above - not claimed as fully verified where it wasn't.

**Rollback:** `git revert` the commit, or discard the branch. Migration
055 is additive (new table, new entitlement rows) - reversible via a
plain `DROP TABLE` and a `DELETE FROM plan_entitlements WHERE
entitlement_key = 'max_knowledge_base_documents'`.

---

## 2026-08-21 - Phase 20: final production audit

**Branch:** `phase-2-ai-repair`

**Changed:** Added `PRODUCTION_AUDIT.md` - a roll-up of every phase
actually completed this session (0, 1, 2, 3, 16, 17, 19), an honest list
of what was explicitly declined and why (Phases 5, 7-15, 18 - speculative
new infrastructure with no demonstrated need, per the directive's own
anti-over-engineering principle), and every currently-open, real gap
found along the way (the unwrapped lower-priority BullMQ producers from
Phase 19, no stale-instance sweep for funnels, Docker only verified once
externally, Phase 18 never started). No application code changed.

**Status:** `IMPLEMENTED AND VERIFIED` - every claim in `PRODUCTION_AUDIT.md`
was checked against real output in this session: `npx tsc --noEmit`
clean, `npm run build` clean, full test suite 79/79 files and 478/478
tests passing against a real Postgres/Redis, and all 54 migrations
applying cleanly in order.

**Rollback:** `git revert` the commit, or discard the branch. Documentation
only.

---

## 2026-08-21 - Phase 19: real failure-injection testing against Postgres and Redis

**Branch:** `phase-2-ai-repair` (continues on the same branch as Phases
2-3, 16, and 17 - see the Phase 3 entry for why this branch wasn't split
further)

**Method:** this was real fault injection against this sandbox's actual
running Postgres and Redis, not a written-up hypothetical. `sudo service
postgresql stop`/`start` and `redis-cli shutdown nosave` /
`redis-server --daemonize` were used to kill and restore each dependency
while the real dev server (`npx tsx src/server/index.ts`) was up and being
hit with real `curl` requests, plus one isolated script that added a real
job to a real BullMQ `Queue` against a stopped Redis to measure what
`queue.add()` actually does (never assumed).

**Findings, in the order discovered:**

1. **Postgres outage: already handled correctly.** `/api/health/database`
   returned an honest `503 DATABASE_UNAVAILABLE` with the real driver
   error; a route with no dedicated DB-error handling (`/api/auth/
   bootstrap-status`) returned a `500` rather than hanging or crashing the
   process; the server recovered automatically once Postgres came back,
   with no restart needed. No fix required here - this confirms Phase 0's
   task #6/#8 groundwork still holds.

2. **Real bug: the generic error handler leaked internal error text to
   any client.** The Postgres-down `500` response's `message` field was
   the raw driver error verbatim (`"connect ECONNREFUSED
   127.0.0.1:5432"`) - this is the fallback handler every unhandled route
   error in the app reaches, so any internal detail an unexpected error
   carries (connection strings, and depending on the error's origin
   potentially SQL fragments) was reachable by any caller, authenticated
   or not. **Fixed:** the client-facing `message` is now generic
   (`"An unexpected error occurred."`) whenever `NODE_ENV === 'production'`
   (the setting this app's own `docker-compose.yml` already uses) - the
   full error is still logged server-side via the existing
   `console.error`, and development keeps the detailed message for local
   debugging. Verified live in both modes: dev mode still shows the raw
   error under a real Postgres outage; a real `NODE_ENV=production`
   instance under the same outage returns the generic message.

3. **Real bug: a Redis outage hangs any request awaiting `queue.add()`
   indefinitely, never failing honestly.** BullMQ's own required worker
   setting `maxRetriesPerRequest: null` (see `src/queue/connection.ts`'s
   comment) means ioredis retries a command forever rather than
   rejecting - correct for a background worker with no deadline, wrong
   for an HTTP request awaiting an enqueue directly. Verified empirically:
   a real `Queue.add()` call against a real, stopped Redis neither
   resolved nor rejected for the full 8-second observation window. Any
   route synchronously awaiting an enqueue - a composer send, a campaign
   send, a funnel `WAIT` step (`enrollContact` → `runFromPosition`) -
   would hang the HTTP request for as long as Redis stayed down. **Fixed:**
   added `src/queue/enqueueWithTimeout.ts`, a small wrapper that races the
   enqueue call against a 5s timeout and returns control to the caller
   either way, logging (not swallowing) a deferred failure if the
   underlying call eventually does reject. This does not change delivery
   correctness, only response latency: every call site this wraps
   (`whatsappOutboundMessageService.send()`, the funnel `WAIT` step) only
   calls it *after* the durable Postgres row already exists as `queued`/
   `WAITING`, so if Redis is merely slow to reconnect the background
   retry still succeeds once it recovers, and if Redis stays down long
   enough the existing stale-row reconciliation sweeps
   (`sweepStaleOutboundMessages` et al.) already fail it honestly and
   notify the business - this fix's only job is to stop the HTTP request
   itself from blocking on an enqueue call that may never return promptly.

4. **Real, minor gap: `checkRedisHealth()` existed but was never wired to
   a route.** `src/redis/client.ts` already had a correct, working health
   check (its own client already uses `maxRetriesPerRequest: 3`, so it
   fails fast rather than hanging) - it was simply dead code, unreachable
   from outside the process. **Fixed:** added `GET /api/health/redis`,
   mirroring the existing `/api/health/database` convention exactly.
   Verified live: reports `200 CONNECTED` normally and a real `503
   REDIS_UNAVAILABLE` (with the real ioredis error) when Redis is stopped.

**Explicitly NOT fixed in this pass (documented, not silently skipped):**
the same indefinite-hang risk exists at every other BullMQ producer in the
codebase - `enqueueMediaDownload`, message-revocation enqueue,
scheduled-status-publish enqueue, and email-send enqueue - but none of
those sit in a synchronous HTTP request-response path a user is actively
waiting on (they're triggered by async worker-side events or background
jobs), so wrapping them was judged lower-value and out of this phase's
bounded scope; a future pass could apply `enqueueWithTimeout` there too if
a concrete need is demonstrated. No new stale-instance reconciliation
sweep was added for funnel instances stuck in `WAITING` with a lost
funnel-advance job (unlike outbound messages/sync jobs/emails, which
already have one) - flagged as a real, undemonstrated-yet-plausible gap
for a future pass, not built speculatively here.

**Tests:** 3 new in `test/enqueueWithTimeout.test.ts` (fake-timer-based,
deterministic: resolves promptly on a fast enqueue, returns at the
timeout boundary without hanging on a stalled one, and logs rather than
swallows a deferred late rejection). Full suite: 79/79 files, 478/478
tests passing (up from 475 - the expected +3), zero regressions.
Typecheck and production build both clean. No schema changes this phase.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Rollback:** `git revert` the commit, or discard the branch. No schema
or dependency changes.

---

## 2026-08-21 - Phase 17: campaign dispatch-failure lifecycle hardening

**Branch:** `phase-2-ai-repair` (continues on the same branch as Phases
2-3 and 16 - see the Phase 3 entry for why this branch wasn't split
further)

**Audit finding:** `sendCampaign()` in `src/services/campaignService.ts`
caught a per-recipient `whatsappOutboundMessageService.send()` failure
(e.g. `ChatNotFoundError` - a real, already-possible error when a
recipient's chat vanishes between recipient-list creation and send time)
with only a `console.error`, leaving `campaign_recipients.outbound_
message_id` NULL forever for that recipient. `getStatusCounts()`'s
`queued` filter (`WHERE om.id IS NULL OR om.status IN (...)`) counted
that permanently-unlinked row as `queued` indefinitely, so
`maybeCompleteRunningCampaign()` (which only flips `RUNNING` ->
`COMPLETED` once `queued === 0`) could never resolve the campaign to a
terminal status. The business was never told a send had silently failed
for some recipients - the exact same silent-stuck-forever failure class
already closed elsewhere in this codebase for stale sync jobs, stale
outbound messages, and stale emails via their own `last_error` columns
and stale-reconciliation sweeps, just not yet closed here.

**Fixed:** Added `campaign_recipients.last_error` (migration 054, same
`last_error TEXT` convention as `funnel_instances`/`email_messages`/
`whatsapp_sync_jobs`/`whatsapp_outbound_messages`). `sendCampaign()`'s
catch block now calls the new `campaignRepository.recordDispatchFailure()`
before continuing to the next recipient. `getStatusCounts()` and the
per-recipient status `CASE` in `listRecipients()` both now treat "no
outbound message AND a recorded `last_error`" as a real terminal `failed`
state rather than perpetual `queued` - so a campaign with a genuine
dispatch failure now correctly reaches `COMPLETED` once every recipient
has a terminal outcome, exactly as it already did for provider-side
failures (`om.status = 'failed'`). If any recipient failed to dispatch,
the business now gets a real `AUTOMATION_FAILURE` notification naming the
campaign and the failure count.

**Scope decision:** `cancelCampaign()`'s existing status-machine
restriction (only `DRAFT`/`REVIEW`/`APPROVED` may be cancelled, never
`RUNNING`) was left unchanged - it is already honest: `sendCampaign()`
enqueues each recipient's send as a real, already-delayed BullMQ job, so
a `RUNNING` campaign has no in-flight state a cancel could actually stop
without either faking success or racing the queue; refusing to pretend to
cancel it is correct, not a gap.

**Tests:** 1 new in `test/campaignService.test.ts` (mocks
`whatsappOutboundMessageService.send` to reject once, exactly the real
failure shape, via `vi.spyOn(...).mockRejectedValueOnce` rather than
hard-deleting a chat row, since `campaign_recipients.chat_id` CASCADEs on
that table and would delete the recipient row itself instead of
reproducing the failure) - proves the recipient reaches `failed`
(`outboundMessageId` stays null), `counts.queued` is `0`, the campaign
itself reaches `COMPLETED` on the next read, and a real
`AUTOMATION_FAILURE` notification row exists. Full suite: 78/78 files,
475/475 tests passing (up from 474 - the expected +1), zero regressions.
Typecheck and production build both clean; migration 054 applied cleanly
against a real database.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Rollback:** `git revert` the commit, or discard the branch. Migration
054 only adds a nullable column - reversible via a plain `DROP COLUMN`.

---

## 2026-08-21 - Phase 16: funnel deletion lifecycle hardening

**Branch:** `phase-2-ai-repair` (continues on the same branch as Phases 2-3
- see the Phase 3 entry below for why this branch wasn't split further)

**Audit finding:** `deleteFunnel()` in `src/services/funnelService.ts`
called `funnelRepository.remove(funnelId)` unconditionally. `funnel_steps`
and `funnel_instances` both `REFERENCES funnel_definitions(id) ON DELETE
CASCADE` (migration 040), so deleting an active funnel silently destroyed
every running/waiting instance's history, including customers genuinely
mid-funnel (e.g. WAITING on a scheduled message for tomorrow, with a real
BullMQ delayed job already enqueued for it). That customer would simply
never receive the rest of the funnel, with **no notification to the
business and no audit trail of what happened** - the same silent-gap
failure class already fixed for `no_agent`/blocked-keyword/AI-failure
outcomes in earlier phases, just not yet closed here. The pending BullMQ
job itself doesn't crash (`resumeFunnelInstance`'s existing `if (!instance
...) return` guard degrades gracefully when `findInstanceById` returns
null post-cascade), but the silent data loss and abandoned customer are
real.

**Fixed:** `deleteFunnel()` now checks `getInstanceCounts()` first and
refuses to delete (`FunnelHasActiveInstancesError`, mapped to HTTP 409
`FUNNEL_HAS_ACTIVE_INSTANCES`) while any instance is still `ACTIVE` or
`WAITING` - the operator must cancel them first via the already-existing
`cancelFunnelInstance()`, a deliberate, visible action instead of a silent
cascade. A successful deletion now also writes a `funnel_deleted` audit
event via the existing `SecurityAuditLogRepository`, matching the sibling
`funnel_created`/`funnel_activated`/`funnel_deactivated`/`funnel_enrolled`
events that already existed for every other funnel lifecycle transition
except this one. Migration 053 extends `security_audit_logs`'
`event_type` CHECK constraint for the new value, following the same
drop-and-re-add-with-full-value-list convention as migrations
041/042/044/045/047/052.

**Scope decision:** deactivation (`setFunnelActive(..., false)`) was left
unchanged - it already correctly blocks *new* enrollments
(`enrollContact` throws `InvalidFunnelStepError` when `!funnel.isActive`)
while letting already-running instances finish naturally, which is
intentional, documented behavior, not a gap. Only deletion (permanent,
irreversible) needed a safety rail.

**Tests:** 2 new in `test/funnelService.test.ts` - one proving deletion is
refused with an active/waiting instance present (and that the funnel and
instance are both still there afterward, nothing silently dropped), one
proving deletion succeeds once the instance is cancelled and writes the
real `funnel_deleted` audit row. Full suite: 78/78 files, 474/474 tests
passing (up from 472 - the exact expected +2), zero regressions.
Typecheck and production build both clean; migration 053 applied cleanly
against a real database.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Rollback:** `git revert` the commit, or discard the branch. Migration
053 is reversible via the same drop/re-add pattern with `'funnel_deleted'`
removed from the list.

---

## 2026-08-21 - Phase 3: centralized AI orchestration + zero-trust tool policy

**Branch:** `phase-2-ai-repair` (continues directly from the Phase 2 commit
on this same branch - no separate Phase 3 branch was cut, since this phase
touches the same AI call path Phase 2 just repaired and splitting it would
have meant re-basing one on top of the other for no real isolation benefit)

**Changed:** `src/services/aiReplyService.ts` (the `get_current_time` tool
call now runs through a real permission guard before executing, see
below), `src/services/aiContextGathererService.ts` (`AiHandoffContext`
widened with `businessId`/`chatId`, echoed through so downstream consumers
are self-contained), `src/repositories/securityAuditLogRepository.ts`
(added `'ai_tool_invoked'` to the audit event-type union),
`src/queue/workers/incomingMessagesWorker.ts` (its ~130-line inline
sequence of `gatherAiHandoffContext` -> `routeInboundMessage` ->
`generateAiReply` -> one-hop escalation is now a single call to
`orchestrateAiReply()`; every side effect - notifications, `ai_mode`
transitions, realtime events, the idempotent outbound send - is
unchanged, byte-for-byte the same behavior, just no longer duplicated
inline in the worker).

**Added:**
- `src/services/ai/aiToolPolicy.ts` - a real permission registry
  (`AiToolRisk`: READ/WRITE/SEND/HIGH_RISK/SYSTEM) for every AI-invocable
  tool. Currently contains exactly one entry: `get_current_time: READ`.
  This is the directive's zero-trust tool model made real, not aspirational
  - proportionate to what the codebase actually has today (one tool), not
  scaffolded for tools that don't exist yet.
- `src/services/ai/agentGuard.ts` - `guardToolInvocation()`, a fail-closed
  guard called before any tool executes. An unregistered tool name throws
  `UnregisteredToolError` immediately, before any database access. A
  registered tool's invocation is logged as a real, non-blocking audit
  event (`ai_tool_invoked`) via the existing `SecurityAuditLogRepository` -
  reusing that table rather than building new telemetry infrastructure.
  The audit write is `.catch()`-guarded so a logging failure can never
  block a tool call or crash the worker.
- Migration `052_ai_tool_audit_events.sql` - extends the
  `security_audit_logs_event_type_check` constraint to allow
  `'ai_tool_invoked'`, following this codebase's established
  drop-and-re-add-with-full-value-list convention (same pattern as
  migrations 041/042/044/045/047).
- `src/services/ai/aiOrchestrator.ts` - `orchestrateAiReply()`, the single
  entry point that now owns "which agent, given what context, says what."
  It deliberately does *not* own side effects (notifications, `ai_mode`
  transitions, the outbound send) - those stay in the calling worker,
  since they are queue/dispatch concerns, not AI orchestration ones. Same
  routing/escalation/context logic as before this phase - a
  consolidation, not a rewrite.

**What was deliberately NOT built:** no rename of
`aiContextGathererService.ts`/`aiReplyService.ts`/`geminiClient.ts` to the
directive's suggested `agentContext.ts`/`aiModelGateway.ts` names - they
already serve those roles, are tested, and are imported elsewhere; a mass
rename for naming-convention purity alone would violate "preserve what
works" for no functional benefit. No `aiMemory.ts` (no demonstrated
need). No new telemetry service - the existing `security_audit_logs`
table already fits this exactly.

**Tests:** `test/agentGuard.test.ts` (new, 3 tests, real Postgres writes
via `createTestBusiness()`/`resetDatabase()` - not mocked - proving the
unregistered-tool fail-closed path writes zero audit rows, a registered
tool's invocation writes exactly one real `ai_tool_invoked` row with no
phone-number-shaped value anywhere in its metadata, and the policy
registry's exact current content). Existing `AiHandoffContext` fixtures in
`test/aiReplyService.test.ts` and `test/aiReplyServiceRetry.test.ts`
updated for the widened type. Full suite: 78/78 files, 472/472 tests
passing (up from 77/469 - the expected +1 file/+3 tests), zero
regressions. Typecheck clean, production build clean, migration 052
applies cleanly against a real database with no other migrations pending.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Risks:** none identified beyond what Phase 2 already carried forward -
this phase changes call structure, not call behavior, and the full
regression suite confirms behavior is unchanged.

**Rollback:** `git revert` the commit(s), or discard the branch. The only
schema change is the additive `CHECK` constraint extension in migration
052, which is itself reversible via the same drop/re-add pattern with
`'ai_tool_invoked'` removed from the list.

---

## 2026-08-21 - Phase 2: existing AI path audit + one real repair (circuit breaker)

**Branch:** `phase-2-ai-repair` (base: `phase-1-container-security` @ `0467bf1`)

**Audit findings:** traced the real inbound -> Sentinel -> persistence ->
queue -> worker -> AI routing -> context -> model -> outbound path
(`src/queue/workers/incomingMessagesWorker.ts`,
`src/services/agentRoutingService.ts`, `src/services/aiReplyService.ts`).
The major failure modes this directive's Phase 2 asks about were already
fixed in earlier work this session, confirmed still in place: `no_agent`
and blocked-keyword routing outcomes visibly notify the business and move
the chat to `HUMAN_TAKEOVER` rather than silently dropping the customer;
a failed model call (Gemini + Goose both unavailable) does the same via
an `AI_FAILURE` notification; the escalation hop is bounded to exactly
one agent, never a loop; outbound sends carry an idempotency key derived
from the inbound message id; human takeover (`ai_mode !== 'AI_ACTIVE'`)
gates the AI path out entirely before it runs.

**One real, remaining gap found and fixed:** no circuit breaker existed
for the Gemini call (directive Section 45 - external services must have
timeout/backoff/circuit breaker/cooldown). During a sustained outage,
every single queued message would wait out a full network round trip
(primary call, then a bare-request retry) before falling back - wasted
latency per message with no benefit, since a failing provider was very
unlikely to suddenly succeed message-to-message. Added
`src/services/aiCircuitBreaker.ts`: a minimal per-process (not Redis-
shared - deliberately, see the file's own comment) CLOSED/OPEN/HALF_OPEN
breaker. After 3 consecutive real call failures it opens for 60s
(both configurable via `GEMINI_CIRCUIT_FAILURE_THRESHOLD`/
`GEMINI_CIRCUIT_COOLDOWN_MS`), skipping straight to Goose/`unavailable`
until a single probe call is allowed through again. A 400-then-bare-retry
recovery still counts as success (proves Gemini is reachable), so it does
not falsely trip the breaker.

**Tests:** 11 new (`test/aiCircuitBreaker.test.ts` - pure state-machine
tests for CLOSED->OPEN->HALF_OPEN->CLOSED transitions, cooldown timing,
failed-probe reopening; 3 new integration tests in
`test/aiReplyServiceRetry.test.ts` proving `generateAiReply` actually
skips the live call once open, stays closed under normal success, and
does not trip on a recovered 400). Full suite: 77/77 files, 469/469 tests
passing (up from 76/458 - the exact expected +1 file/+11 tests), zero
regressions. Typecheck and production build both clean.

**Status:** `IMPLEMENTED AND VERIFIED`.

**Rollback:** `git revert` the commit, or discard the branch - no schema
or dependency changes.

---

## 2026-08-21 - Phase 1: real container boot verification, four bugs found and fixed

**Branch:** `phase-1-container-security` (continues from `668760b`)

**Changed:** `Dockerfile` (added a `COPY` for migration `.sql` files into
the runtime image), `docker-compose.yml` (removed `cap_drop: [ALL]` from
`redis`; replaced the `app-worker` healthcheck's `pgrep`-based command
with a `node -e "process.kill(1, 0)"` PID-1 liveness check), `docs/DOCKER.md`
and this changelog updated to reflect real verification results.

**How this was verified:** this sandboxed session cannot pull Docker Hub
images (policy-blocked egress, see the prior entry below) - a
collaborator built and booted the real stack on their own machine
(Windows 11 + WSL2 + Docker Desktop) and reported back raw command
output, which was cross-checked for internal consistency before being
trusted (e.g. the exact Vite bundle sizes matched this session's own
non-Docker build byte-for-byte; the specific error messages reported -
`setpriv: setresuid failed`, `pgrep` exit 127 on `node:22-slim` - were
independently confirmed against known, verifiable facts about those
tools before the corresponding fixes were applied here).

**Four real bugs found and fixed** (see `docs/DOCKER.md`, "Real bugs...",
for full detail): a `WHATSAPP_SESSION_DIR` volume mismatch (already fixed
in the prior entry via static `docker compose config` review),
`.sql` migration files missing from the compiled runtime image (`tsc`
never copies non-TS assets), Redis failing to boot under `cap_drop:
[ALL]`, and the worker healthcheck using a binary (`pgrep`) that isn't
present in `node:22-slim`.

**Status:** `IMPLEMENTED AND VERIFIED`. All nine verification items from
the original checklist passed against a real boot: image builds cleanly,
all four services report `healthy`, migrations apply (51/51), non-root
execution confirmed (`uid=10001`), resource limits confirmed via
`docker inspect` (512 MiB / 1.0 CPU / 256 pids, matching config exactly),
no `EROFS` errors under `read_only`, `/api/health` returns 200 with the
expected security headers, the worker genuinely starts consuming its real
queues, and a real Baileys WhatsApp connection succeeded inside the
container. A follow-up confirmation pass then closed the last gap:
`git pull` fast-forwarded `668760b..26f1eab` (the exact commit range
pushed here) on the collaborator's machine, followed by
`docker compose down && docker compose build && docker compose up -d`
against the actual tracked files - not the earlier locally-patched
equivalent - and all four services came up `healthy` again. This is
unconditionally verified, not pending anything further.

**Rollback:** Same as the prior entry - no application code, schema, or
`package.json`/lockfile touched.

---

## 2026-08-21 - Phase 1: container security baseline

**Branch:** `phase-1-container-security` (base: `audit/phase-0-safety-baseline`
@ `ac09e6b`)

**Changed:** Added `Dockerfile`, `docker-compose.yml`, `.dockerignore`,
`docs/DOCKER.md`. Zero application code, schema, or dependency changes.

**Added:** Two-service app image (app-server, app-worker, same image,
different command - see `docs/DOCKER.md` for the verified process/volume
boundary), `postgres:16-alpine`, `redis:7-alpine`, an explicit bridge
network, four named volumes (`postgres-data`, `redis-data`,
`whatsapp-session`, `media-storage`).

**Security controls added:** non-root execution (fixed uid/gid 10001) for
both app containers, `cap_drop: [ALL]` + `no-new-privileges` on
app-server/app-worker/redis (deliberately not on postgres - see
`docs/DOCKER.md`), `read_only` root filesystem + scoped `tmpfs` on the app
containers, per-service pids/memory/cpu limits, no host port exposure for
postgres/redis, no Docker socket mount anywhere, healthchecks gating
startup order (`depends_on: condition: service_healthy`).

**Real finding caught during this phase's own verification (not a build-
time hypothetical):** `docker compose config` surfaced that
`WHATSAPP_SESSION_DIR` was silently inheriting a host-relative path from
the developer's own `.env` via `env_file`, which inside a container would
have resolved outside the mounted volume - would have silently discarded
the WhatsApp session on every container recreation. Fixed by pinning it
explicitly in `docker-compose.yml`'s `environment:` block. See
`docs/DOCKER.md` for detail.

**Status:** `IMPLEMENTED BUT NOT FULLY VERIFIED`. `docker compose config`
validation passed and caught a real defect (above). Image build and
container boot could **not** be completed in this environment: every
`docker build`/`docker pull node:22-slim` attempt was rejected by this
session's own egress policy (`production.cloudfront.docker.com` CONNECT
denied - confirmed via the proxy's own status endpoint, not assumed). Per
that policy's explicit instruction, this was reported rather than routed
around via an alternate registry mirror. See `docs/DOCKER.md`, "What was
verified vs. not," for the complete, itemized list of what still needs
confirming in an environment with open registry access before this is
trusted in production - most notably whether `postgres` actually starts
with the rest of its hardening applied, and whether `read_only: true`
breaks anything at runtime.

**Rollback:** Branch can be discarded entirely; no application code,
schema, or `package.json`/lockfile was touched, so there is nothing to
revert outside this branch's own four new files.

---

Security-relevant changes only (not a general changelog - see `docs/` and
git history for full feature history). Each entry states what changed, why,
and its verification status per the directive's terminology:
`IMPLEMENTED AND VERIFIED` / `IMPLEMENTED BUT NOT FULLY VERIFIED` /
`SCAFFOLDED ONLY`.

---

## 2026-08-21 - Phase 0 safety baseline (this audit)

**Branch:** `audit/phase-0-safety-baseline`

**Changed:** Nothing in application code, dependencies, database schema, or
runtime configuration. Added five documentation files:
`CURRENT_STATE.md`, `ARCHITECTURE_BASELINE.md`, `SECURITY_BASELINE.md`,
`CHANGELOG_SECURITY.md` (this file), `ROLLBACK_PLAN.md`.

**Status:** `IMPLEMENTED AND VERIFIED` (as documentation - every claim in
these five files was checked against the actual repository during this
pass; see each file's own content for what was and wasn't verifiable).

**Rollback:** Delete the branch, or `git revert` the single commit. No
application state is affected either way.

---

## 2026-08-21 - Live time and timezone intelligence: AI tool surface
   (predates this changelog's creation - backfilled for completeness)

**Branch:** `feature/live-time-intelligence` (separate from this audit
branch; already pushed and independently verified)

**Changed:** Added the first-ever AI-invocable tool (`get_current_time`) to
the Gemini reply path. Security-relevant properties of this change:

- The tool is **read-only** - it has no corresponding write/set capability
  anywhere in the codebase, so no prompt-injection attempt against it can
  have a lasting effect beyond the current reply.
- The tool takes **no arguments** (empty parameter schema), so there is no
  input surface for the model to pass attacker-influenced data into it.
- Tool execution is **bounded to exactly one round trip** per reply -
  verified by a test (`test/aiReplyServiceRetry.test.ts`, "never lets a
  get_current_time tool call loop more than one extra round trip") that
  mocks a model response which keeps re-requesting the tool forever and
  confirms only one extra API call is ever made.
- A dedicated test (`test/aiReplyServiceRetry.test.ts`, "ignores
  attacker-controlled tool-call args entirely") proves that even if a
  compromised/manipulated model response includes forged
  `args` (e.g. a fake `utcNow`/`timezone`), the function-response sent back
  to the model is always the trusted, server-computed `TimeContext` - the
  forged values are never used.
- A manual time-override capability was added at the *business* level
  (`businesses.time_source`, `manual_override_target_utc`,
  `manual_override_set_at`), settable only via an authenticated,
  permission-gated (`settings.manage`) HTTP endpoint - **no AI tool can
  write these columns**, so no WhatsApp message, however crafted, can
  change what time the AI believes it is.

**Status:** `IMPLEMENTED AND VERIFIED` - 46 new tests added (see that
branch's own final report), full regression suite (76/76 files, 458/458
tests) passing with zero regressions against a corrected baseline.

**Rollback:** That branch has not been merged to any protected branch; it
can be discarded entirely (`git push origin --delete
feature/live-time-intelligence` after confirming no PR depends on it) with
zero effect on `phase-1-foundation`/the real base branch.
