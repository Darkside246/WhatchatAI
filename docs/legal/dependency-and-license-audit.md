# Dependency & License Audit

**This is an engineering compliance record, not legal advice.** Every
license below was read directly from the installed package's own
`package.json` and/or `LICENSE` file in `node_modules` at the time of this
audit (not assumed from reputation or memory) — see the Verification
Method note at the end. Nothing here should be treated as a legal
clearance for Version 1.0; items marked **FLAGGED FOR HUMAN REVIEW** must
be resolved by counsel before commercial launch.

## Explicitly required entries

| Project | Version/Commit | License | Where Used | Commercial Compatibility | Notice Required | Status |
|---|---|---|---|---|---|---|
| **Chatwoot** | n/a | MIT (core) / separate `enterprise/LICENSE` for `enterprise/` | **Not used.** No file, function, or pattern from Chatwoot exists anywhere in WhatchatAI — confirmed via repository-wide search, see `source-provenance.md`. | N/A — nothing incorporated | N/A | Not applicable — clean |
| **whatsapp-web.js** | n/a | Apache-2.0 (as published on its own repo) | **Not used.** No code or pattern incorporated. | N/A | N/A | Not applicable — clean |
| **Baileys** (`@whiskeysockets/baileys`) | 7.0.0-rc14 | MIT (verified from the package's own `LICENSE` file: "Copyright (c) 2025 Rajeh Taher/WhiskeySockets") | Core WhatsApp connection layer — `src/services/whatsappConnectionService.ts` and every message/media/call handler that consumes it | Compatible — MIT permits commercial use, modification, sublicensing, sale | Preserve the package's own `LICENSE` file within `node_modules` (default npm behavior — not altered); list Baileys in the product's third-party notices before GA | **OK**, with the caveat below |
| **Gemini / Google packages** (`@google/genai`) | 2.17.1 | Apache-2.0 (verified from the package's own `LICENSE` file) | `src/security/sentinel/sentinel.js` (content screening) — actual reply generation is not yet wired (see Phase 2 report) | SDK code license is compatible (Apache-2.0 includes an express patent grant). **Separately**, using the live Gemini API is also governed by Google's API Terms of Service / Generative AI Prohibited Uses Policy, which is a usage-terms matter independent of the SDK's open-source license. | Apache-2.0 requires preserving the LICENSE and any NOTICE file, and stating changes if the SDK source itself is modified (it is not, here — used only as a dependency) | SDK license: **OK**. API Terms of Service for commercial resale of Gemini-derived output: **FLAGGED FOR HUMAN REVIEW** — not a copyright issue, but Google's usage terms need sign-off before reselling AI-generated replies as part of a paid SaaS product |
| **Database packages** (`pg`) | 8.23.0 | MIT | `src/db/*`, every repository | Compatible | Standard MIT notice preserved via npm | **OK** |
| **Media libraries** (`hash-wasm`) | 4.12.0 | MIT | Client-side Argon2id PIN hashing (`src/web/src/lib/pinCrypto.ts`); also listed as a root dependency though not currently imported server-side | Compatible | Standard MIT notice preserved via npm | **OK** |
| **UI/icon libraries** (`lucide-react`) | 1.31.0 | ISC (verified from the package's own `LICENSE` file) | Every icon across the frontend (nav rails, message status ticks, media states, etc.) | Compatible — ISC is a permissive license functionally equivalent to MIT | Standard ISC notice preserved via npm | **OK** |
| **Authentication libraries** | — | — | No dedicated authentication/OAuth library is integrated yet. The closest component is `hash-wasm`'s Argon2id (used for local device-PIN hashing in `ScreenLock`, not account authentication). | N/A until a real auth library is chosen | N/A | **Not yet applicable** — flag for a future audit entry when real user/account authentication is built |
| **Payment libraries** | — | — | None integrated. Subscription/entitlement *schema* exists (`plans`, `subscriptions`, `usage_counters` tables) but no payment processor SDK (Stripe, Paddle, etc.) is wired. | N/A | N/A | **Not yet applicable** — flag for a future audit entry when a real payment processor is integrated |

## Full dependency list (everything actually installed and shipping)

All confirmed via each package's own installed `package.json`
`"license"` field, cross-checked against the actual `LICENSE` file where
noted above. None are copyleft (no GPL/AGPL/LGPL/SSPL/BSL); all permit
commercial SaaS use, modification, and redistribution without requiring
WhatchatAI's own source to be disclosed.

| Package | Version | License |
|---|---|---|
| @whiskeysockets/baileys | 7.0.0-rc14 | MIT |
| @google/genai | 2.17.1 | Apache-2.0 |
| bullmq | 6.1.1 | MIT |
| dotenv | 17.4.2 | BSD-2-Clause |
| express | 5.2.1 | MIT |
| hash-wasm | 4.12.0 | MIT |
| ioredis | 6.0.0 | MIT |
| pg | 8.23.0 | MIT |
| pino | 10.3.1 | MIT |
| qrcode | 1.5.4 | MIT |
| ws | 8.21.3 | MIT |
| zod | 4.4.3 | MIT |
| react | 19.2.8 | MIT |
| react-dom | 19.2.8 | MIT |
| react-router-dom | 7.18.2 | MIT |
| lucide-react | 1.31.0 | ISC |
| tailwindcss | 4.3.3 | MIT |
| @tailwindcss/vite | 4.3.3 | MIT |
| vite | 8.2.1 | MIT |
| @vitejs/plugin-react | 5.2.0 | MIT |
| typescript | 7.0.2 | Apache-2.0 |
| tsx | 4.23.12 | MIT |
| vitest | 4.1.10 | MIT |
| concurrently | 10.0.5 | MIT |

`@types/*` dev-only type-stub packages (from DefinitelyTyped) are omitted
from the table above — they're MIT-licensed, development-only, and never
ship in any built artifact.

## Verification method

Each license above was read live from the installed package via:
```
node -e "console.log(require('./node_modules/<pkg>/package.json').license)"
```
and, for the three dependencies with real commercial/legal weight
(Baileys, `@google/genai`, `bullmq`), by additionally opening the
package's own `LICENSE`/`LICENSE.md` file in `node_modules` to confirm the
`package.json` field matches the actual license text — not assumed from
the package name or general reputation, per policy. This was **not** done
by fetching each project's canonical GitHub repository; it reflects the
license as published in the exact installed npm package (`"latest"` at
install time for several deps — see `package.json` for the exact resolved
versions above).

## Outstanding items before Version 1.0

1. **Gemini API commercial Terms of Service** — flagged above; needs
   explicit human sign-off, separate from the SDK's Apache-2.0 code
   license, before reselling Gemini-derived replies commercially.
2. **No authentication library audited yet** — add an entry here once
   real account/session authentication (beyond the local device PIN) is
   built.
3. **No payment library audited yet** — add an entry here once a payment
   processor is integrated.
4. **Re-run this audit before GA** — several dependencies were installed
   via `"latest"` in `package.json` rather than a pinned version, so the
   exact shipped version (and therefore its license) can drift between
   installs. Pin versions and re-verify licenses before a 1.0 release.
