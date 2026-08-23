# Architecture Status

**Single source of truth for phase-gate progress on this engagement.**
Updated at the end of each phase (or, as here, at an explicit testing
checkpoint) — not a replacement for the individual phase proposal/audit
docs, which remain the authoritative record of *why* each decision was
made. This document is the map; the phase docs are the terrain.

**Current testing checkpoint: `60da62b`**
**Active branch: `openclaw-cell-runtime`**

Status legend: **Complete** (implemented, tested, merged to this branch) ·
**Testing/Stabilization** (implemented, awaiting real-world validation
before the next phase begins) · **Proposal/Awaiting Approval** (design
document exists, no code written) · **Not Started**.

---

## 1. Master directive phases (numbered sequence)

| Phase | Area | Status | Key commit(s) | Key decision |
|---|---|---|---|---|
| 0 | Master architecture/security/reliability audit | Complete | `309671e` | Read-only audit establishing the baseline every later phase built on; root-caused the status-text bug and the media-retry gap. |
| 1 | WhatsApp historical status text fix | Complete | `efe754b` (proposal), `43e8cf8` (implementation) | `status@broadcast` messages from `messaging-history.set` now route through the same `whatsappStatusPersistenceService` the live path already used, via a shared `STATUS_BROADCAST_JID` constant. |
| 2 | Media/status download reliability | Complete | `cb69718` (2A proposal), `90b3a2a` (2B implementation), `c06fde6` (manual retry) | Real guarded retry state machine (`pending → downloading → downloaded / retry_scheduled / failed / unavailable`); atomic temp-file-then-rename storage; deterministic BullMQ `jobId`; crash-recovery sweep; manual retry API (`POST /api/workspace/media/:id/retry`) + UI control for a `failed` row, per 2A section 9. |
| 3 | AI reliability / Gemini 429 protection | Complete | `9ac85b2` (3A proposal), `60da62b` (3B implementation) | Five-way error taxonomy (capacity/auth/malformed_request/provider_config/programming); split circuit breakers; one-time operator notification; escalation-hop fix; trailing-edge AI debounce; outbound-send boundary fix. |
| 4 | Multilingual/slang/dialect intelligence (Caribbean English, Bajan, Jamaican Patois, Trinidadian patterns, code-switching) | Not Started | — | Next in the recommended priority order now that manual media retry (§1 note) has shipped. |
| 5 | Document/knowledge security | Not Started | — | Recommended ahead of further feature expansion (security before growth), even though it sits after Phase 4 in the directive's original numbering. |
| 6 | AI email system | Not Started | — | Recommended to reuse Phase 3's error classification, idempotency, execution-context, and observability patterns rather than reinventing them. |
| 7 | Billing, fees, taxes, pricing | Proposal/Awaiting Approval | `2071bb5` (audit+proposal) | Split into Track A (invoices/line-items/tax-rate schema, a pure pricing engine, usage-counter wiring, the `canConnectWhatsAppAccount` enforcement fix — all buildable now, no external decisions needed) and Track B (real payment collection, tax-jurisdiction compliance, dunning — blocked on business decisions listed in the proposal doc). See `docs/PHASE_7_BILLING_PRICING_AUDIT_AND_PROPOSAL.md`. |
| 8 | Team/invitations/session security | Not Started | — | Recommended ahead of Phase 4/6 feature work — this is an access-control surface. |
| 9 | Timezones/localization | Not Started (needs confirmation audit first) | — | Substantial related work (TimeProvider/TimeSyncService/TimeZoneResolver/TimeContext, `get_current_time` tool, timezone Settings UI) already exists in this codebase from earlier in the engagement, predating this directive's specific requirements. Audit before building — may already be largely satisfied. |
| 10 | Campaign/funnel lifecycle | Not Started (needs confirmation audit first) | — | Earlier funnel-deletion-lifecycle hardening and campaign-lifecycle-semantics audits already exist. Audit before building. |
| 11 | Contact identity/WhatsApp sync | Not Started (needs confirmation audit first) | — | Earlier contact/chat identity reconciliation work already exists. Audit before building. |
| 12 | Recent activity/audit | Not Started (needs confirmation audit first) | — | Likely partially covered by existing `security_audit_logs`/notification infrastructure. Audit before building. |

---

## 2. Writing Twin track (separate from the numbered phases)

| Phase | Status | Key commit | Purpose |
|---|---|---|---|
| W1-A | Complete | `63fc5c8` | Attribution audit (read-only). |
| W1-B | Complete | `8eda6ce` | Architecture proposal (design only). |
| W2-A | Complete | `2c2b35a` | Exact schema design (design only). |
| W2-B | Complete | `ab82c4d` | Implementation proposal (proposal only). |
| W3 | Complete, **not integrated** | `ab0f365` | Personal AI Writing Twin implemented. |
| W4 | **Not started — awaiting explicit authorization** | — | Integration gate: evidence generation, identity/attribution, retrieval boundaries, model presentation, caching/deletion, recomputation, integration surfaces, settings/UX, security/abuse analysis, plus the mandatory evidence trust hierarchy (explicit user setting/correction > verified user-authored content > user edits to AI content > inferred patterns > never: unverified autonomous agent content). |

The Writing Twin (W1–W3) is a real, working system that remains
**deliberately disconnected** from the autonomous WhatsApp/AI execution
path. It does not participate in any AI reply, debounce, or orchestration
flow described in section 1. It stays parked, independent of the
numbered-phase sequence, until W4 is explicitly authorized.

