# Security Review Scope Matrix

This matrix prevents scoped audit artifacts from being read as project-wide
security signoff. Every security package, audit report, and readiness claim
must map to a specific surface and evidence set.

If a surface below is not marked reviewed, the correct claim is "scoped
review only", not "AgenC is audit-ready" or "the product is fully
security-reviewed".

## Current Scope Status

| Surface | Reachability / Privilege | Current Review Status | Evidence | Project-wide readiness claim allowed? |
| --- | --- | --- | --- | --- |
| On-chain coordination program | Escrow, reward distribution, dispute resolution, protocol authority | Scoped review completed for current Devnet / on-chain package | `docs/SECURITY_AUDIT_DEVNET.md`, `audit/security-audit-2026-02-19.md` | No, on-chain only |
| Runtime gateway and session control | WebSocket control plane, session ownership, tool routing | Not fully reviewed in a completed security package | `audit/security-audit-2026-02-19.md` (`Unaudited Modules`), `docs/RUNTIME_PRE_AUDIT_CHECKLIST.md` | No |
| Runtime system tools | Shell, HTTP, browser, file editing, network reachability | Partially hardened, not fully reviewed in a completed security package | `audit/security-audit-2026-02-19.md` (`Unaudited Modules`), runtime issue / PR history | No |
| Desktop sandbox control plane | Desktop REST bridge, VNC/noVNC exposure, sandbox auth, file containment | Review incomplete; open blocker(s) remain | Open issue tracker, `docs/RUNTIME_PRE_AUDIT_CHECKLIST.md` | No |
| WebChat ownership and desktop session binding | Session mapping, desktop attach/create authorization, cancellation semantics | Partially reviewed through targeted fixes, not fully signed off as a surface | Runtime issue / PR history, `docs/RUNTIME_PRE_AUDIT_CHECKLIST.md` | No |
| MCP tools and authorization | Tool exposure, permission boundaries, external capability routing | Unaudited in the current package | `audit/security-audit-2026-02-19.md` (`Unaudited Modules`) | No |
| Web frontend and demo surfaces | Browser UI, demo app, human-facing web surfaces | Unaudited in the current package | `audit/security-audit-2026-02-19.md` (`Unaudited Modules`) | No |

## Allowed Claims

- Allowed: "The Solana coordination program has no findings within the current
  Devnet / on-chain review scope."
- Allowed: "This artifact covers the on-chain program only."
- Not allowed: "AgenC is audit-ready" unless every externally reachable or
  privilege-bearing surface in this matrix is either reviewed or explicitly
  signed off as deferred risk for the stated milestone.
- Not allowed: reusing an on-chain-only artifact as evidence that runtime,
  desktop, webchat, MCP, or frontend surfaces are security-reviewed.

## Release Gate

Before any project-wide security-readiness claim, release note, or auditor
handoff:

- Update this matrix for the intended release commit.
- List any remaining out-of-scope surfaces explicitly.
- Confirm the runtime / desktop / webchat checklist in
  `docs/RUNTIME_PRE_AUDIT_CHECKLIST.md` is complete.
- Record the blocking issues or accepted exceptions.
- Obtain named security-owner signoff.
