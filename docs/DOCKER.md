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
| Non-root user | Fixed uid/gid 10001, `USER` in the image + explicit `user:` in compose | Vendor default (`postgres` user, after root-owned init step) | Vendor default (`redis` user, after root-owned init step) |
| `cap_drop: [ALL]` | Yes | **No - see below** | **No - see below** |
| `security_opt: no-new-privileges:true` | Yes | Yes | Yes |
| `read_only` root filesystem + `tmpfs:/tmp` | Yes | No (vendor image needs its data dir writable, handled via the named volume) | No (vendor image writes AOF files to its data dir, handled via the named volume) |
| `pids_limit` / `mem_limit` / `cpus` | 256 / 512m / 1.0 | 256 / 512m / 1.0 | 128 / 256m / 0.5 |
| Host port exposure | Only `app-server`, port 3000 | None | None |
| Healthcheck | `/api/health` (server), Node PID-1-liveness (worker - see caveat below) | `pg_isready` | `redis-cli ping` |
| Secrets | via `env_file: .env` (gitignored, existing repo convention) - **not** Docker/Swarm/K8s secrets; see Known gaps | same | n/a |

**Why `postgres` and `redis` do NOT get `cap_drop: [ALL]`:** both official
images' entrypoints run as root on first boot to take ownership of their
data directory (via `chown`, under Postgres's own script) or to drop
privileges via `setpriv`/`gosu` (Redis) before running as their own
unprivileged user - both need `CHOWN`/`DAC_OVERRIDE`/`SETUID`/`SETGID` for
that one-time step. **The Redis exception is now empirically confirmed**:
a real container boot during Phase 1 verification hit
`setpriv: setresuid failed: Operation not permitted` with `cap_drop:
[ALL]` applied, and removing it fixed the boot cleanly - this is a
verified result, not an assumption. **The Postgres exception is still
only a documented-vendor-behaviour assumption** - Postgres has simply
never been run with `cap_drop: [ALL]` applied in this repo's testing to
either confirm or deny it, since that was the design from the start.

**Worker healthcheck caveat:** `app-worker` has no HTTP server, so its
healthcheck only proves the Node process (PID 1 in that container, since
its command has no shell wrapper) is still running. It says nothing about
whether jobs are actually being processed successfully. Do not read it as
equivalent to `app-server`'s `/api/health` (itself only a liveness check -
see the comment in the Dockerfile: real readiness for dependencies is
`/api/health/database` and `/api/health/whatsapp`, which are not what any
container healthcheck uses here). The healthcheck command itself changed
during Phase 1 verification - see below.

## Real bugs this phase's own review, and a real container boot, caught

Four real defects were found and fixed during Phase 1 - three of them only
findable by actually booting a container, which this sandbox could not do
(see below); a collaborator ran the real build/boot on their own machine
(Windows + WSL2 + Docker Desktop) and reported them back with exact error
text, independently cross-checked against known, verifiable facts about
these tools before being trusted:

