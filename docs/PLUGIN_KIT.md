# Plugin Kit Surface

`@tetsuo-ai/plugin-kit` is owned by `agenc-plugin-kit`.

## Canonical Repo

- repo: `agenc-plugin-kit`
- package: `@tetsuo-ai/plugin-kit`
- primary README: [`agenc-plugin-kit/README.md`](../agenc-plugin-kit/README.md)
- changelog: [`agenc-plugin-kit/CHANGELOG.md`](../agenc-plugin-kit/CHANGELOG.md)

## What It Owns

The plugin-kit repo owns:

- the published plugin authoring ABI
- the compatibility matrix
- the certification/conformance harness
- the channel-adapter starter template

Main source modules:

- `certification.ts`
- `channel-host-matrix.ts`
- `channel-manifest.ts`
- `channel-runtime.ts`
- `compatibility.ts`
- `errors.ts`
- `index.ts`

Starter template:

- [`agenc-plugin-kit/templates/channel-adapter-starter/README.md`](../agenc-plugin-kit/templates/channel-adapter-starter/README.md)

## When To Use It

Use `@tetsuo-ai/plugin-kit` when you are:

- authoring plugin/add-on packages
- validating manifests or runtime contracts
- using the published compatibility matrix
- running the certification harness

The runtime host implementation lives in `agenc-core`. The public authoring
contract lives in `agenc-plugin-kit`.

## Validation

From `agenc-plugin-kit/`:

```bash
npm run build
npm run typecheck
npm run test
npm run api:baseline:check
npm run pack:smoke
```

## Related Docs

- [VERSION_DOCS_MAP.md](./VERSION_DOCS_MAP.md)
- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)
- [DOCS_INDEX.md](./DOCS_INDEX.md)
