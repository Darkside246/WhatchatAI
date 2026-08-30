# Deploying to Fly.io

Step-by-step provisioning sequence for `fly.toml`. Everything here is a
real account action on your own Fly org — none of it can be done from an
assistant session, since it needs your Fly login and touches billing.

Prerequisite: the codebase already supports this without further code
changes — `whatsappConnectionManager.ts` holds one live connection per
business (not a single-tenant singleton), and `mediaStorage.ts` can write
to a shared S3-compatible bucket instead of local disk
(`MEDIA_STORAGE_BACKEND=s3`), which is what makes it safe to run
`app-server` and `app-worker` as separate Fly machines.

## 1. Install the CLI and log in

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

## 2. Generate a starter config, then replace it

```bash
fly launch --no-deploy
```

This detects the `Dockerfile`, asks for an app name and region, and writes
its own `fly.toml`. Overwrite the generated file with the one already
committed at the repo root — it defines the two process groups
(`app_server`, `app_worker`), the WhatsApp session volume mount, and the
health check this app actually needs. Fill in your real `app` name and
`primary_region` at the top.

## 3. Create the WhatsApp session volume

One volume, tied to the single `app_server` machine (WhatsApp session
credentials are the one piece of state that still has to live on disk, per
business, under `/app/data/whatsapp/<businessId>/` — see
`whatsappTenantConnection.ts`'s `resolveContainedSessionDir`):

```bash
fly volumes create whatsapp_session --region <primary_region> --size 1
```

Start at 1GB — WhatsApp credentials are tiny (a few KB per business). Grow
it later with `fly volumes extend` if you ever need to.

## 4. Create the Tigris bucket (shared media storage)

```bash
fly storage create
```

This provisions a Tigris bucket and sets `BUCKET_NAME`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, and
`AWS_REGION` as app secrets automatically — `s3EncryptedMediaStorage.ts`
picks all of these up with zero extra config (the AWS SDK reads them from
the environment on its own). `MEDIA_STORAGE_BACKEND=s3` is already set in
`fly.toml`'s `[env]` block.

## 5. Create Postgres and Redis

```bash
fly postgres create
fly redis create
```

`fly redis create` provisions Upstash-backed Redis. Either command prints
a connection string — copy both.

## 6. Set the remaining secrets

```bash
fly secrets set \
  DATABASE_URL="<from fly postgres create>" \
  REDIS_URL="<from fly redis create>" \
  MASTER_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" \
  GEMINI_API_KEY="<your key>" \
  APP_URL="https://<your-app-name>.fly.dev"
```

Add any other secrets your deployment actually uses (`RESEND_API_KEY`,
`GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`, etc. — see `.env.example` for the
full list). Never put real secrets in `fly.toml` itself; it's committed to
git.

## 7. Deploy

```bash
fly deploy
```

`app_server`'s command runs `node dist/db/migrate.js` before starting the
server, so migrations apply automatically on every deploy.

## 8. Verify

```bash
fly status
curl https://<your-app-name>.fly.dev/api/health/whatsapp
```

`connectedTenantCount` should be `0` on a brand-new deploy (no business
has connected yet) — that's correct, not a failure. Log in to the app,
connect a real WhatsApp number, and confirm `connectedTenantCount` becomes
`1` and a real inbound message lands.

## Known gaps, not yet built

- **Existing local media doesn't migrate itself.** If you were previously
  running with `MEDIA_STORAGE_BACKEND=local` (Overlord/docker-compose),
  switching to `s3` starts every *new* upload going to Tigris, but files
  already on the old local volume stay there and won't be found — nothing
  in this repo copies them into the bucket. Only relevant once you're
  migrating an existing deployment with real stored media, not a fresh
  Fly deploy.
- **`app_worker` isn't wired into `fly.toml` for the other five in-process
  workers** (`outboundMessagesWorker`, `scheduledStatusPublishWorker`,
  `messageRevocationWorker`, `emailSendWorker`, `funnelAdvanceWorker`) —
  those still run inside `app_server` (they need the live Baileys socket,
  same as today), matching `docker-compose.yml`'s existing split exactly.
  Nothing to change here; noted so it isn't mistaken for an oversight.
