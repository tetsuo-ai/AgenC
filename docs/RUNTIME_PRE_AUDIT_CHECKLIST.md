# Runtime / Desktop / WebChat Pre-Audit Checklist

Use this checklist before making any project-wide security-readiness claim or
before handing AgenC to an external auditor as more than an on-chain review.

If any item below is incomplete, the correct status is "scoped review only".

## 1. Scope Declaration

- [ ] The release commit is frozen and recorded.
- [ ] The declared runtime review scope names the exact modules being reviewed.
- [ ] Out-of-scope surfaces are listed explicitly.
- [ ] `docs/SECURITY_SCOPE_MATRIX.md` is updated for the release commit.

Minimum modules to classify before signoff:

- `runtime/src/gateway/`
- `runtime/src/tools/`
- `runtime/src/channels/webchat/`
- `runtime/src/desktop/`
- `containers/desktop/server/`
- any exposed browser / desktop control-plane bridge

## 2. Review Coverage

- [ ] Threat modeling covers externally reachable and privilege-bearing runtime
      surfaces.
- [ ] Session ownership boundaries are reviewed for create / attach / cancel
      flows.
- [ ] Desktop control-plane authentication and published-port assumptions are
      reviewed.
- [ ] File-containment and path-normalization behavior is tested directly in
      the desktop server layer.
- [ ] Shell and system tool restrictions are reviewed for bypasses, chaining,
      and command-construction edge cases.
- [ ] HTTP / browser networking paths are reviewed for SSRF, redirect abuse,
      and local-network reachability.
- [ ] Tool routing, approvals, and privileged fallbacks are reviewed for scope
      drift.

## 3. Findings Gate

- [ ] No open Critical findings remain in the declared runtime scope.
- [ ] No open High findings remain in the declared runtime scope.
- [ ] Medium findings are either fixed or documented with named acceptance.
- [ ] Scoped documents do not claim project-wide readiness while any surface is
      still unaudited.

## 4. Operational Gate

- [ ] Published ports, auth requirements, and CORS / origin assumptions are
      documented.
- [ ] Every externally reachable surface has a named owner.
- [ ] No externally reachable or privilege-bearing surface remains outside the
      declared audit scope without explicit signoff.
- [ ] Blocking issues are listed in the release record.

## 5. Security Owner Signoff

Record before any project-wide readiness statement:

- Security owner:
- Release owner:
- Release commit:
- Date:
- Open exceptions:
- Signoff statement:
  - "I confirm that the declared review scope matches the externally reachable
    AgenC surfaces for this milestone, and that any remaining exclusions are
    explicitly documented."
