# Goose integration

Status: implemented on `build/property-operations-os`.

## Architecture

WhatchatAI remains **Gemini-first**. Goose is a failover provider only after a genuine Gemini failure:

```text
WhatsApp -> WhatchatAI -> Gemini
                         |
                         | genuine failure
                         v
                    Goose /ask
                         |
                         v
                    OpenRouter
                         |
                         v
              Claude Sonnet 4.5
```

The WhatchatAI integration is deliberately small. `src/services/gooseService.ts` talks to Goose's real HTTP server contract instead of inventing a `/generate` endpoint:

```text
GET  http://127.0.0.1:3284/status
POST http://127.0.0.1:3284/ask
```

Both requests use `Authorization: Bearer <GOOSE_SERVICE_API_KEY>`.

## Why `/ask` instead of `/acp`

Goose exposes an ACP interface for editor/agent clients, but the Goose server also exposes a simple authenticated `/ask` route that accepts a single prompt and returns a response. WhatchatAI only needs one bounded text fallback, so `/ask` avoids adding a second ACP client implementation and keeps the integration isolated in one service.

The current `/ask` API accepts:

```json
{
  "prompt": "...",
  "session_working_dir": "/path"
}
```

and returns:

```json
{
  "response": "..."
}
```

## Security model

The customer-facing fallback is **not** started with `--dangerously-unauthenticated`.

Use:

```bash
npm run goose:fallback
```

The launcher:

1. Generates `GOOSE_SERVICE_API_KEY` if it is missing.
2. Stores the generated secret only in the local, gitignored `.env`.
3. Exports it as Goose's required `GOOSE_SERVER__SECRET_KEY`.
4. Binds Goose to `127.0.0.1` only.
5. Forces `GOOSE_MODE=chat` for this customer-facing process.
6. Enables Goose's security prompt setting.
7. Refuses to start if the configured host is not localhost.

`GOOSE_MODE=chat` is important. Goose's Developer extension can execute shell commands and modify files, which is appropriate for an operator's interactive Goose session but not for untrusted WhatsApp customer input. Chat mode disables tool execution for the fallback process.

Your normal `goose session` profile remains separate and can continue to use the developer extension for your own engineering work.

## Configuration

`.env.example` documents:

```env
GOOSE_SERVICE_URL=http://127.0.0.1:3284
GOOSE_SERVICE_API_KEY=
GOOSE_SERVICE_HOST=127.0.0.1
GOOSE_SERVICE_PORT=3284
```

Do not commit the real key. `.env` is already ignored by Git.

Workspace-level Goose settings are also supported by the existing `IntegrationSettingsRepository`. When a workspace has Goose enabled with its own `serviceUrl` and `apiKey`, those values take precedence over the environment defaults.

## Prompt boundary

Goose's `/ask` endpoint accepts one prompt rather than a separate system-message field. The adapter therefore places the existing WhatchatAI system instruction ahead of the conversation and explicitly marks customer content as untrusted. The fallback process is also forced into chat-only mode so the model cannot turn that customer content into shell, filesystem, or MCP actions.

This is a defensive adapter, not a replacement for Gemini's native multimodal interface. The existing fallback path already converts media turns to text placeholders before Goose is called.

## Local setup

After pulling this branch:

```bash
cd "/mnt/c/Users/Peter Parker/Documents/New Whatschat"
npm install
npm run goose:fallback
```

In another terminal, verify the server is reachable through the same secret:

```bash
set -a
source .env
set +a
curl -i -H "Authorization: Bearer $GOOSE_SERVICE_API_KEY" \
  http://127.0.0.1:3284/status
```

A healthy server returns HTTP 200.

Then start WhatchatAI normally. Keep the Goose fallback terminal running while you test Gemini failure handling.

## Important distinction

Goose is an agent framework, not a direct inference API. The fallback intentionally uses only its text-response surface. Its powerful developer/automation capabilities remain reserved for your own operator sessions rather than being exposed to inbound WhatsApp traffic.
