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
