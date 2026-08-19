# Source Provenance Record

This document tracks every instance where WhatchatAI code was copied or
adapted from an external open-source project, per the Chatwoot
licensing/code-reuse policy this repository operates under. It is an
engineering compliance record, not legal advice — see
`dependency-and-license-audit.md` for the separate npm-dependency audit.

**Policy**: before any external source code is copied or adapted into this
repository, the specific file must be checked against the rules in that
project's actual license (not assumed from the project's overall
reputation), and an entry must be added below *before* the change merges.
`enterprise/`-style restricted directories in any reference project are
off-limits until their license has been individually reviewed and found
commercially compatible.

## Current status: zero external source reuse

As of this record, a repository-wide search confirms **no code exists in
WhatchatAI that references, copies, or adapts source from Chatwoot,
whatsapp-web.js, WAHA, WAHA docs, WACRM, or WhatsApp-Flows-Tools**. Every
file in `src/` was written as original WhatchatAI code against the
directly-installed `@whiskeysockets/baileys` package's own real API
surface (see `dependency-and-license-audit.md` for that dependency's
license). No lines, functions, components, or file structures were copied
from any of those reference projects.

## Research status (updated)

- **Chatwoot**: actually researched this pass — a fresh shallow clone of
  `https://github.com/chatwoot/chatwoot` was inspected directly (real
  model files under `app/models/` and `enterprise/app/models/`, not the
  README). Findings: `docs/reference/chatwoot-feature-map.md`,
  `docs/reference/architecture-gap-analysis.md`. Result: **conceptual
  patterns only were extracted** (e.g. the shape of `AutomationRule`'s
  event/condition/action model, `Conversation`'s dual agent/contact
  last-seen tracking) — no source lines were copied. No entry is required
  in the table below because "conceptual pattern, reimplemented
  originally" per this policy's own preference (see "Prefer original
  implementation when practical" in the governing directive) doesn't
  constitute reuse of the source itself. If a future session copies actual
  Chatwoot source lines, an entry is required then.
- **whatsapp-web.js**: actually researched this pass — a fresh shallow
  clone of `https://github.com/wwebjs/whatsapp-web.js` was inspected
  directly (`src/Client.js`, `src/structures/*.js`,
  `src/util/Constants.js`). Findings:
  `docs/reference/whatsapp-connector-comparison.md`,
  `docs/reference/whatsapp-feature-map.md`. Result: **not adopted as a
  connector** (see `docs/architecture/adr-001-whatsapp-connector.md`) and
  **no source reused** — it informed the connector comparison only.
- **WAHA, WAHA docs, WACRM, WhatsApp-Flows-Tools**: still **not
  researched** — this session's directive scoped Phase A research to
  Chatwoot and whatsapp-web.js only (narrower than the earlier Phase 2
  directive, which named all five but whose research step was never
  carried out). Nothing from these four has been read, copied, or
  adapted. If a future directive asks for that research, this record must
  be updated the same way the two entries above just were.

## Table

| Source | File / Module | License | Reuse Type | Action | Required Notice | Why Used |
|---|---|---|---|---|---|---|
| _(none yet)_ | — | — | — | — | — | — |

Columns, for future entries:
- **Reuse Type**: `Copied verbatim` / `Adapted (substantial)` / `Adapted (minor)` / `Conceptual pattern only (no source reused)`
- **Action**: what WhatchatAI did with it (e.g. "ported to TypeScript," "used as reference, rewritten")
- **Required Notice**: the exact copyright/license notice text that must be preserved and where it now lives in this repo (e.g. a `NOTICE` file, a file-header comment)
- **Why Used**: the engineering justification — per the project's own rule to prefer an original implementation over reuse "just because the license permits it"

## Special note: Chatwoot's `enterprise/` directory

`enterprise/LICENSE` was read directly this pass (real text, not
assumed). It is a source-available license, not MIT: production use
requires agreeing to Chatwoot's Subscription Terms of Service and holding
a valid Enterprise License "for the correct number of user seats";
copying, merging, publishing, distributing, sublicensing, or selling the
software is explicitly forbidden outside that subscription. Only
development/testing copying is permitted without one.

**Engineering-level determination** (not legal advice, per this
document's own framing): this license is **not compatible** with
WhatchatAI incorporating any `enterprise/` source into a commercial SaaS
product without purchasing a Chatwoot Enterprise subscription — which
defeats the purpose of "reuse" in the first place. `enterprise/app/models/
captain/*.rb` (Chatwoot's AI system) was specifically inspected under this
finding and confirmed to fall under this license — see the "AI / Captain"
row in `docs/reference/chatwoot-feature-map.md` for the conceptual-only
treatment given to it. No code from `enterprise/` has been copied or
adapted, and none should be without a human confirming the commercial
subscription terms first — this record does not substitute for that
confirmation, it documents why the directory remains off-limits.
