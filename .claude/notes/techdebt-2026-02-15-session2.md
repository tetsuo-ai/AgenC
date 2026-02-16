## Tech Debt Report - 2026-02-15 (Session 2)

**Scope:** `runtime/src/skills/markdown/` — SKILL.md parser (#1065)

### Critical (Fix Now)

None.

### High (Fix This Sprint)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| `isRecord()` duplication | `manifest.ts:91`, `catalog.ts:70` | 2 identical copies of the same type guard | Extract to `utils/validation.ts` |

### Medium (Backlog)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| `parseSequence()` length | `markdown/parser.ts:247-309` | 63 lines, handles simple + object array items | Split into `parseSimpleItem()` + `parseObjectItem()` |
| Type-safe accessor pattern | `markdown/parser.ts:386-411` | 4 accessor helpers potentially reusable elsewhere | Extract to shared utils if reuse emerges |
| Silent frontmatter failure | `markdown/parser.ts:116-118` | Missing closing `---` silently treats all content as frontmatter | Documented behavior; consider warning if logger available |
| Validation error type divergence | `manifest.ts` vs `markdown/parser.ts` | `ManifestValidationError` vs `SkillParseError` — different shapes | Standardize if integration point emerges |

### Duplications Found

| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| `isRecord()` type guard | `manifest.ts:91`, `catalog.ts:70` | 3 each | `utils/validation.ts` |
| `isStringArray()` / `getStringArray()` | `manifest.ts:95`, `markdown/parser.ts:407` | Similar purpose, different API | Unify if shared module created |

### Summary

- Total issues: 5
- Critical: 0
- High: 1 (pre-existing `isRecord` duplication)
- Medium: 4
- No TODO/FIXME/HACK comments
- No unused imports or dead code
- No magic numbers (constants properly centralized)
- Test coverage: 17 tests, good happy-path coverage; internal parser functions tested indirectly
