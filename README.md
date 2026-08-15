# WhatchatAI

Production-first multi-tenant AI WhatsApp SaaS.

This repository is being built from the ground up using a phased, page-by-page implementation strategy.

## Production Truth Rules

- No mock production data.
- No fake WhatsApp states, messages, contacts, calls, battery levels, analytics, or integration states.
- Real services and real persisted data only.
- Unsupported capabilities must be shown as unsupported rather than simulated.
- One authoritative AI orchestration path.
- One authoritative outbound WhatsApp dispatcher.
- Original WhatsApp JIDs are preserved exactly as received.
- Historical messages never trigger live AI responses.

## Current phase

Phase 0 / Phase 1 foundation setup is being implemented on a dedicated feature branch before merge to `main`.
