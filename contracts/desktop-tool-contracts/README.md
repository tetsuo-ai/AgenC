# Desktop Tool Contracts

Canonical desktop tool-definition contract shared by the AgenC runtime and desktop server.

This package is part of the private kernel boundary. It is an internal handoff contract between `agenc-core` runtime and the desktop server, not a supported public plugin or builder API.

Canonical private-kernel distribution policy lives in [docs/PRIVATE_KERNEL_DISTRIBUTION.md](../../docs/PRIVATE_KERNEL_DISTRIBUTION.md). Canonical runtime-side deprecation and support-window policy lives in [docs/PRIVATE_KERNEL_SUPPORT_POLICY.md](../../docs/PRIVATE_KERNEL_SUPPORT_POLICY.md).

This package is the source of truth for:

- `DesktopToolDefinition`
- `TOOL_DEFINITIONS`

It exists to prevent repo-relative artifact handoff between the runtime and the desktop server.

Internal contributors can build it with:

```bash
npm --prefix contracts/desktop-tool-contracts install
npm --prefix contracts/desktop-tool-contracts run build
```