---

## 3. Next step (as of this checkpoint)

Manual media retry (previously the deferred item here) shipped at
`c06fde6`. Encryption-key-mismatch hardening (fingerprint registry +
boot-time fail-loud check) shipped at `a2f408f`. Phase 7 (billing/
pricing) and a combined Cloud Architecture + Multi-Tenant WhatsApp
Connection audit are both written and awaiting authorization — see
`docs/PHASE_7_BILLING_PRICING_AUDIT_AND_PROPOSAL.md` and
`docs/CLOUD_ARCHITECTURE_MULTI_TENANT_WHATSAPP_AUDIT.md`.

**User's recommended order from here** (agreed, not yet started):

1. Cloud architecture Stage 1 (decision-free infra work: managed
   Postgres/Redis, secrets out of `.env`, Cloud Run for the API) —
   see the cloud/WhatsApp audit doc §4.
2. Production key rotation with versioning (per-record `keyVersion`,
   dual-key decrypt during migration, background re-encryption sweep)
   — flagged as a real gap in the current `ALLOW_MASTER_KEY_CHANGE`
   override, which detects/permits a key change but does not migrate
   any data. Not yet scoped as its own audit doc.
3. The Stage 2 WhatsApp-connection refactor (singleton → keyed map) —
   see the cloud/WhatsApp audit doc §5.
4. Phase 7 Track A (billing/pricing engine, buildable without a
   payment-processor decision).
5. Remaining deferred visual/UI work.
6. Payment provider decision + Phase 7 Track B.
7. Remaining master-directive phases (4, 5, 6, 8–12).

No phase past this point begins without its own explicit authorization.

---

## 4. Architectural decisions future work must not accidentally undo

These are load-bearing, deliberate choices from Phases 0–3. A future
phase that touches adjacent code should treat each of these as a
constraint, not an implementation detail to "clean up":

- **Writing Twin stays disconnected** from autonomous WhatsApp/AI
  execution until W4 is explicitly authorized and implemented.
- **AI debounce jobs are signals, not authoritative payloads.** The
  BullMQ job (`ai-debounce-<chatId>`) only ever means "check this chat
  now" — it never carries message content as the source of truth.
- **AI reply generation re-queries authoritative state from Postgres**
  at fire time (`findUnansweredInboundSince`), rather than trusting
  anything captured at schedule time — this is what makes
  ordering-preservation and loss-safety structural rather than promised.
- **Media descriptors are not persisted** for crash-retry purposes. The
  raw Baileys media descriptor (mediaKey, CDN URL) exists only in the
  BullMQ job payload; persisting it to enable automatic crash-recovery
  would be a separate security/data-lifecycle decision requiring its own
  review — not an incremental fix to bolt on.
- **Media storage uses atomic temp-file-then-rename writes**
  (`localEncryptedMediaStorage.ts`) — never write directly to the final,
  content-addressed path; a corrupt partial file there would poison the
  sha256 dedup cache permanently.
- **Retry/failure state transitions are guarded and idempotent** — every
  transition (media download states, AI-handoff claim/release) is a
  conditional `UPDATE ... WHERE <expected-state>`, never an unconditional
  write. This is the actual concurrency/duplicate-safety mechanism, not
  an optimization.
- **Only capacity/transient AI failures feed the retry-driving circuit
  breaker** (`geminiCircuitBreaker`). Auth/provider_config failures feed
  a separate, long-cooldown breaker that gates a one-time notification
  instead — retrying a bad key via the capacity breaker's probe
  mechanism can never fix it. Programming-class failures feed neither
  breaker and must never be laundered through the same fallback path as
  an ordinary provider failure.
- **The Security Sentinel remains architecturally independent** of the
  AI reliability/circuit-breaker work — it shares only the Gemini API
  client, has its own fail-open-to-`'unavailable'` design, and is out of
  scope for any future phase unless separately authorized.

---

## 5. Reference: full commit ledger for this sequence

```
60da62b Phase 3B: five-way AI error taxonomy, split circuit breakers, and trailing-edge debounce
9ac85b2 Phase 3A: AI reliability audit and error-classification/debounce proposal (docs only)
90b3a2a Phase 2B: activate media download retry with a guarded state machine
cb69718 Phase 2A: media retry audit and failure-state/idempotency proposal (docs only)
43e8cf8 Phase 1: fix historical WhatsApp status@broadcast misrouting
efe754b Phase 1: WhatsApp status text fix implementation proposal
309671e Phase 0: master architecture/security/reliability audit (read-only)
ab0f365 Phase W3: Personal AI Writing Twin implementation
ab82c4d Phase W2-B: Writing Twin implementation proposal (proposal only)
2c2b35a Phase W2-A: Writing Twin exact schema design (design only)
8eda6ce Phase W1-B: Personal AI Writing Twin architecture proposal (design only)
63fc5c8 Phase W1-A: Writing Twin attribution audit (read-only)
```

Full per-phase reasoning, findings, and regression test plans live in
their own documents under `docs/` (e.g.
`PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md`,
`PHASE_2A_MEDIA_RETRY_AUDIT_AND_PROPOSAL.md`,
`PHASE_0_MASTER_DIRECTIVE_AUDIT.md`) — this document indexes them, it
does not replace them.
