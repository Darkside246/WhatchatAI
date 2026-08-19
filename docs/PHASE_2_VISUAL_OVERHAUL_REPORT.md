# Phase 2: Visual Overhaul & Feature Expansion — Stage 1 Report

Scope of this stage (user-confirmed priority: **visual overhaul first**, before
outbound media, Gemini auto-response wiring, or Channels — those are real,
separately-scoped gaps found during the audit below, not yet built).

## Note on the reference screenshot

The directive named `Screenshot 2026-08-15 223539.gif` as the visual
reference but no image was attached to any message in this session, and no
matching file exists on disk. This stage was implemented from the
directive's own written design system (section 3: dark navy/charcoal, one
consistent green accent, WhatsApp-inspired bubbles; section 27: the full
token list) rather than a pixel match to an image Claude never saw. If you
attach the actual screenshot, I can do a follow-up pass to correct anything
that doesn't match it.

## STEP 1-4 audit (repository, media system, dependencies, Baileys capabilities)

**Installed versions** (source of truth, not assumed):
- `@whiskeysockets/baileys@7.0.0-rc14`
- `@google/genai` ("latest" — resolves to the current SDK; used today only
  by the two-stage Sentinel's regex+Gemini-Flash content screening, not by
  any auto-reply generation)
- `react` 19, `typescript` latest, `vite` 8, `pg` 8.23, `ioredis` 6, `bullmq` 6.1

**Real media architecture (from the prior phase) — confirmed intact and
authoritative, not touched this stage:**
`whatsapp_media` schema/repository, `MediaCompatibilityService`
(`src/domain/whatsapp/mediaCompatibility.ts`), the binary/JSON codec
(`binaryCodec.ts`), `LocalEncryptedMediaStorage` (AES-256-GCM at rest,
SHA-256 deduped), the real `downloadMediaMessage()` worker job, and the
authenticated `GET /api/media/:id` Range-capable endpoint. All 146 backend
tests (including the 24 real media-pipeline tests) still pass unchanged.

**Baileys Channels (newsletter) support — genuinely real, confirmed from
installed source, not assumed:**
`lib/Socket/newsletter.js` exports `newsletterCreate`, `newsletterMetadata`,
`newsletterFollow`/`newsletterUnfollow`, `newsletterFetchMessages(jid,
count, since, after)`, `newsletterReactMessage`, `subscribeNewsletterUpdates`.
`isJidNewsletter()` recognizes the real `@newsletter` JID type. Real events
exist: `newsletter.reaction`, `newsletter.view`,
`newsletter-participants.update`, `newsletter-settings.update` — but there
is **no** `newsletter.upsert` push event; new channel posts are fetched via
`newsletterFetchMessages`, not pushed live like `messages.upsert`. This is
real, buildable support — not yet implemented (see "Known gaps" below).

## GAP ANALYSIS

| Area | Status |
|---|---|
| Real WhatsApp connection, sync, message persistence, encryption | **WORKING** — unchanged this stage |
| Real media download/storage/serving pipeline | **WORKING** — unchanged this stage |
| Real-time WebSocket sync (message/status/call/media/chat events) | **WORKING** — unchanged this stage |
| `ai_mode` persistence (AI_ACTIVE/AI_PAUSED/HUMAN_TAKEOVER) | **WORKING** — real DB column, real API, now also editable from the chat header (new this stage) |
| Design tokens (page/sidebar/panel/bubbles/text/status) | **WAS INCOMPLETE, NOW BUILT** — full section-27 token set added |
| Chat header showing real contact identity | **WAS BROKEN, NOW FIXED** — previously hardcoded to the literal text "Conversation"; now shows the real avatar/name/phone/JID via the existing `getChatDetail` API |
| CRM tags in the detail panel | **WAS INCOMPLETE, NOW SHOWN** — `crmContact.tags` existed in the API response but was never rendered |
| Tablet-specific layout | **WAS MISSING, NOW BUILT** — sidebar+chat previously jumped straight from single-pane mobile to 3-pane desktop at 1024px; now a real 2-pane layout (list+chat, no detail panel) appears at 768px |
| **Outbound message sending (text or media)** | **MISSING, NOT FAKED** — no `sock.sendMessage()` call exists anywhere in the codebase. The composer is honestly disabled with "Sending is not built yet." Building real outbound media (directive sections 13-17) requires building outbound *text* dispatch first — there is no existing pipeline to "extend." Not attempted this stage; flagged for a dedicated next stage. |
| **Gemini auto-response routing (AI_ACTIVE → real reply)** | **MISSING, NOT FAKED** — `aiContextGathererService.ts` only gathers context; the worker's AI-handoff point is a `console.log` placeholder, not a Gemini call. So today, setting a chat to AI_ACTIVE persists real state but does **not** yet cause a real automated reply — the backend routing the directive requires in section 9 doesn't exist yet. Not attempted this stage. |
| **WhatsApp Channels** | **NOT BUILT** — real connector support exists (see above) but no schema/repository/UI was built this stage, per the user's explicit priority choice (visual overhaul first). Confirmed genuinely buildable, not confirmed fake. |
| Voice-note recording (`MediaRecorder`) | **NOT BUILT** — depends on outbound media existing first |
| Drag-and-drop upload | **NOT BUILT** — depends on outbound media existing first |

