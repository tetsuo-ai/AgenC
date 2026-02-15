# @agenc/docs-mcp

MCP server serving AgenC architecture documentation and issue context to AI agents.

## Overview

This server provides architecture knowledge from `docs/architecture/` as MCP tools, resources, and prompts. It enables AI agents to:

- Search architecture documentation
- Get implementation context for specific roadmap issues
- View phase dependency graphs and implementation orders
- Get module templates and coding conventions

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
| `docs_search` | Full-text search across architecture docs |
| `docs_get_issue_context` | Implementation context for a specific issue (#1051-#1110) |
| `docs_get_phase_graph` | Dependency graph + implementation order for a phase (1-10) |
| `docs_get_module_template` | Boilerplate template for creating a new runtime module |
| `docs_get_module_info` | Architecture details about an existing runtime module |
| `docs_get_conventions` | Type, testing, and error handling conventions |

## Prompts

| Prompt | Description |
|--------|-------------|
| `implement-issue` | 10-step guided implementation workflow for a specific issue |
| `explore-phase` | Phase exploration before starting implementation |

## Resources

Each `docs/architecture/*.md` file is exposed as an MCP resource at `agenc-docs://architecture/<path>`.

Special aggregate resources:
- `agenc-docs://issue-map` — full issue-map.json
- `agenc-docs://roadmap` — full ROADMAP.md
- `agenc-docs://conventions` — all guide docs concatenated

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCS_ROOT` | Auto-detected (walks up to `Anchor.toml`) | Path to repo root |

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `zod` — Input validation
- `node:fs`, `node:path` — File system access (zero external deps beyond MCP SDK)
