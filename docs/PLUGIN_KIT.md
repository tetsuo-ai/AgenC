# Plugin Kit Surface

`@tetsuo-ai/plugin-kit` is owned by `agenc-plugin-kit`. The npm package is a
reserved name today: repo HEAD publishes no runtime authoring ABI
(`src/index.ts` is an empty `export {};`). The repo's working content is the
manifest-first plugin authoring contract and the `examples/hello-tool`
example plugin.

## Canonical Repo

- repo: [`agenc-plugin-kit`](https://github.com/tetsuo-ai/agenc-plugin-kit) (public)
- package: `@tetsuo-ai/plugin-kit` (npm latest `0.2.0`; repo HEAD `0.2.1`, the reserved surface)
- primary README: `agenc-plugin-kit/README.md` (sibling repo in this workspace, not tracked in this umbrella repo)
- changelog: `agenc-plugin-kit/CHANGELOG.md`

## What It Owns

The plugin-kit repo owns:

- the reserved `@tetsuo-ai/plugin-kit` package name, kept published so sibling
  repos can depend on a stable name while the production loader contract is
  finalized
- the manifest-first example plugin under `agenc-plugin-kit/examples/hello-tool/`
- the package validation scripts (API baseline check, pack smoke, and a test
  that asserts no public channel ABI exists)

The earlier channel-adapter authoring ABI, compatibility matrix, certification
harness, and starter template were removed at repo HEAD (v0.2.1) because the
live AgenC plugin loader does not consume that surface. The npm `latest`
release is still `0.2.0`, which predates that removal and still ships the old
channel-adapter exports. Do not build against those exports: they are removed
at HEAD and the runtime never consumed them.

## What Plugin Authors Can Do Today

Plugins are authored against the live manifest contract, with no package ABI
dependency. A plugin is a directory whose `.agenc-plugin/plugin.json` declares:

- plugin metadata and `userConfig` (typed, user-editable settings)
- prompt `commands` sourced from markdown files
- `mcpServers`, for example a local stdio MCP tool server, with
  `${AGENC_PLUGIN_ROOT}` and `${user_config.*}` substitutions

`examples/hello-tool/` is the working reference:

- `.agenc-plugin/plugin.json` declares the manifest
- `commands/hello.md` loads as the `hello-tool:hello` prompt command
- `tools/hello-tool-server.mjs` exposes the `say_hello` MCP tool over stdio
- `npm run self-test` (from `examples/hello-tool/`) prints
  `hello-tool-self-test-ok`

To use a plugin locally, point AgenC at the plugin directory through a plugin
dir configuration or copy it into one of the local plugin roots that AgenC
scans.

## What Is Not Published Yet

There is no published runtime authoring ABI. New public plugin APIs land in
this package only after `agenc-core` uses the same contract in production.
Until then, treat `@tetsuo-ai/plugin-kit` imports as unavailable and author
against the `.agenc-plugin/plugin.json` manifest instead.

## When To Use It

Use the `agenc-plugin-kit` repo when you are:

- authoring a manifest-first plugin (start by copying `examples/hello-tool/`)
- checking the current `.agenc-plugin/plugin.json` contract fields
- depending on the `@tetsuo-ai/plugin-kit` package name from a sibling repo

The runtime host implementation (the live plugin loader) lives in
`agenc-core`.

## Validation

From `agenc-plugin-kit/`:

```bash
npm run build
npm run typecheck
npm run test
npm run api:baseline:check
npm run pack:smoke
```

`npm run test` asserts the reserved surface stays empty
(`no-public-channel-abi-ok`) and that the hello-tool example stays valid
(`hello-tool-example-ok`).

From `agenc-plugin-kit/examples/hello-tool/`:

```bash
npm run self-test
```

## Related Docs

- [VERSION_DOCS_MAP.md](./VERSION_DOCS_MAP.md)
- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)
- [DOCS_INDEX.md](./DOCS_INDEX.md)
