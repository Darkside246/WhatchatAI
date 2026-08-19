# Tenant Model

## The scoping hierarchy (real, enforced today)

```
business_id
  └── whatsapp_account_id  (a business may have more than one WhatsApp account)
        └── contact / chat / group / message / media / status / call / presence / jid_mapping
```

Every WhatsApp-entity table carries both `business_id` and
`whatsapp_account_id` directly (not just transitively through a join) —
confirmed across all of `whatsapp_accounts`/`whatsapp_contacts`/
`whatsapp_groups`/`whatsapp_group_members`/`whatsapp_chats`/
`whatsapp_messages`/`whatsapp_media`/`whatsapp_calls`/`whatsapp_statuses`/
`whatsapp_presence`/`whatsapp_jid_mappings` in `src/db/migrations/`. This
lets every query and repository filter by the tenant boundary directly,
without a join to prove ownership.

## Enforcement pattern

Repositories take the tenant scope as required constructor/method
arguments — there is no method on any repository that returns
cross-tenant data by accident (confirmed via `test/tenantIsolation.test.ts`,
which specifically tests that one business's repository calls never leak
another business's rows).

Service-layer ownership re-checks exist on top of that, e.g.
`workspaceService.ts`'s pattern (used consistently across
`getChatDetail`/`listMessages`/`setAiMode`/`markChatRead`):
```ts
const chat = await this.chatRepository.findById(chatId);
if (!chat || chat.businessId !== businessId || chat.whatsappAccountId !== whatsappAccountId) {
  throw this.notFound();
}
```
A chat ID alone is never trusted — the caller's actual business/account
context must match the row's, or it's treated as not found (never as a
different, leaked error shape that would confirm the row's existence to
an unauthorized caller).

## The honest gap: no real multi-user layer yet

`business_id` is real and enforced, but **there is currently no
`users`/`memberships`/`roles` layer above it.** The application resolves
tenant context today via `BusinessRepository.ensureDefault()`
(`src/repositories/businessRepository.ts`) — an implicit single "Default
Business" per deployment, not a real authenticated multi-user account
system. This is consistent with the dependency audit's own finding ("no
authentication or payment provider has been integrated yet") and the
architecture gap analysis's #1 ranked missing system.

**This does not mean tenant isolation is fake.** The `business_id`/
`whatsapp_account_id` scoping is real, tested, and would work correctly
the moment a real multi-user auth layer is added on top — every table and
repository already requires the tenant scope as an argument; nothing
needs to be restructured, only a new `users`/`account_users` layer needs
to be added above it (per the recommended architecture in
`docs/reference/architecture-gap-analysis.md`).

## Multiple WhatsApp accounts per business

The schema and repositories already support a business having more than
one `whatsapp_accounts` row (each with independent `connection_status`,
`sync_status`, credentials). The current frontend/API layer resolves a
single "the" connected account per business via
`whatsappConnectionService.getPersistedContext()` — real for today's
single-account-per-deployment product shape, and consistent with the
directive's "each WhatsApp account has independent authentication, sync,
AI configuration, usage, routing" requirement being a schema-level
guarantee already, even though the UI doesn't yet expose switching
between multiple accounts.
