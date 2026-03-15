# Gate 6 — Desktop Platform Contract Stabilization

> Produced by the refactor program. Documents the desktop platform as an explicit contract boundary.

---

## 1. Control Contract

### 1.1 Container Lifecycle

**Manager:** `runtime/src/desktop/manager.ts` (1,072 lines, 871 test lines)

| Operation | Method | Contract |
|-----------|--------|----------|
| Create sandbox | `DesktopSandboxManager.create(options)` | `CreateDesktopSandboxOptions` → `DesktopSandboxHandle` |
| Destroy sandbox | `DesktopSandboxManager.destroy(sessionId)` | Session ID → void |
| List sandboxes | `DesktopSandboxManager.listAll()` | → `DesktopSandboxInfo[]` |
| Get sandbox | `DesktopSandboxManager.get(sessionId)` | Session ID → `DesktopSandboxHandle \| undefined` |
| Touch (activity) | `DesktopSandboxManager.touch(sessionId)` | Updates `lastActivityAt` |
| Start watchdog | `DesktopSandboxManager.startWatchdog()` | Begins idle/lifetime checks |
| Stop all | `DesktopSandboxManager.destroyAll()` | Cleanup on shutdown |

**Config:** `DesktopSandboxConfig` (14 typed fields, `defaultDesktopSandboxConfig()` factory)

### 1.2 Status Lifecycle (LOCKED)

```
creating → starting → ready → unhealthy → stopping → stopped
                                   ↑           ↓
                                   └───────────┘ (restart)
Any → failed (unrecoverable)
```

Type: `DesktopSandboxStatus` = 7 states

---

## 2. Event Contract

**Bridge:** `runtime/src/desktop/rest-bridge.ts` (422 lines, 328 test lines)

| Event | Type | Payload |
|-------|------|---------|
| Tool result | `DesktopBridgeEvent` | Tool name, result, duration |
| Health status | via `DesktopSandboxWatchdog` | Status changes |
| Error | via bridge error handler | Error details |

**Bridge options:** `DesktopRESTBridgeOptions` interface

---

## 3. Auth/Identity Contract

**Source:** `runtime/src/desktop/auth.ts` (17 lines)

| Export | Purpose |
|--------|---------|
| `DESKTOP_AUTH_ENV_KEY` = `"DESKTOP_AUTH_TOKEN"` | Env var name for auth token |
| `createDesktopAuthToken()` | Generates random token for container |
| `createDesktopAuthHeaders(containerName)` | Creates auth header set |

**Container side:** `containers/desktop/server/src/auth.ts` (15 lines)
- Reads `DESKTOP_AUTH_TOKEN` env var at startup
- Validates bearer tokens in request headers

**Contract:** Runtime generates token → passes via Docker env → container validates per-request. Stateless header-based auth.

---

## 4. Managed-Process Lifecycle Contract

**Container tools:** `process_start`, `process_status`, `process_stop` in `toolDefinitions.ts`

| Tool | Input | Output |
|------|-------|--------|
| `process_start` | `{ command, args?, env? }` | `{ pid, name }` |
| `process_status` | `{ pid }` | `{ pid, running, exitCode? }` |
| `process_stop` | `{ pid, signal? }` | `{ stopped, exitCode? }` |

**Execution:** `containers/desktop/server/src/tools.ts` (1,923 lines)
- PID tracking via in-memory registry
- Cleanup on container stop

---

## 5. Watchdog/Recovery Contract

**Watchdog:** `runtime/src/desktop/health.ts` (174 lines, 254 test lines)

| Config | Default | Purpose |
|--------|---------|---------|
| `healthCheckIntervalMs` | 30,000 | Check frequency |
| `idleTimeoutMs` | 1,800,000 (30 min) | Auto-destroy idle containers |
| `maxLifetimeMs` | 14,400,000 (4 hours) | Max container lifetime |

**Recovery:**
- Health check hits container `/health` endpoint
- Status `ready` → `unhealthy` on failed health check
- Consecutive failures trigger container restart or destroy
- `DesktopSandboxWatchdog` class with `start()/stop()` lifecycle

---

## 6. Tool-Catalog Generation Contract

**Source of truth:** `containers/desktop/server/src/toolDefinitions.ts` (335 lines, 19 tools)

**Codegen pipeline:**
```
toolDefinitions.ts (container, 19 tools)
    ↓ runtime/scripts/generate-desktop-tool-definitions.ts
tool-definitions.ts (runtime mirror, 431 lines)
```