1. **`WHATSAPP_SESSION_DIR` volume mismatch** - found via `docker compose
   config` alone, no container needed. `WHATSAPP_SESSION_DIR` was being
   pulled in from the developer's own `.env` file (`./data/whatsapp-
   session`, a relative host path meant for `npm run dev`) via `env_file`.
   Inside a container that path resolves relative to `/app`, **not** the
   `/app/data/whatsapp` path the `whatsapp-session` named volume is
   actually mounted at - meaning the Baileys session would have been
   written to an ephemeral, unmounted directory and lost on every
   container recreation. Fixed by setting `WHATSAPP_SESSION_DIR: /app/data
   /whatsapp` explicitly in `docker-compose.yml`'s `environment:` block.

2. **Migrations missing from the runtime image** - `tsc` compiles `.ts` ->
   `.js` only; it never copies non-TypeScript assets like `.sql` files.
   `migrate.ts` resolves its migrations directory relative to its own
   compiled location (`dist/db/migrate.js` -> `dist/db/migrations`), which
   never gets populated by the build - confirmed independently by reading
   `src/db/migrate.ts`'s `MIGRATIONS_DIR` resolution before trusting the
   report. Fixed: `COPY --from=build /app/src/db/migrations
   ./dist/db/migrations` added to the Dockerfile's runtime stage.

3. **Redis boot failure under `cap_drop: [ALL]`** -
   `setpriv: setresuid failed: Operation not permitted`. The official
   Redis image's entrypoint needs `SETUID`/`SETGID` to drop from root to
   the `redis` user, the same class of exception already documented for
   Postgres. Fixed by removing `cap_drop: [ALL]` from the `redis` service
   (see the hardening table above).

4. **Worker healthcheck failing with exit 127** - `pgrep -f ...` failed
   because `node:22-slim` doesn't package `procps` (which provides
   `pgrep`) - a real, verifiable characteristic of Debian slim images.
   Fixed by replacing it with `node -e "process.kill(1, 0)"`, which checks
   PID-1 liveness using only Node itself (correct here specifically
   because `app-worker`'s command has no shell wrapper, so the Node
   process really is PID 1 in that container).

Each of these is exactly the class of defect that can only be caught by
actually running the thing, not by static review - which is precisely why
this phase's own verification insisted on real command output rather than
accepting a summary.

## What was verified vs. not, honestly

**Why this session couldn't build/boot it directly:** `docker pull
node:22-slim` and every build attempt in this sandboxed environment failed
identically -

```
ERROR: node:22-slim: failed to resolve source metadata for
docker.io/library/node:22-slim: ... Get "https://production.cloudfront.docker.com/...":
Forbidden
```

- confirmed via the session's own egress-proxy status endpoint to be a
deliberate policy denial (`"connect_rejected"`, `host:
"production.cloudfront.docker.com:443"`), not a transient failure, and per
that proxy's own documented instructions ("do not retry or route around
it - report the blocked host") this was reported rather than bypassed via
an alternate registry mirror.

**IMPLEMENTED AND VERIFIED** (against a real `docker compose build` /
`docker compose up -d` run on a collaborator's machine - Windows 11 + WSL2
+ Docker Desktop, open network, no egress restriction - with the four
bugs above found and fixed in the same pass):

- **Build completes end-to-end**: `npm ci` -> `tsc` -> `vite build`
  inside the image, no errors. Output matched byte-for-byte the same
  Vite bundle sizes (`686.36 kB`, gzip `198.98 kB`) already confirmed by
  this session's own non-Docker `npm run build`.
- **All four services report healthy** in `docker compose ps`: `postgres`,
  `redis`, `app-server`, `app-worker`.
- **Migrations run for real inside the container**: log output showed
  `[migrate] Applied 51 migration(s)` through `051_business_time_override.sql`
  before the server started listening.
- **Non-root execution confirmed**: `docker compose exec app-server id` ->
  `uid=10001(whatchatai) gid=10001(whatchatai) groups=10001(whatchatai)`.
- **Resource limits confirmed applied** via `docker inspect`: `Memory:
  536870912` (512 MiB), `NanoCPUs: 1000000000` (1.0 CPU),
  `PidsLimit: 256` - exactly the configured values, not zero/unset.
- **`read_only` root filesystem does not break anything**: no `EROFS`
  errors in either container's logs - the risk flagged earlier (ffmpeg
  temp files) did not materialize.
- **`/api/health` responds 200** with the expected security headers
  (CSP, HSTS, `X-Frame-Options`, etc. - from the existing `helmet`
  middleware, unmodified by this phase) and the expected JSON body.
- **`app-worker` genuinely boots and starts consuming its real queues**:
  log output showed `[IncomingMessagesWorker] Listening on queue
  "incoming_messages"` and `[RealtimeEventsWorker] Listening on queue
  "realtime_events"`, plus its scheduled sweep jobs starting.
- **Redis's `cap_drop: [ALL]` exception is now empirically confirmed**
  (see "Real bugs" above), not just assumed by analogy to Postgres.
- **A real WhatsApp connection succeeded inside the container**: server
  log showed a genuine Baileys `"connected to WA"` event.
- `docker compose config` schema validation, the `WHATSAPP_SESSION_DIR`
  fix, and the process/volume ownership boundaries - as before, verified
  by direct inspection.

**Still open, honestly:**
- The verification run above was against a version of the Dockerfile/
  compose file that a collaborator had **locally patched** on their own
  machine before reporting back (the four fixes above). Those fixes have
  since been applied to the actual tracked files in this repo and pushed,
  in the same form described, but the *exact* pushed bytes have not yet
  been re-run end-to-end - only the logically-equivalent locally-patched
  version was. A final confirmation pass (`git pull`, then repeat the
  same 9 steps) closes this gap completely; until then this is
  `IMPLEMENTED AND VERIFIED (pending a final confirmation pull)`, not
  unconditionally verified.
- Whether Postgres would survive `cap_drop: [ALL]` remains untested (it
  was never applied there in the first place, so this run doesn't answer
  that question either way - see the hardening table above).
- Full inbound-WhatsApp-message -> AI reply -> outbound-send flow through
  the containers was not exercised in the report (only the connection
  itself was confirmed) - worth a real end-to-end message test as a
  follow-up, not required to call container *infrastructure* verified.

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
