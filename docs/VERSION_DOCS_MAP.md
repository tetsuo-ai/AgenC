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

## @tetsuo-ai/sdk v1.3.1

- Canonical repo: `https://github.com/tetsuo-ai/agenc-sdk`
- README: `https://github.com/tetsuo-ai/agenc-sdk/blob/main/README.md`
- Changelog: `https://github.com/tetsuo-ai/agenc-sdk/blob/main/CHANGELOG.md`
- Entry point: `https://github.com/tetsuo-ai/agenc-sdk/blob/main/src/index.ts`
- API baseline: `https://github.com/tetsuo-ai/agenc-sdk/blob/main/docs/api-baseline/sdk.json`
- Public exports: see `https://github.com/tetsuo-ai/agenc-sdk/blob/main/docs/api-baseline/sdk.json`

## @tetsuo-ai/plugin-kit v0.1.1

- Canonical repo: `https://github.com/tetsuo-ai/agenc-plugin-kit`
- README: `https://github.com/tetsuo-ai/agenc-plugin-kit/blob/main/README.md`
- Changelog: `https://github.com/tetsuo-ai/agenc-plugin-kit/blob/main/CHANGELOG.md`
- Entry point: `https://github.com/tetsuo-ai/agenc-plugin-kit/blob/main/src/index.ts`
- API baseline: `https://github.com/tetsuo-ai/agenc-plugin-kit/blob/main/docs/api-baseline/plugin-kit.json`
- Public exports: see `https://github.com/tetsuo-ai/agenc-plugin-kit/blob/main/docs/api-baseline/plugin-kit.json`

## @tetsuo-ai/runtime v0.1.0

- Classification: Transitional private-kernel artifact; not a supported public builder target
- Distribution policy: `docs/PRIVATE_KERNEL_DISTRIBUTION.md`
- README: `runtime/README.md`
- Changelog: `runtime/CHANGELOG.md`
- Entry point: `runtime/src/index.ts`
- API baseline: `docs/api-baseline/runtime.json`
- Public exports: see `docs/api-baseline/runtime.json`
- Migration guidance: external builders should target `@tetsuo-ai/sdk`, `@tetsuo-ai/protocol`, or `@tetsuo-ai/plugin-kit`

## @tetsuo-ai/mcp v0.1.0

- Classification: Transitional private-kernel artifact; not a supported public extension target
- Distribution policy: `docs/PRIVATE_KERNEL_DISTRIBUTION.md`
- README: `mcp/README.md`
- Changelog: `mcp/CHANGELOG.md`
- Entry point: `mcp/src/index.ts`
- API baseline: `docs/api-baseline/mcp.json`
- Public exports: (server binary); see `docs/api-baseline/mcp.json`
- Migration guidance: external builders should extend AgenC through `@tetsuo-ai/plugin-kit` and the public SDK/protocol surfaces