## What changed this stage (visual overhaul only — no backend/data changes)

1. **`src/web/src/index.css`** — full design-token set: `--color-message-out`/`-in`,
   `--color-fg`/`-secondary`/`-muted`, `--color-success`/`-warning`/`-error`/`-unread`,
   `--color-info` (the real third `HUMAN_TAKEOVER` state, kept distinct
   rather than forced into success/warning/error).
2. **New `src/web/src/components/Avatar.tsx`** — replaces duplicated
   initials-circle markup in `ChatListPane`, `CallHistoryPanel`, and
   `ContactDetailPanel` with one real, reusable component. No profile-picture
   sync exists, so it renders the real display name's first letter — never a
   stock image.
3. **`ChatThread.tsx` header rebuilt** — was static text; now fetches the
   real chat via the existing `getChatDetail` API and shows avatar, real
   name (existing priority chain: contact display name → push name → chat
   name → resolved phone → raw JID), and phone/JID as a secondary line (JID
   only surfaces when no phone number is known, per section 8). Added the
   **AI Autonomous / Human Agent** segmented control from section 9,
   persisted through the existing real `setAiMode` API — not local state.
   Handles loading, saving, a failed-update error message, and a
   chat-switch race guard (a stale in-flight save can't clobber a
   newly-opened chat's displayed mode). The real third state, `AI_PAUSED`,
   is shown honestly as its own label rather than forced into one of the
   two buttons.
4. **Chat bubbles** now use the `message-out`/`message-in` tokens (dark
   green outgoing, elevated dark grey/blue incoming, per section 3). Read
   receipts switched from blue to the accent green, per section 3's
   explicit instruction to use the accent consistently for read receipts.
5. **Token sweep** across `SaasNavRail`, `InboxNavRail`, `ChatListPane`,
   `ContactDetailPanel`, `CallHistoryPanel`, `AgentsPage`, `AlertNotifier`,
   `ScreenLock`, `OnboardingPage`, `SyncingPage`, `WorkspaceShell`,
   `ChatsRoute` — literal `emerald-*`/`red-*`/`amber-*`/`gray-*` classes
   replaced with the new semantic tokens, per section 27's explicit
   instruction to prefer tokens over scattered color literals. The one
   deliberate exception: the QR code's white card background in
   `OnboardingPage` stays literal white — it's a functional requirement
   (QR contrast), not a themed surface.
6. **Real tablet breakpoint** — `ChatListPane`/`ChatThread`/`CallHistoryPanel`
   now split into a real 2-pane layout at `md` (768px) instead of jumping
   straight from single-pane mobile to 3-pane desktop at `lg` (1024px). The
   detail panel stays desktop-only (`lg`), matching section 23's "optional
   right context panel" being a desktop-only concept. `SaasNavRail`/
   `SaasNavBottomBar` shifted the same way so the compact icon rail — not
   the mobile bottom bar — shows on tablet.
7. **Real CRM tags exposed** — `ContactDetailPanel` now renders
   `crmContact.tags` as pills; the field already existed in the API
   response but was never displayed (section 7's "expose real CRM tags").

## Verification performed

- `npx tsc --noEmit` (backend) and `src/web`'s `tsc --noEmit && vite build`: clean.
- `npm test`: **34 test files, 146 tests, all passing** — zero regression to
  real WhatsApp sync, media persistence, or unread-counter behavior (none
  of that logic was touched this stage).
- Live browser check (`npm run dev`, real Chromium via Playwright,
  screenshots at 1440×900/820×1180/390×844): the onboarding screen renders
  correctly with the new tokens at all three widths; zero console errors
  or React warnings beyond an expected, already-handled 404 on the
  not-yet-available QR endpoint.
- **Honest limitation**: this sandbox has no paired WhatsApp account (same
  constraint documented in the prior two phase reports), so the app never
  leaves the onboarding gate — the redesigned `ChatThread`/`ChatListPane`/
  tablet-breakpoint behavior could not be visually verified against real
  chat data in this environment. The code paths are unchanged in shape
  (same components, same API calls, only classNames/structure changed) and
  the full backend test suite passing is the available evidence of
  correctness; a live-account visual check is recommended on your end.

## Next stages (not started, per the directive's own "controlled stages" rule)

In the order the audit surfaced them, from smallest to largest:
1. Outbound text dispatch (prerequisite for any outbound media) — real `sock.sendMessage()` wiring, ack tracking, DB persistence.
2. Outbound rich media (sections 13-17) — once (1) exists.
3. Gemini auto-response routing (section 9's other half) — replace the worker's placeholder log line with a real Gemini call gated on `AI_ACTIVE`.
4. WhatsApp Channels (sections 18-20) — real connector support confirmed above; schema + read-only UI.
5. Voice notes / device permissions / drag-and-drop (sections 21-22, 16) — depend on (2).
