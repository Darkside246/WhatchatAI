#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if ! command -v goose >/dev/null 2>&1; then
  echo "Goose is not on PATH. Run: export PATH=\"$HOME/.local/bin:$PATH\"" >&2
  exit 1
fi

HOST="${GOOSE_SERVICE_HOST:-127.0.0.1}"
PORT="${GOOSE_SERVICE_PORT:-3284}"
UPSTREAM_PORT="${GOOSE_UPSTREAM_PORT:-3285}"

if [[ "$HOST" != "127.0.0.1" && "$HOST" != "localhost" ]]; then
  echo "Refusing to expose the customer-facing Goose fallback beyond localhost." >&2
  echo "Set GOOSE_SERVICE_HOST=127.0.0.1 (the default)." >&2
  exit 1
fi

GOOSE_SERVICE_URL="${GOOSE_SERVICE_URL:-http://127.0.0.1:$PORT}"
if grep -q '^GOOSE_SERVICE_URL=' .env; then
  sed -i "s|^GOOSE_SERVICE_URL=.*|GOOSE_SERVICE_URL=$GOOSE_SERVICE_URL|" .env
else
  printf '\nGOOSE_SERVICE_URL=%s\n' "$GOOSE_SERVICE_URL" >> .env
fi
export GOOSE_SERVICE_URL

if [[ -z "${GOOSE_SERVICE_API_KEY:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    GOOSE_SERVICE_API_KEY="$(openssl rand -hex 32)"
  else
    GOOSE_SERVICE_API_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  fi
  if grep -q '^GOOSE_SERVICE_API_KEY=' .env; then
    sed -i "s/^GOOSE_SERVICE_API_KEY=.*/GOOSE_SERVICE_API_KEY=$GOOSE_SERVICE_API_KEY/" .env
  else
    printf 'GOOSE_SERVICE_API_KEY=%s\n' "$GOOSE_SERVICE_API_KEY" >> .env
  fi
  echo "Generated a local Goose service key and stored it in .env."
fi

export GOOSE_SERVER__SECRET_KEY="$GOOSE_SERVICE_API_KEY"
export GOOSE_MODE=chat
export SECURITY_PROMPT_ENABLED=true
export GOOSE_MAX_TURNS=4
export GOOSE_UPSTREAM_URL="http://127.0.0.1:$UPSTREAM_PORT"
export GOOSE_PROXY_HOST="$HOST"
export GOOSE_PROXY_PORT="$PORT"

cleanup() {
  if [[ -n "${GOOSE_PID:-}" ]]; then kill "$GOOSE_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

echo "Starting Goose engine on http://127.0.0.1:$UPSTREAM_PORT"
goose serve --host 127.0.0.1 --port "$UPSTREAM_PORT" &
GOOSE_PID=$!

sleep 1

echo "Starting WhatchatAI Goose failover adapter on http://$HOST:$PORT"
echo "Adapter contract: GET /health and POST /generate"
echo "Goose mode: chat (no customer-facing tools/extensions)"
exec npx tsx scripts/goose-fallback-proxy.ts
