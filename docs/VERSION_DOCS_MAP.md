# Version-to-Documentation Mapping

This file maps each published package version to its primary documentation and public API surface.
It is intended to make releases auditable and to prevent undocumented breaking changes (issue #983).

## Deprecation notice template

Use this template when deprecating public symbols:

```ts
/**
 * @deprecated Since v<version>. Use {@link <replacement>} instead.
 * Will be removed in v<removal_version>.
 * See: https://github.com/tetsuo-ai/AgenC/issues/<issue>
 */
```

Changelog entry template:

```md
### Deprecated
- `<symbolName>` in `<filePath>` — use `<replacement>` instead. Removal planned for v<version>. (#<issue>)
```

## @agenc/sdk v1.3.0

- README: `sdk/README.md`
- Changelog: `sdk/CHANGELOG.md`
- Entry point: `sdk/src/index.ts`
- API baseline: `docs/api-baseline/sdk.json`
- Public exports: see `docs/api-baseline/sdk.json`

## @agenc/runtime v0.1.0

- README: `runtime/README.md`
- Changelog: `runtime/CHANGELOG.md`
- Entry point: `runtime/src/index.ts`
- API baseline: `docs/api-baseline/runtime.json`
- Public exports: see `docs/api-baseline/runtime.json`

## @agenc/mcp v0.1.0

- README: `mcp/README.md`
- Changelog: `mcp/CHANGELOG.md`
- Entry point: `mcp/src/index.ts`
- API baseline: `docs/api-baseline/mcp.json`
- Public exports: (server binary); see `docs/api-baseline/mcp.json`

