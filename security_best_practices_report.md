# Security Best Practices Report

## Executive Summary
This review focused on TypeScript surfaces in `runtime/` (backend WebSocket/WebChat gateway) and `web/` (React frontend). I found **3 high-severity authorization/data-isolation issues** in WebChat memory/desktop handlers and **1 medium-severity frontend hardening issue**. The highest risk items allow a connected client to enumerate or act on other users' session/container data if the gateway is used by multiple clients.

## Critical Findings
None.

## High Severity

### SEC-001: Cross-session memory data exposure in WebChat memory handlers
- Rule ID: `EXPRESS-INPUT-001` (untrusted input + authorization boundary), `REACT/JS trust-boundary handling`
- Severity: High
- Location:
  - `runtime/src/channels/webchat/handlers.ts:389`
  - `runtime/src/channels/webchat/handlers.ts:402`
  - `runtime/src/channels/webchat/handlers.ts:436`
  - `runtime/src/channels/webchat/plugin.ts:287`
- Evidence:
  - `handleMemorySearch` enumerates sessions globally with `deps.memoryBackend.listSessions(query)` and fallback `deps.memoryBackend.listSessions()` then reads threads via `getThread(...)`.
  - `handleMemorySessions` calls `deps.memoryBackend.listSessions()` and returns metadata for each session.
  - Plugin dispatch (`handler(this.deps, payload, id, send)`) does not provide `clientId`/session ownership context to these handlers.
- Impact: A connected WebChat client can enumerate/search memory from other sessions, exposing cross-session conversation data.
- Fix:
  - Add requester identity to handler signatures (for example `clientId` and active `sessionId`).
  - Restrict `memory.search`/`memory.sessions` to the caller’s owned sessions only.
  - Enforce server-side ownership checks before returning memory entries.
- Mitigation:
  - Disable `memory.search` and `memory.sessions` over shared WebSocket channels until ownership scoping is implemented.
- False positive notes:
  - If deployment is strictly single-user localhost only, practical exploitability is lower, but issue remains in shared/multi-client scenarios.

### SEC-002: Desktop sandbox enumeration and takeover/DoS via unscoped handlers
- Rule ID: `EXPRESS-INPUT-001` (authorization for sensitive operations)
- Severity: High
- Location:
  - `runtime/src/channels/webchat/handlers.ts:667`
  - `runtime/src/channels/webchat/handlers.ts:740`
  - `runtime/src/channels/webchat/handlers.ts:770`
  - `runtime/src/channels/webchat/handlers.ts:817`
  - `runtime/src/channels/webchat/plugin.ts:287`
- Evidence:
  - `desktop.list` returns `deps.desktopManager!.listAll()`.
  - `desktop.attach` accepts arbitrary `containerId` + `sessionId` and calls `assignSession(...)`.
  - `desktop.destroy` accepts arbitrary `containerId` and calls `destroy(...)`.
  - Handler map exposes these operations directly; plugin dispatch does not apply per-client ownership checks.
- Impact: A client can enumerate other sandboxes, rebind them to another session, or destroy them, enabling cross-session hijack and denial-of-service.
- Fix:
  - Scope desktop operations to caller-owned session/container mappings.
  - Replace `listAll()` with a per-session/per-owner list endpoint.
  - Require explicit authorization before `attach`/`destroy`, validating ownership server-side.
- Mitigation:
  - Temporarily gate `desktop.attach`/`desktop.destroy` behind privileged approval/auth roles.
- False positive notes:
  - Lower impact if only one trusted local client ever connects.

### SEC-003: Unauthenticated auto-accept when `auth.secret` is unset can expose control plane if bound broadly
- Rule ID: `EXPRESS-INPUT-001` / auth baseline
- Severity: High (configuration-dependent)
- Location:
  - `runtime/src/gateway/gateway.ts:317`
  - `runtime/src/gateway/gateway.ts:342`
  - `runtime/src/gateway/gateway.ts:470`
  - `runtime/src/gateway/config-watcher.ts:141`
- Evidence:
  - WebSocket server host is configurable (`host: bind ?? "127.0.0.1"`).
  - Clients are marked authenticated when `!authSecret`.
  - `auth` message path also auto-accepts when no secret.
  - Config validation checks `gateway.bind` only as string type; no guard requiring auth when non-local bind is used.
- Impact: If operator sets `gateway.bind` to a non-local interface (e.g. `0.0.0.0`) without `auth.secret`, remote clients can access non-privileged control-plane and chat operations.
- Fix:
  - Enforce config invariant: non-loopback bind requires `auth.secret`.
  - Consider fail-closed startup when bind is non-local and auth is absent.
- Mitigation:
  - Keep bind loopback-only and set strong `auth.secret` in all non-local deployments.
- False positive notes:
  - Default loopback bind reduces exposure for local-only setups.

## Medium Severity

### SEC-004: `window.open` without `noopener,noreferrer` on URL from websocket payload
- Rule ID: `JS-REDIRECT-001` / tabnabbing hardening
- Severity: Medium
- Location:
  - `web/src/components/RightPanel.tsx:902`
  - `web/src/components/payment/PaymentView.tsx:160`
  - `web/src/hooks/useWallet.ts:72`
- Evidence:
  - UI calls `window.open(wallet.explorerUrl, '_blank')`.
  - `explorerUrl` is accepted from inbound WS payload and stored as string without validation.
- Impact: Opened page can access `window.opener` (reverse tabnabbing/phishing vector) and URL trust is not constrained to expected explorer origins.
- Fix:
  - Use `window.open(url, '_blank', 'noopener,noreferrer')` (or anchor tags with `rel="noopener noreferrer"`).
  - Validate `explorerUrl` against allowlisted `https://explorer.solana.com` style origins before opening.
- Mitigation:
  - At minimum, reject non-HTTPS and non-allowlisted hosts in `useWallet`.
- False positive notes:
  - If backend guarantees trusted explorer URL values, risk is reduced but opener protection should still be applied.

## Low Severity
None.

## Recommended Fix Order
1. Fix SEC-001 and SEC-002 first (cross-session data/control boundary violations).
2. Add startup config guard for SEC-003.
3. Apply frontend link hardening for SEC-004.
