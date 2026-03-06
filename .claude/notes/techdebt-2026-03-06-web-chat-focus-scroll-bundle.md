## Tech Debt Report - 2026-03-06

### Critical (Fix Now)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| None | — | — | — |

### High (Fix This Sprint)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| None | — | — | — |

### Medium (Backlog)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Auto-scroll stickiness logic now exists in both chat and activity feeds | `web/src/components/chat/MessageList.tsx`, `web/src/components/activity/ActivityFeedView.tsx` | Future threshold or scroll-follow changes could drift between the two surfaces | Extract a shared scroll-follow hook if either component changes again |
| The composer-focus restore helper lives in `App.tsx` rather than a reusable UI utility | `web/src/App.tsx` | If other overlays start auto-opening, focus restoration logic may get copied instead of reused | Extract a small focus-preservation helper if another auto-open/focus case appears |

### Duplications Found
| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| Near-identical stick-to-bottom scroll logic | `web/src/components/chat/MessageList.tsx`, `web/src/components/activity/ActivityFeedView.tsx` | component-local scroll handler/effect blocks | Shared `useStickToBottom` hook |

### Summary
- Total issues: 2
- Estimated cleanup: 3 files
- Recommended priority: Extract a shared scroll-follow hook if either feed changes again
