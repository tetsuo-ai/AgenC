# @tetsuo-ai/docs-mcp

MCP server serving AgenC documentation, contract artifacts, and runtime-scoped helper context to AI agents.

## Overview

This server indexes repo documentation and selected machine-readable contract artifacts as MCP tools and resources. It enables AI agents to:

- Search repo docs, planning docs, runtime docs, and contract artifacts
- Read per-file indexed resources from the current repository docs
- Get runtime module templates and coding conventions when runtime-specific guidance is needed

Indexed corpus:

- `docs/**/*.md`
- `docs/**/*.json`
- `runtime/docs/**/*.md`
- `runtime/idl/**/*.json`
- `runtime/benchmarks/**/*.json`
- `scripts/idl/**/*.json`
- package-local docs and changelogs under top-level packages, apps, platforms, programs, migrations, and `examples/**` when present
- root docs: `README.md`, `AGENTS.md`, `CODEX.md`, `REFACTOR.MD`, and `REFACTOR-MASTER-PROGRAM.md` when present

Important limits:

- This server indexes documentation and contract artifacts, not source code.
- Legacy runtime-roadmap issue/phase prompts, tools, and special aggregate resources are intentionally not registered.
- Retired roadmap and issue-map docs are not part of the indexed planning surface.
- `docs_get_module_template`, `docs_get_module_info`, and `docs_get_conventions` are runtime-scoped helpers, not whole-repository architecture tools.

## Usage

```bash
# Build
cd docs-mcp && npm install && npm run build

# Add to Claude Code
claude mcp add agenc-docs -- node /path/to/AgenC/docs-mcp/dist/index.cjs

# Or with custom docs root
claude mcp add agenc-docs -e DOCS_ROOT=/path/to/AgenC -- node /path/to/AgenC/docs-mcp/dist/index.cjs
```

## Tools

| Tool | Description |
|------|-------------|
| `docs_search` | Full-text search across repo docs, planning docs, runtime docs, and contract artifacts |
| `docs_get_module_template` | Runtime-module boilerplate helper; not whole-repository planning authority |
| `docs_get_module_info` | Runtime-module architecture helper; not whole-repository planning authority |
| `docs_get_conventions` | Runtime implementation conventions helper; not whole-repository planning authority |

## Resources

Indexed docs and contract artifacts are exposed as MCP resources. Resource prefixes include:

- `agenc-docs://architecture/...` for `docs/architecture/**`
- `agenc-docs://docs/...` for other `docs/**` content
- `agenc-docs://runtime-docs/...` for `runtime/docs/**`
- `agenc-docs://repo/...` for indexed repo-root docs and other indexed non-`docs/` surfaces

Special aggregate resources:
- `agenc-docs://conventions` — all guide docs concatenated
- `agenc-docs://scope` — indexed scope manifest and current limits

Whole-repository planning authority comes from the indexed docs themselves, especially `REFACTOR.MD` and `REFACTOR-MASTER-PROGRAM.md`, which remain available through ordinary search and resource reads.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_ROOT` | Auto-detected (walks up to `Anchor.toml`) | Path to repo root |

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `zod` — Input validation
- `node:fs`, `node:path` — File system access (zero external deps beyond MCP SDK)
