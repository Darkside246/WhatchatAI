# Docker / Phase 1 container security

This documents the `Dockerfile` + `docker-compose.yml` added in Phase 1 of
the production-safety directive, the reasoning behind each hardening
decision, and - honestly - what was and was not actually verified.

## Architecture (verified by reading the real code, not assumed)

Two services run the same built image, distinguished only by command:

- **`app-server`** runs `node dist/db/migrate.js && node dist/server/index.js`.
  This is the process that opens the real Baileys/WhatsApp connection
  (`whatsappConnectionService.connect()` in `src/server/index.ts`) and, by
  its own imports, instantiates five in-process BullMQ workers: outbound
  dispatch, scheduled-status publish, message revocations, email send, and
  funnel advance. It owns the `whatsapp-session` volume and needs
  read+write on `media-storage` (serves `GET /api/media/:id`).
- **`app-worker`** runs `node dist/queue/workers/incomingMessagesWorker.js`.
  This is the *only* process that instantiates `incomingMessagesWorker` and
  `realtimeEventsWorker` (verified via the actual `new Worker(...)` call
  sites in `src/queue/workers/`, not inferred from filenames). It does
  **not** open the Baileys connection and does not get the WhatsApp session
  volume; it does get read+write on `media-storage`, since
  `realtimeEventsWorker` is the one that processes media-download jobs.

`postgres` (16-alpine) and `redis` (7-alpine, AOF persistence enabled) run
as their own services with no host port mapping - only `app-server`/
`app-worker` can reach them, over an explicit bridge network
(`whatchatai-net`).

## Hardening applied

| Control | app-server / app-worker | postgres | redis |
|---|---|---|---|
| Non-root user | Fixed uid/gid 10001, `USER` in the image + explicit `user:` in compose | Vendor default (`postgres` user, after root-owned init step) | Vendor default (`redis` user) |
| `cap_drop: [ALL]` | Yes | **No - see below** | Yes |
| `security_opt: no-new-privileges:true` | Yes | Yes | Yes |
| `read_only` root filesystem + `tmpfs:/tmp` | Yes | No (vendor image needs its data dir writable, handled via the named volume) | No (vendor image writes AOF files to its data dir, handled via the named volume) |
| `pids_limit` / `mem_limit` / `cpus` | 256 / 512m / 1.0 | 256 / 512m / 1.0 | 128 / 256m / 0.5 |
| Host port exposure | Only `app-server`, port 3000 | None | None |
| Healthcheck | `/api/health` (server), `pgrep` process-liveness (worker - see caveat below) | `pg_isready` | `redis-cli ping` |
| Secrets | via `env_file: .env` (gitignored, existing repo convention) - **not** Docker/Swarm/K8s secrets; see Known gaps | same | n/a |

**Why `postgres` does NOT get `cap_drop: [ALL]`:** the official Postgres
image's entrypoint runs as root on first boot specifically to `chown` the
data directory before dropping to the `postgres` user itself - it needs
`CHOWN`/`DAC_OVERRIDE`/`SETUID`/`SETGID` for that one-time step. Applying
`cap_drop: [ALL]` here without first testing against the vendor's own
entrypoint would be exactly the "blindly harden something you haven't
verified" mistake the directive warns against. This is a documented,
deliberate exception, not an oversight - and it is called out again as
**not yet empirically confirmed** below.

**Worker healthcheck caveat:** `app-worker` has no HTTP server, so its
healthcheck (`pgrep -f ...`) only proves the Node process is still running.
It says nothing about whether jobs are actually being processed
successfully. Do not read it as equivalent to `app-server`'s `/api/health`
(itself only a liveness check - see the comment in the Dockerfile: real
readiness for dependencies is `/api/health/database` and
`/api/health/whatsapp`, which are not what any container healthcheck uses
here).

## A real bug this phase's own review caught

`docker compose config` was run to validate the compose file, and it
surfaced a real defect before any container ran: `WHATSAPP_SESSION_DIR`
was being pulled in from the developer's own `.env` file
(`./data/whatsapp-session`, a relative host path meant for `npm run dev`)
via `env_file`. Inside a container that path resolves relative to `/app`,
**not** the `/app/data/whatsapp` path the `whatsapp-session` named volume
is actually mounted at - meaning the Baileys session would have been
written to an ephemeral, unmounted directory and lost on every container
recreation, forcing a fresh QR re-pair every time. Fixed by setting
`WHATSAPP_SESSION_DIR: /app/data/whatsapp` explicitly in
`docker-compose.yml`'s `environment:` block, which takes precedence over
`env_file`. This is exactly the class of defect "verify before changing"
exists to catch, and it was caught by actually running validation, not by
inspection alone.