**19 tools:** screenshot, mouse_click, mouse_move, mouse_drag, mouse_scroll, keyboard_type, keyboard_key, bash, process_start, process_status, process_stop, window_list, window_focus, clipboard_get, clipboard_set, screen_size, text_editor, video_start, video_stop

**Contract:** Container `toolDefinitions.ts` is the source of truth. Runtime mirror is generated. Never edit the runtime mirror directly.

---

## 7. Health/Feature Negotiation Contract

**Container health endpoint:** `GET /health`

| Field | Type | Purpose |
|-------|------|---------|
| `status` | `"ok"` | Ready status |
| `display` | `string` | X11 display number |
| `uptime` | `number` | Container uptime in seconds |

**Current gap:** No version, schema-hash, or catalog-hash in health response. The container returns minimal health data. Feature negotiation is aspirational — containers respond with tool catalog via `GET /tools`.

**Tool discovery:** `GET /tools` → array of tool definitions with JSON schemas

**Contract:** Runtime discovers tools via `/tools` endpoint. Health is checked via `/health`. No version negotiation exists today.

---

## 8. Image/Version Compatibility Contract

**Container image:** `agenc/desktop:latest`

| Component | Version | Source |
|-----------|---------|--------|
| Ubuntu | 24.04 | Dockerfile |
| XFCE4 | distro default | Dockerfile |
| Node.js | 20 | Dockerfile |
| Supervisord | 6 processes | supervisord.conf |
| REST API port | 9990 | server/src/index.ts |
| VNC port | 6080 (noVNC) | Dockerfile |
| Seccomp profile | x86_64 + aarch64 | seccomp.json |
| Non-root user | `agenc` | Dockerfile |

**Compatibility contract:** Runtime expects:
1. `/health` returns `{ status: "ok" }` on port 9990
2. `/tools` returns tool definitions array on port 9990
3. `POST /tools/:name` executes tools on port 9990
4. Port 6080 serves noVNC viewer

**No version pinning mechanism exists.** The image tag is `latest`. Versioning is aspirational.

---

## 9. Session Router Contract

**Router:** `runtime/src/desktop/session-router.ts` (1,257 lines, 1,104 test lines)

| Export | Purpose |
|--------|---------|
| `createDesktopAwareToolHandler(options)` | Creates a tool handler that routes desktop/playwright/MCP tools to containers |
| `getCachedDesktopToolDefinitions()` | Returns cached desktop tools |
| `getCachedPlaywrightToolDefinitions()` | Returns cached Playwright tools |
| `getCachedContainerMCPToolDefinitions()` | Returns cached container MCP tools |
| `destroySessionBridge(sessionId)` | Cleanup per-session bridges |

**Options:** `DesktopRouterOptions` interface

**TUI guard:** Blocks 22 interactive terminal apps (vim, nano, tmux, etc.) unless backgrounded

**Routing decision:**
1. Tool name matches desktop catalog → route to container REST API
2. Tool name starts with `playwright.` → route to Playwright MCP bridge in container
3. Tool name matches container MCP → route to container MCP bridge
4. Otherwise → route to base handler (host tools)

---

## 10. Desktop Platform Boundary Summary

| Contract | Module | Lines | Tests | Status |
|----------|--------|-------|-------|--------|
| Control (lifecycle) | `manager.ts` | 1,072 | 871 | Explicit types, tested |
| Events | `rest-bridge.ts` | 422 | 328 | Bridge interface defined |
| Auth/Identity | `auth.ts` (runtime+container) | 32 | Via bridge tests | Stateless token-based |
| Managed-Process | `tools.ts` (container) | 1,923 | 312 | 3 process tools |
| Watchdog/Recovery | `health.ts` | 174 | 254 | Config-driven |
| Tool-Catalog Generation | `toolDefinitions.ts` → codegen | 335+431 | N/A | Source-of-truth pipeline |
| Health/Feature | Container `/health` + `/tools` | In server | 142 | Minimal (no version) |
| Image/Version | Dockerfile + supervisord | N/A | N/A | Tag-based, no pinning |
| Session Router | `session-router.ts` | 1,257 | 1,104 | Routing + TUI guard |

**Total desktop platform surface:** ~9.6k lines across runtime + container, ~3k lines of tests.

---

*Gate 6 exit criterion: "desktop can be reasoned about as a platform boundary rather than a runtime-internal assumption" — SATISFIED.*

*All 8 required contracts documented with explicit types, interfaces, and module boundaries. Two gaps identified (health version negotiation, image version pinning) but these are enhancement items, not contract ambiguity — the current contracts are explicit about what they provide and what they don't.*
