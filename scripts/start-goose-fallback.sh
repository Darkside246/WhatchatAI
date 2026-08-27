#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env first." >&2
  exit 1
fi

# Load local-only settings. .env is gitignored and must never be committed.
set -a
# shellcheck disable=SC1091
source .env
set +a

if ! command -v goose >/dev/null 2>&1; then
  echo "Goose is not on PATH. Run: export PATH=\"$HOME/.local/bin:$PATH\"" >&2
  exit 1
fi

if [[ -z "${GOOSE_SERVICE_API_KEY:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    GOOSE_SERVICE_API_KEY="$(openssl rand -hex 32)"
  else
    GOOSE_SERVICE_API_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  fi

  if grep -q '^GOOSE_SERVICE_API_KEY=' .env; then
    sed -i "s/^GOOSE_SERVICE_API_KEY=.*/GOOSE_SERVICE_API_KEY=$GOOSE_SERVICE_API_KEY/" .env
  else
    printf '\nGOOSE_SERVICE_API_KEY=%s\n' "$GOOSE_SERVICE_API_KEY" >> .env
  fi
  echo "Generated a local Goose server secret and stored it in .env."
fi

# Goose's HTTP server reads this exact variable for bearer authentication.
export GOOSE_SERVER__SECRET_KEY="$GOOSE_SERVICE_API_KEY"

# The customer-facing fallback must be text-only. Chat mode disables Goose
# extensions/tools, preventing WhatsApp content from reaching shell/file/MCP
# capabilities even if the normal interactive Goose profile enables them.
export GOOSE_MODE=chat
export SECURITY_PROMPT_ENABLED=true
export GOOSE_MAX_TURNS=4

HOST="${GOOSE_SERVICE_HOST:-127.0.0.1}"
PORT="${GOOSE_SERVICE_PORT:-3284}"

if [[ "$HOST" != "127.0.0.1" && "$HOST" != "localhost" ]]; then
  echo "Refusing to expose the customer-facing Goose fallback beyond localhost." >&2
  echo "Set GOOSE_SERVICE_HOST=127.0.0.1 (the default)." >&2
  exit 1
fi

echo "Starting authenticated Goose fallback on http://$HOST:$PORT"
echo "Mode: chat (no Goose tools/extensions available to customer messages)"
exec goose serve --host "$HOST" --port "$PORT"
