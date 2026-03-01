# PMLL Memory MCP Server

> **Short-term KV context memory and Q-promise deduplication for Claude Sonnet/Opus agent tasks.**

[![PyPI](https://img.shields.io/pypi/v/pmll-memory-mcp)](https://pypi.org/project/pmll-memory-mcp/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](../../LICENSE)
[![Python ≥ 3.11](https://img.shields.io/badge/python-%3E%3D3.11-blue)](https://www.python.org/)

---

## What it does

`pmll-memory-mcp` is a **Model Context Protocol (MCP) server** that gives Claude Sonnet/Opus agents a fast, session-isolated, short-term KV memory layer.  It is designed to be the **3rd initializer** alongside Playwright and other MCP tools — loaded once at the start of every agent task.

The server exposes five tools (`init`, `peek`, `set`, `resolve`, `flush`) that agents use to:

- **Cache** the results of expensive MCP tool calls (Playwright navigations, API fetches, …).
- **Deduplicate** redundant initializations by checking the cache before every tool invocation.
- **Chain async continuations** via a Q-promise registry so parallel agent subtasks don't repeat the same work.

---

## Installation

### Via pip

```bash
pip install pmll-memory-mcp
# or pin the version
pip install pmll-memory-mcp==0.1.0
```

### Via `uvx` (recommended — no install needed)

```bash
uvx pmll-memory-mcp
```

### From source (this directory)

```bash
cd mcp/pmll-memory-mcp
pip install -e .
pmll-memory-mcp          # starts the stdio MCP server
```

---

## MCP Client Configuration

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "pmll-memory-mcp": {
      "command": "uvx",
      "args": ["pmll-memory-mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pmll-memory-mcp": {
      "command": "pmll-memory-mcp"
    }
  }
}
```

---

## Tools reference

| Tool      | Input                                              | Output                                                      | Description                                       |
|-----------|----------------------------------------------------|-------------------------------------------------------------|---------------------------------------------------|
| `init`    | `session_id: str`, `silo_size: int = 256`          | `{status, session_id, silo_size}`                           | Set up PMLL silo + Q-promise chain for session    |
| `peek`    | `session_id: str`, `key: str`                      | `{hit, value?, index?}` or `{hit, status, promise_id}`      | Non-destructive cache + promise check             |
| `set`     | `session_id: str`, `key: str`, `value: str`        | `{status: "stored", index}`                                 | Store KV pair in the silo                         |
| `resolve` | `session_id: str`, `promise_id: str`               | `{status: "resolved"\|"pending", payload?}`                 | Check/resolve a Q-promise continuation            |
| `flush`   | `session_id: str`                                  | `{status: "flushed", cleared_count}`                        | Clear all silo slots at task completion           |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  pmll-memory-mcp                    │
│                                                     │
│  server.py  ──►  peek_context()  ──►  kv_store.py  │
│                       │                             │
│                       └──────────►  q_promise_bridge│
└─────────────────────────────────────────────────────┘
```

The server is **pure Python** — no C compilation is required at runtime.

| Python module           | Mirrors                              | Key C primitives                    |
|-------------------------|--------------------------------------|-------------------------------------|
| `kv_store.PMMemoryStore`| `PMLL.h::memory_silo_t`              | `init_silo()`, `update_silo()`      |
| `q_promise_bridge`      | `Q_promises.h::QMemNode`             | `q_mem_create_chain()`, `q_then()`  |
| `peek.peek_context()`   | Recursive conflict check in PMLL     | `check_conflict()`, `pml_refine()`  |

---

## Running tests

```bash
cd mcp/pmll-memory-mcp
pip install -e ".[dev]" 2>/dev/null || pip install -e .
python -m pytest tests/ -v
```

---

## Upstream

- **PyPI:** <https://pypi.org/project/pmll-memory-mcp/>
- **Source:** <https://github.com/drQedwards/PPM/tree/main/mcp>
