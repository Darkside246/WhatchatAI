# Multi-stage build. node:22-slim (Debian/glibc), not alpine: ffmpeg-static
# ships prebuilt glibc binaries for voice-note processing (a documented
# characteristic of that package, not independently re-verified here), and
# Argon2id password hashing runs through hash-wasm (pure WASM, no native
# compile step either way) - glibc avoids a known musl-compatibility risk
# for no compensating benefit in this app's dependency set.

# ---- deps: full install (prod+dev) for building only, never shipped ----
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY src/web/package.json src/web/package.json
RUN npm ci

# ---- build: compile backend (tsc) and frontend (vite) ----
FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- prod-deps: a second, separate install with dev dependencies
#      omitted - smaller final image, fewer packages in the runtime
#      supply-chain surface than reusing the build stage's node_modules ----
FROM node:22-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY src/web/package.json src/web/package.json
RUN npm ci --omit=dev
# Real, confirmed bug: pdf-parse's hard dependency @napi-rs/canvas ships one
# prebuilt native binary per platform+libc as separate optional packages
# (canvas-linux-x64-gnu vs canvas-linux-x64-musl, etc.) - npm's optional-
# dependency resolution installed the musl (Alpine-style) variant here even
# though node:22-slim is Debian/glibc, leaving @napi-rs/canvas unable to
# load its native binding at runtime and crashing any process that imports
# pdf-parse (document parsing) at startup, before any actual PDF is ever
# parsed - a whole worker process down for one document-parsing dependency.
# Forces the correct variant in directly, --no-save so package-lock.json
# (edited on Windows, where this ambiguity doesn't arise) is untouched.
RUN npm install --no-save @napi-rs/canvas-linux-x64-gnu@0.1.80

# ---- runtime: minimal, non-root, only what the running app needs ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Fixed, non-root uid/gid rather than a distro default - portable across
# hosts and predictable for volume ownership below.
RUN groupadd --gid 10001 whatchatai \
  && useradd --uid 10001 --gid whatchatai --shell /usr/sbin/nologin --no-create-home whatchatai

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# tsc compiles .ts -> .js only; it never copies non-TS assets. migrate.ts
# resolves its migrations directory relative to its OWN compiled location
# (dist/db/migrate.js -> dist/db/migrations), so without this the .sql
# files are simply absent at runtime and migrations fail with ENOENT -
# confirmed by a real container boot during Phase 1 verification, not
# caught by static review.
COPY --from=build /app/src/db/migrations ./dist/db/migrations

# Persistent state lives under /app/data (WhatsApp session + local encrypted
# media storage) - created here so it has the right ownership before the
# volume is mounted over it; the actual persistence comes from the named
# volumes declared in docker-compose.yml, not from this layer.
RUN mkdir -p /app/data/whatsapp /app/data/media-storage \
  && chown -R whatchatai:whatchatai /app

USER whatchatai

# Liveness only (this endpoint never checks Postgres/Redis/WhatsApp - see
# /api/health/database and /api/health/whatsapp for readiness, which are
# checked separately in docker-compose.yml's own service healthchecks) -
# this HEALTHCHECK exists only to catch a hung/dead Node process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 3000

# No default CMD: docker-compose.yml sets the real command per service
# (API+in-process workers vs. the inbound-message worker process) - this
# image is shared by both, distinguished only by the command it runs.

# ---- goose-runtime: the real Gemini-failover container. Installs the
#      actual Goose CLI at BUILD time (root, writable layer) rather than
#      relying on gooseFallbackSupervisor.ts's own runtime auto-install -
#      that path assumes a writable $HOME to install into, which this
#      app's own read_only: true + non-root convention (see runtime stage
#      above) would otherwise block outright. Installed to /usr/local/bin
#      (world-executable by default) rather than wherever the installer's
#      own default $HOME happens to be, so the non-root runtime user below
#      can actually run it regardless of what user built this layer. ----
FROM node:22-slim AS goose-build
# bzip2 is required to extract the installer's own .tar.bz2 release archive -
# node:22-slim does not include it by default, and its absence fails the
# install step below with a raw "tar: Child returned status 2" rather than
# anything naming the missing package, so it's listed here explicitly.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates bash bzip2 \
  && rm -rf /var/lib/apt/lists/*
# $HOME/.local/bin/goose is not a guess - it's the exact path
# gooseFallbackSupervisor.ts's own findExecutable() already checks first
# after a bare PATH lookup (see that file), confirming this installer's
# real, established behavior in this codebase. Build stage runs as root
# by default, so $HOME is /root here.
RUN curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh -o /tmp/install-goose.sh \
  && chmod +x /tmp/install-goose.sh \
  && CONFIGURE=false /tmp/install-goose.sh \
  && test -x /root/.local/bin/goose \
  && cp /root/.local/bin/goose /usr/local/bin/goose \
  && chmod 755 /usr/local/bin/goose \
  && rm -f /tmp/install-goose.sh \
  && /usr/local/bin/goose --version

FROM node:22-slim AS goose-runtime
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --gid 10001 whatchatai \
  && useradd --uid 10001 --gid whatchatai --shell /usr/sbin/nologin --no-create-home whatchatai

COPY --from=goose-build /usr/local/bin/goose /usr/local/bin/goose
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# GOOSE_AUTO_INSTALL=false (env, not a file change): the binary above is
# already installed and on PATH - installGoose()'s own runtime fallback
# should never run here, since it would try to write to the (read-only)
# filesystem and fail. HOME points at /tmp (tmpfs, see docker-compose.yml)
# since goose serve/run may want to write its own session/cache state
# somewhere; --no-session --no-profile (runGoosePrompt's own real call)
# already avoid needing persistent state for the actual reply path.
RUN mkdir -p /app/data && chown -R whatchatai:whatchatai /app

USER whatchatai

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GOOSE_SERVICE_PORT||3284)+'/health',{headers:{authorization:'Bearer '+(process.env.GOOSE_SERVICE_API_KEY||'')}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/services/gooseFallbackSupervisor.js"]

# ---- relay-runtime: the per-cell network policy enforcement boundary -
#      built separately, deliberately as small as possible. src/relay/**
#      imports nothing but Node built-ins (node:http/https/dns/url/net),
#      so unlike the runtime stage above this needs no node_modules at
#      all - not a leftover omission, the actual point: the smaller this
#      image's dependency footprint, the smaller its own supply-chain
#      surface, which matters more here than for the main app given what
#      this component is trusted to enforce. Built and tagged locally
#      (`docker build --target relay-runtime -t whatchatai-openclaw-relay:local .`)
#      - see dockerCellRuntime.ts's RELAY_IMAGE constant. ----
FROM node:22-slim AS relay-runtime
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --gid 10001 whatchatai \
  && useradd --uid 10001 --gid whatchatai --shell /usr/sbin/nologin --no-create-home whatchatai

COPY --from=build /app/dist/relay ./dist/relay
USER whatchatai

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/relay/index.js"]
