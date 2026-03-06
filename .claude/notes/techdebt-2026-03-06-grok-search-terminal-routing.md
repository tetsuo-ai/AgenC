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
| Desktop prompt guidance remains duplicated across desktop-only and mixed-environment branches | `runtime/src/gateway/daemon.ts` (`buildDesktopContext`) | Future terminal/browser instruction changes can drift between the two prompt variants | Extract shared desktop guidance fragments if this prompt changes again |
| `ToolRouter.route()` and `ToolRouter.scoreTools()` remain large hot-path methods | `runtime/src/gateway/tool-routing.ts` | Intent-specific routing changes are safe now, but future additions raise review and regression risk | Split intent detection and tool-family scoring into named helpers before the next major routing expansion |

### Duplications Found
| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| Shared desktop terminal/browser guidance duplicated in two system-prompt branches | `runtime/src/gateway/daemon.ts` desktop-only prompt and mixed-environment desktop prompt | prompt block near `buildDesktopContext()` | Shared prompt fragment builder for desktop guidance |

### Summary
- Total issues: 2
- Estimated cleanup: 2 files
- Recommended priority: Extract shared desktop prompt fragments before the next desktop-instruction change
