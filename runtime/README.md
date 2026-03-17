# @tetsuo-ai/runtime

Private kernel package for AgenC.

`@tetsuo-ai/runtime` is the current operator/runtime baseline for `agenc-core`. It remains in this repository for kernel contributors and for the existing transitional compatibility window, but it is not a supported public builder target.

Canonical private-kernel distribution and support-window policy lives in [docs/PRIVATE_KERNEL_DISTRIBUTION.md](../docs/PRIVATE_KERNEL_DISTRIBUTION.md).

External builders should use:

- `@tetsuo-ai/sdk` for TypeScript integration
- `@tetsuo-ai/protocol` for released protocol artifacts
- `@tetsuo-ai/plugin-kit` for approved plugin and adapter development

## Internal Development

```bash
npm --prefix runtime install
npm --prefix runtime run build
npm --prefix runtime test
npm --prefix runtime run typecheck
```

Useful internal entrypoints:

- `runtime/dist/bin/agenc.js`
- `runtime/dist/bin/agenc-runtime.js`
- `runtime/dist/bin/agenc-watch.js`
- `@tetsuo-ai/runtime/operator-events`

For broader operator and architecture context, start with the root [README](../README.md), [docs/RUNTIME_API.md](../docs/RUNTIME_API.md), and [REFACTOR.MD](../REFACTOR.MD).
