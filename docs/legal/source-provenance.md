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

One clarification on "research" vs. "reuse": the Phase 2 directive asked
for GitHub research into five reference repositories (WhatsApp-Flows-Tools,
whatsapp-web.js, WAHA, WAHA docs, WACRM) for architectural ideas. That
research step was not actually performed in this session — the Phase 2
audit covered Baileys' own installed capabilities directly, not those five
repos. Nothing from them has been read, copied, or adapted. If a future
session does perform that research and something from it (an architectural
pattern, a UI structure, actual source lines) makes it into WhatchatAI, an
entry is required below — including for a pattern extracted only
conceptually and reimplemented, per the "record the decision" rule.

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

No file from Chatwoot's `enterprise/` directory has been inspected, copied,
or adapted. Per policy, that directory remains entirely off-limits until a
human has reviewed `enterprise/LICENSE` from the Chatwoot repository and
explicitly determined compatibility with WhatchatAI's commercial SaaS
distribution — that review has not happened, so no future contribution may
draw on that directory without it happening first.
