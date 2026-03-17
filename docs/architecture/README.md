# AgenC Architecture Documentation

Architecture reference for AgenC protocol and runtime surfaces. These docs are implementation reference, not the whole-repository planning authority.

## How to Use

- **Planning whole-repository refactor work?** Start with [REFACTOR.MD](../../REFACTOR.MD) and [REFACTOR-MASTER-PROGRAM.md](../../REFACTOR-MASTER-PROGRAM.md)
- **Reading legacy runtime roadmap material?** Use the relevant phase guide in `phases/` as historical runtime-scoped reference only
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

### Architecture Decisions

| Document | Description |
|----------|-------------|
| [adr/adr-001-durable-task-runtime.md](adr/adr-001-durable-task-runtime.md) | Canonical durable task runtime contract, lifecycle semantics, and invariants |

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
| [flows/runtime-chat-pipeline.md](flows/runtime-chat-pipeline.md) | prompt assembly → tool loop → fallback/retry → stop reasons |
| [flows/subagent-orchestration.md](flows/subagent-orchestration.md) | planner DAG delegation → child orchestration → verifier/synthesis |

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

## Docs MCP Server

An MCP server at `docs-mcp/` serves this documentation to AI agents:

```bash
claude mcp add agenc-docs -- node docs-mcp/dist/index.js
```

Current tools: `docs_search`, `docs_get_module_template`, `docs_get_module_info`, `docs_get_conventions`

`docs_search` plus the indexed docs/resources are the primary access path. The remaining helper tools are runtime-scoped and are not authoritative for whole-repository planning.
