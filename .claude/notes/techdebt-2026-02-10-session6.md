## Tech Debt Report - 2026-02-10 (Session 6 — Security Audit Fixes)

PR: fix/security-audit-batch-1

### Critical (Fix Now)
None.

### High (Fix This Sprint)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Duplicated lamport transfer pattern (8x) | `resolve_dispute.rs`, `expire_dispute.rs` | DRY violation, maintenance burden | Extract `transfer_lamports(from, to, amount)` helper into shared module |

### Medium (Backlog)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Error code range comments drifted | `errors.rs:418-422` | Documentation confusion | Realign range comments |
| Overlapping fund distribution logic | `expire_dispute.rs:262-356` vs `resolve_dispute.rs:237-280` | Harder to audit | Consider unifying split logic or documenting divergence |
| Worker validation only used once | `resolve_dispute.rs:372-431` | Not shared | Move to `worker_helpers.rs` if reuse needed |

### Duplications Found
| Pattern | Locations | Occurrences | Refactor To |
|---------|-----------|-------------|-------------|
| checked_sub escrow + checked_add recipient | resolve_dispute.rs, expire_dispute.rs | 8 | `transfer_lamports()` helper |

### Summary
- Total issues: 4
- Estimated cleanup: 2-3 files
- Recommended priority: Extract `transfer_lamports()` helper (high value, low risk)
- No blockers for current PR
