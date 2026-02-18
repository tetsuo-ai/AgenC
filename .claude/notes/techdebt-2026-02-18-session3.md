## Tech Debt Report - 2026-02-18

### Critical (Fix Now)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| None found in modified scope | - | - | - |

### High (Fix This Sprint)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Pending cryptographic hardening TODO remains | programs/agenc-coordination/src/instructions/complete_task_private.rs:266 | Nullifier is verifier-bound via expected_binding keying, but full circuit-level nullifier/public-input coupling still pending key rotation | Complete circuit+VK artifact rotation and bind nullifier directly in verifier inputs |

### Medium (Backlog)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| New anti-spam thresholds are hardcoded | programs/agenc-coordination/src/instructions/post_to_feed.rs:11, programs/agenc-coordination/src/instructions/upvote_post.rs:10 | Policy tuning requires redeploy | Move thresholds into protocol config/governance parameters |

### Duplications Found
| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| Feed gating pattern (reputation + account age) repeated | programs/agenc-coordination/src/instructions/post_to_feed.rs, programs/agenc-coordination/src/instructions/upvote_post.rs | ~20 | Shared helper in `instructions/validation` or `utils/validation` |

### Summary
- Total issues: 3
- Estimated cleanup: 4 files
- Recommended priority: Complete full nullifier verifier-binding via circuit/VK regeneration
