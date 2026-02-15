# AgenC Architecture Documentation

Architecture reference for the AgenC protocol — designed to provide implementation context for AI agents working on roadmap issues.

## How to Use

- **Implementing an issue?** Start with `issue-map.json` or the relevant phase guide in `phases/`
- **Understanding the system?** Read `overview.md` then `runtime-layers.md`
- **Writing new code?** Check `guides/` for conventions and templates
- **Debugging a flow?** See the sequence diagrams in `flows/`

## Table of Contents

### System Architecture

| Document | Description |
|----------|-------------|
| [overview.md](overview.md) | System component diagram — 5 packages and their relationships |
| [runtime-layers.md](runtime-layers.md) | 7-layer module dependency diagram for the runtime |
| [interfaces.md](interfaces.md) | Class diagrams for 10 key interfaces |

### Flow Diagrams

| Document | Description |
|----------|-------------|
| [flows/task-lifecycle.md](flows/task-lifecycle.md) | create → claim → complete/cancel sequence |
| [flows/dispute-resolution.md](flows/dispute-resolution.md) | initiate → vote → resolve/slash sequence |
| [flows/agent-registration.md](flows/agent-registration.md) | register → activate → deregister state machine |
| [flows/autonomous-execution.md](flows/autonomous-execution.md) | scan → discover → execute → verify → proof |
| [flows/workflow-execution.md](flows/workflow-execution.md) | compile → sort → submit → monitor |
| [flows/zk-proof-flow.md](flows/zk-proof-flow.md) | generate → cache → submit → verify |
| [flows/speculative-execution.md](flows/speculative-execution.md) | commit → speculate → defer → rollback |

### Implementation Guides

| Document | Description |
|----------|-------------|
| [guides/new-module-template.md](guides/new-module-template.md) | Standard module structure, error codes, barrel exports |
| [guides/type-conventions.md](guides/type-conventions.md) | bigint vs BN, Uint8Array vs Buffer, etc. |
| [guides/testing-patterns.md](guides/testing-patterns.md) | Mock patterns, vitest setup, LiteSVM |
| [guides/error-handling.md](guides/error-handling.md) | RuntimeErrorCodes, error class patterns |
| [guides/integration-points.md](guides/integration-points.md) | Cross-module wiring, builder, telemetry |

### Phase Implementation Guides

| Document | Issues | Priority |
|----------|--------|----------|
| [phases/phase-01-gateway.md](phases/phase-01-gateway.md) | 12 issues (#1051-#1063) | P0 |
| [phases/phase-02-heartbeat.md](phases/phase-02-heartbeat.md) | 4 issues (#1078-#1085) | P1 |
| [phases/phase-03-skills.md](phases/phase-03-skills.md) | 6 issues (#1065-#1075) | P0 |
| [phases/phase-04-tools.md](phases/phase-04-tools.md) | 7 issues (#1067-#1077) | P0 |
| [phases/phase-05-memory.md](phases/phase-05-memory.md) | 6 issues (#1079-#1087) | P1 |
| [phases/phase-06-registry.md](phases/phase-06-registry.md) | 5 issues (#1088-#1092) | P2 |
| [phases/phase-07-multi-agent.md](phases/phase-07-multi-agent.md) | 4 issues (#1093-#1096) | P2 |
| [phases/phase-08-social.md](phases/phase-08-social.md) | 5 issues (#1097-#1105) | P2 |
| [phases/phase-09-channels-ui.md](phases/phase-09-channels-ui.md) | 4 issues (#1098-#1102) | P2 |
| [phases/phase-10-marketplace.md](phases/phase-10-marketplace.md) | 5 issues (#1106-#1110) | P3 |

### Machine-Readable Index

| File | Description |
|------|-------------|
| [issue-map.json](issue-map.json) | All 58 issues with dependencies, code locations, and phase mappings |

## Docs MCP Server

An MCP server at `docs-mcp/` serves this documentation to AI agents:

```bash
claude mcp add agenc-docs -- node docs-mcp/dist/index.js
```

Tools: `docs_search`, `docs_get_issue_context`, `docs_get_phase_graph`, `docs_get_module_template`, `docs_get_module_info`, `docs_get_conventions`
