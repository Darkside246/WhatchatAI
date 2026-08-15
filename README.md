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

Phase 1 (foundation) and Phase 2A (real QR/Baileys connection) are implemented. Phase 2B (real inbound WhatsApp message ingestion) is now implemented: the connection service forwards every `messages.upsert` event to a dedicated ingestion service that classifies content type, preserves the original JID (including `@lid`), and distinguishes live from historical messages. Ingested messages are held in an in-memory buffer pending the Phase 3 persistence layer.
