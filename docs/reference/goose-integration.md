# Goose integration

Status: implemented on `build/property-operations-os`.

## Architecture

WhatchatAI remains **Gemini-first**. Goose is a failover provider only after a genuine Gemini failure:

```text
WhatsApp -> WhatchatAI -> Gemini
                         |
                         | genuine failure
                         v
                Goose failover adapter
                         |
                         v
                    Goose /ask
                         |
                         v
                    Goose model provider
```

The dashboard setting is intentionally a small HTTP contract. `src/services/gooseService.ts` calls the configured service at:

```text
GET  <service-url>/health
POST <service-url>/generate
```

The API key is optional. If supplied, WhatchatAI sends it as `Authorization: Bearer <key>`.

## Local fallback adapter

Goose itself does not provide the dashboard's `/health` + `/generate` contract. The local launcher now starts Goose privately on port `3285` and a localhost-only adapter on port `3284`.

The adapter translates:

```text
GET  /health   -> Goose GET /status
POST /generate -> Goose POST /ask
```

The adapter accepts the WhatchatAI system instruction and conversation, converts them into Goose's single prompt format, and returns `{ "text": "..." }`.

## Security model

The customer-facing fallback is not started with `--dangerously-unauthenticated`.

Use:

```bash
npm run goose:fallback
```

The launcher:

1. Generates `GOOSE_SERVICE_API_KEY` if it is missing.
2. Stores the generated secret only in the local, gitignored `.env`.
3. Exports it as Goose's required `GOOSE_SERVER__SECRET_KEY`.
4. Binds both the Goose engine and customer-facing adapter to localhost.
5. Forces `GOOSE_MODE=chat` for the customer-facing Goose process.
6. Enables Goose's security prompt setting.
7. Refuses to expose the customer-facing adapter beyond localhost.

`GOOSE_MODE=chat` is important. Goose's Developer extension can execute shell commands and modify files, which is appropriate for an operator's interactive Goose session but not for untrusted WhatsApp customer input.

Your normal Goose session remains separate and can continue to use the developer extension for your own engineering work.

## Configuration

`.env.example` documents the local defaults:

```env
GOOSE_SERVICE_URL=http://127.0.0.1:3284
GOOSE_SERVICE_API_KEY=
GOOSE_SERVICE_HOST=127.0.0.1
GOOSE_SERVICE_PORT=3284
GOOSE_UPSTREAM_PORT=3285
```

Do not commit the real key. `.env` is already ignored by Git.

Workspace-level Goose settings are persisted by `IntegrationSettingsRepository`. When a workspace has a stored Goose configuration, that configuration is used by the real agent failover path and by the workspace engine-health display.

## Workspace settings and activation

The Settings page saves:

- `isEnabled`
- `serviceUrl`
- optional API key
- last real health-test timestamp/result/error

The service URL must be a valid `http` or `https` URL before the failover can be enabled. The API key is optional, matching the adapter contract.

The engine-status service now reads the workspace's stored configuration rather than relying only on process environment variables. This fixes the previous situation where the Settings page could contain a valid enabled Goose configuration while the Reply Engine strip still reported Goose as not configured.

## Testing

The Goose service tests verify that:

- health checks use `/health`
- a missing API key does not automatically disable the service
- generation uses `/generate`
- the adapter response shape is `{ text }`

A real Settings test should be run from the dashboard after starting the local fallback. A successful test proves the configured service is reachable.

## Important distinction

Goose is an agent framework, not a direct inference API. The fallback intentionally uses only its bounded text-response surface. Its powerful developer/automation capabilities remain reserved for your own operator sessions rather than being exposed to inbound WhatsApp traffic.
