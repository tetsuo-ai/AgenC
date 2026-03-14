# @agenc/docs-mcp

MCP server serving AgenC documentation, architecture references, and contract artifacts to AI agents.

## Overview

This server indexes repo documentation and selected machine-readable contract artifacts as MCP tools, resources, and prompts. It enables AI agents to:

- Search repo docs, planning docs, runtime docs, and contract artifacts
- Get implementation context for specific roadmap issues
- View phase dependency graphs and implementation orders
- Get runtime module templates and coding conventions

Indexed corpus:

- `docs/**/*.md`
- `docs/**/*.json`
- `runtime/docs/**/*.md`
- `runtime/idl/**/*.json`
- `runtime/benchmarks/**/*.json`
- `scripts/idl/**/*.json`
- package-local docs and changelogs under top-level packages, apps, platforms, programs, migrations, and `examples/**` when present
- root docs: `README.md`, `AGENTS.md`, `CODEX.md`, and `REFACTOR-MASTER-PROGRAM.md` when present

Important limits:

- This server indexes documentation and contract artifacts, not source code.
- `docs_get_issue_context` and `docs_get_phase_graph` still derive from `docs/architecture/issue-map.json` and `docs/ROADMAP.md`, and currently expose only the legacy runtime-roadmap issue/phase model.
- `docs_get_module_template` and `docs_get_module_info` are runtime-module helpers, not whole-repository architecture tools.

## Usage

```bash
# Build
cd docs-mcp && npm install && npm run build

# Add to Claude Code
claude mcp add agenc-docs -- node /path/to/AgenC/docs-mcp/dist/index.js

# Or with custom docs root
claude mcp add agenc-docs -e DOCS_ROOT=/path/to/AgenC -- node /path/to/AgenC/docs-mcp/dist/index.js
```

## Tools

| Tool | Description |
|------|-------------|
| `docs_search` | Full-text search across repo docs, planning docs, runtime docs, and contract artifacts |
| `docs_get_issue_context` | Implementation context for a specific legacy runtime-roadmap issue (#1051-#1110) |
| `docs_get_phase_graph` | Dependency graph + implementation order for a legacy runtime-roadmap phase (1-10) |
| `docs_get_module_template` | Boilerplate template for creating a new runtime module |
| `docs_get_module_info` | Architecture details about an existing runtime module |
| `docs_get_conventions` | Type, testing, and error handling conventions |

## Prompts

| Prompt | Description |
|--------|-------------|
| `implement-issue` | 10-step guided implementation workflow for a specific issue |
| `explore-phase` | Phase exploration before starting implementation |

## Resources

Indexed docs and contract artifacts are exposed as MCP resources. Resource prefixes include:

- `agenc-docs://architecture/...` for `docs/architecture/**`
- `agenc-docs://docs/...` for other `docs/**` content
- `agenc-docs://runtime-docs/...` for `runtime/docs/**`
- `agenc-docs://repo/...` for indexed repo-root docs and other indexed non-`docs/` surfaces

Special aggregate resources:
- `agenc-docs://issue-map` — full issue-map.json
- `agenc-docs://roadmap` — full ROADMAP.md
- `agenc-docs://conventions` — all guide docs concatenated
- `agenc-docs://scope` — indexed scope manifest and current limits

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_ROOT` | Auto-detected (walks up to `Anchor.toml`) | Path to repo root |

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `zod` — Input validation
- `node:fs`, `node:path` — File system access (zero external deps beyond MCP SDK)