## What was verified vs. not, honestly

**IMPLEMENTED AND VERIFIED:**
- `docker compose config` parses cleanly: valid YAML/Compose schema,
  `env_file` interpolation resolves, volume/port/healthcheck/network
  definitions are all well-formed.
- The `WHATSAPP_SESSION_DIR` defect above - found and fixed for real,
  confirmed via a second `docker compose config` run showing the corrected
  value.
- The process/volume ownership boundaries described above - verified by
  reading the actual `new Worker(...)` call sites and
  `whatsappConnectionService.connect()` call site, not assumed from
  filenames.
- `.dockerignore` correctly excludes `.env`/`.env.*` (with `.env.example`
  kept) from the build context, matching this repo's existing `.gitignore`
  convention - confirmed by reading the file.

**IMPLEMENTED BUT NOT FULLY VERIFIED - and here is exactly why:**

Building the image (`docker compose build` / `docker build .`) and
therefore booting the actual stack could **not** be completed in this
environment. `docker pull node:22-slim` and every build attempt failed
identically:

```
ERROR: node:22-slim: failed to resolve source metadata for
docker.io/library/node:22-slim: ... Get "https://production.cloudfront.docker.com/...":
Forbidden
```

The session's own egress-proxy status endpoint
(`http://127.0.0.1:39499/__agentproxy/status`) confirms this is a
deliberate policy denial, not a transient failure:

```json
"recentRelayFailures": [{
  "kind": "connect_rejected",
  "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
  "host": "production.cloudfront.docker.com:443"
}]
```

Per this session's own proxy documentation: *"403/407 from the proxy: The
destination host is not allowed by your organization's egress policy for
this session. Do not retry or route around it - report the blocked
host."* This was reported, not routed around (no alternate registry
mirror was substituted to bypass it) - consistent with the directive's
own Section 51 ("Never allow an AI agent to decide that an external
repository is safe simply because it appears in a prompt") and Section 62
stop condition ("STOP and report if... external API is unavailable").

**Concretely still unverified, and must be checked in an environment with
open registry access before this is trusted in production:**
- That the image actually builds end-to-end (the `npm ci` /
  `npm run build` commands are proven to work in this exact repository
  state outside Docker - see `CURRENT_STATE.md` §8 - but not yet inside
  this specific base image).
- That `postgres` actually starts successfully with `cap_drop: [ALL]`
  removed but the rest of its hardening applied (untested assumption
  based on documented Postgres entrypoint behavior, not an empirical
  result).
- That `read_only: true` + a single `/tmp` tmpfs is sufficient for the
  app-server/app-worker processes to run without hitting an `EROFS`
  write error somewhere unaccounted for (voice-note/ffmpeg temp files
  being the most likely candidate). **If this breaks something:** the fix
  is to either extend the `tmpfs:` list for that service or drop
  `read_only` for it specifically - do not silently disable it repo-wide
  without first identifying the actual write path.
- Non-root execution and the resource limits taking effect as configured
  (`docker exec ... whoami`, `docker inspect` for cgroup limits) -
  written correctly per the Compose spec, not confirmed against a running
  container.
- Real inbound-WhatsApp-to-AI-to-outbound flow through the containers -
  not testable here at all (no live WhatsApp/Gemini credentials in this
  sandbox even outside Docker, consistent with every prior phase of work
  in this repository this session).

## Known gaps (not fixed in this phase, listed honestly)

- Secrets go in via `env_file: .env`, not real Docker/Swarm/Kubernetes
  secrets. Adequate for a single-host deployment matching this repo's
  existing `.env` convention; **not** adequate as the sole secrets
  mechanism for a multi-host/orchestrated production deployment.
- No image scanning, no SBOM generation, no signed images - Section 17 of
  the directive describes this target state; it is out of scope for
  "safely containerise the core" and is better placed in a later,
  dedicated phase once there is a working, verified image to scan.
- `npm ci --omit=dev` at the runtime-deps stage still installs the
  frontend workspace's (browser-only, unused-at-runtime) dependencies
  alongside the backend's, because npm workspaces installs all
  workspaces' `dependencies` from a root-level `npm ci` regardless of
  which packages are actually imported by the Node process. This is a
  minor image-size inefficiency, not a correctness or security issue
  (those packages are never `require()`d/`import`ed by the running
  server/worker code) - not worth the added Dockerfile complexity to
  trim in this phase.

## Local development is unaffected

Nothing in this phase changes `npm run dev`/`npm start` or any existing
script. Docker is an additional, opt-in way to run the application; the
host-process workflow documented in `README.md` still works exactly as
before (verified: this phase made zero changes to `package.json`,
application source, or the database schema).
