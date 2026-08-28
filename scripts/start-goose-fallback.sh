#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Backward-compatible manual entry point. The real lifecycle manager now
# lives in src/services/gooseFallbackSupervisor.ts and is also started
# automatically by npm run dev / npm start.
exec npm run dev:goose
