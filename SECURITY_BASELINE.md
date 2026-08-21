# SECURITY_BASELINE.md

Phase 0 security posture snapshot. This is a **static code/configuration
audit**, not an intrusion-detection scan - it says nothing about whether the
system has been compromised, only what protections exist in the code today
and what gaps remain relative to the target state in the production-safety
directive. Findings are classified per the directive's own scheme
(CLEAN / SUSPICIOUS / HIGH RISK / CRITICAL / UNKNOWN), and each is marked
**Confirmed**, **Potential**, **Informational**, or **Unable to verify**.

## Controls confirmed present

| Control | Where | Status |
|---|---|---|
| Message-content security gate | `src/security/sentinel/` (heuristic + Gemini classification, 2-stage) | Confirmed |
| Field-level encryption at rest | `src/security/encryption/encryptionService.ts` (AES-256-GCM, envelope, Redis-cached DEK) | Confirmed |
| Session-cookie auth, Argon2id hashing | `authService.ts`, `authMiddleware.ts` | Confirmed |
| Role-based authorization | `requirePermission()`, `business_memberships.role` | Confirmed |
| Tenant scoping at the repository layer | `WHERE business_id = $1` pattern, 26/39 repositories | Confirmed (see below for the unverified part) |
| Secrets excluded from git | `.gitignore` lines 3-4 (`.env`, `.env.*`) | Confirmed |
| Media served only via authenticated endpoint | `GET /api/media/:id` | Confirmed (this session's own prior work) |
| Zero-PII lock-screen alert design | `securityAlertService.ts` (explicit "Zero-Leak Rule" doc comment) | Confirmed |
| Dependency vulnerability scan (point-in-time) | `npm audit` | Confirmed: 0 findings at audit time |
| AI tool with no write capability, no free-form args | `get_current_time` (this session) | Confirmed |

## Gaps - Informational (absence of not-yet-built architecture, not a
   defect in existing code)

- No container isolation of any kind (Section 4/5 of the directive) -
  **Informational**, not a regression, since no containerization has ever
  existed here.
- No AI tool permission/risk-classification model (Sections 6-9) -
  **Informational**. Today there is exactly one AI-invocable capability
  (`get_current_time`), and it is read-only with no arguments, so the
  absence of a generalized policy gate has limited blast radius today. It
  becomes a real risk the moment a second, mutating tool is added without
  first building that gate.
- No structured/versioned per-agent execution context (Section 9/33) -
  **Informational**, same reasoning.
- No scheduled/recurring security scan (Sections 36-39) - **Informational**,
  does not exist, not degraded.
- No prompt-injection-specific structural defenses beyond instruction-level
  guidance in the system prompt (Sections 11-14) - **Informational** given
  the AI currently has no write/send tools it could be tricked into
  invoking; this changes if write-capable tools are ever added.
- No OpenClaw/DSPy/OpenPanel/Cloudberry integration exists, so their
  respective isolation requirements (Sections 10, 26-28, 32) are moot at
  this time - **Informational**.

## Gaps - Potential findings requiring further verification

- **Tenant-isolation route audit incomplete.** This audit confirmed the
  *pattern* used for tenant scoping (session-derived `businessId` via
  `requireWorkspaceContext`, never a client-supplied identifier) by
  inspecting representative routes, but did **not** exhaustively check
  every route in `src/server/index.ts` (a single ~2,700-line file with
  150+ handlers) for a case where a client-supplied identifier is trusted
  instead of the session-derived one. Classification: **Potential**,
  Unable to fully verify in this pass. Recommended: a targeted grep/review
  pass specifically for `req.body`/`req.query`/`req.params` values used as
  a `businessId`/tenant filter anywhere in that file, as a dedicated
  follow-up (not blocking Phase 0).
- **Master encryption key is local, not KMS-backed.** Documented as a known
  simplification in `.env.example` and `kmsKeyProvider.ts`'s own naming
  (an abstraction point for a future real KMS). Classification:
  **Informational** for a single-tenant/early-stage deployment, but should
  be reclassified as a real finding before any production deployment
  handling sensitive customer data at scale.
- **`@whiskeysockets/baileys` pinned to a release-candidate version**
  (`7.0.0-rc14`), not a stable release, for the entire WhatsApp transport.
  Classification: **Informational/Potential** - this is the currently
  working, tested version (76/76 test files pass with it), so it is not
  being flagged as broken, only as a supply-chain consideration: an RC
  dependency for the single most safety-critical integration in the
  application warrants a deliberate decision (pin explicitly with a reason
  recorded, or evaluate the stable release) rather than silent drift via
  `"latest"` in `package.json`.
- **No lockfile/dependency-change monitoring exists.** `npm audit` was run
  once, manually, for this document. There is no recurring job that would
  catch a newly-disclosed vulnerability in an already-installed dependency,
  or a lockfile change introduced without review. Classification:
  **Potential** gap, not a confirmed compromise indicator.

## Explicitly not evaluated in this pass (would require live infrastructure
   this repository audit cannot see)

- Actual production deployment target, network topology, secret-injection
  mechanism, firewall rules - **Unknown**, no IaC/deployment manifests
  exist in this repository to audit.
- Whether the currently-running host processes, listening ports, or
  outbound network connections in *this specific sandbox* are as expected
  - out of scope for a source-code audit; this document makes no claim
  about runtime process integrity.
- Container image provenance, SBOM, image scanning - not applicable, no
  container images exist yet.

## Summary classification

**CLEAN** for what exists: no confirmed vulnerabilities, no confirmed
tenant-isolation break, no confirmed secret leakage, dependency audit
clean. **The absence of the directive's target-state AI zero-trust
architecture is not itself a finding against existing functionality** - it
is scope not yet built, correctly deferred to later phases per the
directive's own phase ordering. The one item worth prioritizing before any
phase that adds a second, mutating AI tool is the AI tool
permission/risk-classification gate (Sections 6-9) - adding write-capable
tools onto the current one-off hand-wiring pattern would be the point
where "no policy gate exists yet" stops being informational and starts
being a real risk.
