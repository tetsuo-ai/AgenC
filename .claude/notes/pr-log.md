## PR #1410: complete phase 4 and 5 runtime hardening
- **Date:** 2026-03-07
- **Files changed:** `runtime/src/llm/{provider-capabilities.ts,index.ts,types.ts,grok/adapter.ts,grok/types.ts,ollama/adapter.ts,ollama/adapter.test.ts,ollama/types.ts,chat-executor-recovery.ts,chat-executor-recovery.test.ts}`, `runtime/src/tools/system/{handle-contract.ts,handle-contract.test.ts,handle-contract.test-utils.ts,process.ts,process.test.ts,server.ts,server.test.ts,remote-job.ts,remote-job.test.ts,research.ts,research.test.ts,sandbox-handle.ts,sandbox-handle.test.ts,browser-session.ts,types.ts,index.ts}`, `runtime/src/gateway/{daemon.ts,tool-routing.ts,tool-routing.test.ts,tool-environment-policy.ts,tool-environment-policy.test.ts}`, `runtime/src/{index.ts,tools/index.ts}`, `docs/INCIDENT_REPLAY_RUNBOOK.md`, `.claude/notes/{gotchas.md,phase4-phase5-remaining-checklist.md,techdebt-2026-03-07-phase4-phase5-checklist-completion.md}`, and `TODO.MD` remained intentionally uncommitted.
- **What worked:** Phase 4 provider compaction/replay gating and Phase 5 long-lived handle completion now line up with the real runtime surface. The live daemon path now prefers `system.sandbox*` in desktop mode, fast-exit sandbox jobs surface terminal output correctly, and the provider/stateful/runtime contract has explicit capability and fallback semantics across supported and unsupported adapters.
- **What didn't:** The only remaining follow-up in this slice is documentation polish for the new bounded log-settle controls. Runtime correctness, replay gates, and the checklist-completion scope are clean.
- **Rule added to CLAUDE.md:** no

## PR [pending]: add phase 5 desktop process debt note
- **Date:** 2026-03-07
- **Files changed:** `.claude/notes/pr-log.md`, `.claude/notes/techdebt-2026-03-08-phase5-desktop-process-handle-contract.md`
- **What worked:** The Phase 5 desktop managed-process contract cleanup now has a committed debt note alongside the shipped runtime/code changes, instead of existing only as a local ignored artifact.
- **What didn't:** This is documentation-only follow-up, so there is no additional product-surface behavior or validation beyond keeping the notes history complete.
- **Rule added to CLAUDE.md:** no

## PR [pending]: durable task runtime foundation and phase 5 contract hardening
- **Date:** 2026-03-07
- **Files changed:** `runtime/src/gateway/{agent-run-contract.ts,background-run-store.ts,background-run-supervisor.ts,background-run-wake-bus.ts,background-run-wake-adapters.ts,run-domains.ts,webhooks.ts,daemon.ts,gateway.ts,channel.ts}`, `runtime/src/tools/system/{process.ts,browser-session.ts,handle-contract.ts,command-line.ts}`, `containers/desktop/server/src/tools.ts`, `runtime/src/desktop/tool-definitions.ts`, related tests under `runtime/src/**` and `containers/desktop/server/src/*.test.ts`, plus `docs/architecture/README.md`, `docs/ROADMAP.md`, `docs/RUNTIME_API.md`, and `.claude/notes/*`.
- **What worked:** The runtime now has a durable run contract, persisted kernel state, an event-driven wake plane, typed run domains, provider compaction hooks, and hardened long-lived tool contracts across host, browser, and desktop process handles. Recovery, control, and verification semantics are materially stronger, and the desktop managed-process surface now matches the host/browser idempotency model instead of drifting on `label`-only retries.
- **What didn't:** The autonomy roadmap is still not complete. Phase 5 still has broader product-surface work left for downloads/uploads, web servers, remote MCP jobs, sandboxes, research handles, universal compliance suites, resource envelopes, and structured error taxonomy across every long-lived tool family.
- **Rule added to CLAUDE.md:** no

## PR [pending]: durable task runtime operator-signal and carry-forward hardening
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/gateway/background-run-store.ts`, `runtime/src/gateway/background-run-store.test.ts`, `runtime/src/gateway/background-run-supervisor.ts`, `runtime/src/gateway/background-run-supervisor.test.ts`, `runtime/src/gateway/daemon.ts`, `runtime/src/utils/keyed-async-queue.ts`, `runtime/src/utils/keyed-async-queue.test.ts`, `.claude/notes/gotchas.md`, `.claude/notes/pr-log.md`, `.claude/notes/techdebt-2026-03-06-durable-task-runtime-phase3.md`
- **What worked:** Active background runs now accept persisted operator signals instead of being cancelled by every follow-up user message, and the supervisor carries a compact durable state snapshot across cycles so long-running work no longer depends only on a short rolling transcript. The focused unit suite passed, and a live websocket smoke confirmed a real daemon session queued a follow-up instruction into the active run instead of tearing it down.
- **What didn't:** The current operator-signal routing is session-exclusive while a background run is active. That is correct for task-runtime semantics, but it means foreground unrelated questions in the same session now need an explicit pause/new-session story instead of piggybacking on the old cancel-and-replace behavior.
- **Rule added to CLAUDE.md:** no

## PR [pending]: background run control-plane hardening
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/gateway/background-run-control.ts`, `runtime/src/gateway/background-run-control.test.ts`, `runtime/src/gateway/background-run-store.ts`, `runtime/src/gateway/background-run-store.test.ts`, `runtime/src/gateway/background-run-supervisor.ts`, `runtime/src/gateway/background-run-supervisor.test.ts`, `runtime/src/gateway/daemon.ts`, `.claude/notes/gotchas.md`, `.claude/notes/pr-log.md`, `.claude/notes/techdebt-2026-03-06-background-run-control-plane.md`
- **What worked:** Session-level `status` and `stop` are now runtime-owned even after a run completes, because the supervisor persists a recent-run snapshot per session. The runtime also has real `pause`/`resume` semantics now, including queued operator instructions that remain queued while paused and resume cleanly later. Focused tests passed, and live websocket probes verified active control, terminal-status lookup, running-state recovery across daemon restart, and paused-state recovery across daemon restart.
- **What didn't:** The control plane still lives in a large webchat branch inside `runtime/src/gateway/daemon.ts`, and `BackgroundRunSupervisor.executeCycle()` is still the dominant hot path. Both are correct, but they are the next extraction targets if the supervisor keeps growing.
- **Rule added to CLAUDE.md:** no

## PR [pending]: durable task runtime session recovery hardening
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/gateway/background-run-store.ts`, `runtime/src/gateway/background-run-store.test.ts`, `runtime/src/gateway/background-run-supervisor.ts`, `runtime/src/gateway/background-run-supervisor.test.ts`, `runtime/src/gateway/daemon.ts`, `runtime/src/gateway/session.ts`, `runtime/src/channels/webchat/plugin.ts`, `runtime/src/channels/webchat/plugin.test.ts`, `runtime/src/channels/webchat/session-store.ts`, `runtime/src/channels/webchat/session-store.test.ts`, `runtime/src/channels/webchat/types.ts`, `web/src/hooks/useChat.ts`, `web/src/hooks/useChat.test.ts`
- **What worked:** Background runs now persist/recover across daemon restarts, the web client can rediscover/resume prior sessions with a stable browser key, resumed foreground sessions rehydrate recent context from memory, and `until_stopped` runs are no longer forced to fail because of generic runtime/cycle caps.
- **What didn't:** The new durable session store and the existing background run store both carry near-identical keyed async write-serialization logic. That duplication is acceptable for this phase, but it should be extracted before another durable store is added.
- **Rule added to CLAUDE.md:** no

## PR [pending]: desktop doom image contract hardening
- **Date:** 2026-03-06
- **Files changed:** `containers/desktop/Dockerfile`, `containers/desktop/install-secure-path-launchers.sh`, `containers/desktop/secure-path-launchers.txt`, `scripts/check-desktop-image-hardening.mjs`, `scripts/check-desktop-image-hardening.test.mjs`, `scripts/smoke-desktop-doom-image.mjs`, `package.json`, `.github/workflows/ci.yml`, `README.md`, `docs/security/mcp-security-stack.md`, `.claude/notes/gotchas.md`, `.claude/notes/pr-log.md`, `.claude/notes/techdebt-2026-03-06-doom-desktop-image-regression.md`
- **What worked:** The desktop image now exports non-secure-path binaries through a manifest-driven installer instead of inline symlinks, and Doom MCP startup is guarded by a dedicated smoke script plus CI job. The fresh daemon boot confirmed the rebuilt image still registers the full `mcp.doom.*` tool surface.
- **What didn't:** The Dockerfile still has some repeated third-party MCP install structure between kitty and Doom. It is not a correctness issue now, but it is the next cleanup target if more desktop MCP integrations land.
- **Rule added to CLAUDE.md:** no

## PR [pending]: restore desktop doom mcp image wiring
- **Date:** 2026-03-06
- **Files changed:** `containers/desktop/Dockerfile`, `runtime/src/gateway/daemon.ts`, `.claude/notes/gotchas.md`, `.claude/notes/pr-log.md`, `.claude/notes/techdebt-2026-03-06-doom-desktop-image-regression.md`
- **What worked:** Restoring the Doom MCP install block in the desktop image, switching the launcher to a module-based Python wrapper, and exporting Doom binaries through `/usr/local/bin` brought `mcp.doom.*` registration back on fresh daemon boot. Removing the extra daemon-side startup log also fixed the duplicated `Desktop sandbox manager started` line.
- **What didn't:** The image still depends on a pinned external Doom MCP commit plus a local patch, and the launcher discovery contract is still implicitly tied to `sudo` secure-path behavior.
- **Rule added to CLAUDE.md:** no

## PR [pending]: daemon startup readiness handshake
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/bin/daemon.ts`, `runtime/src/cli/daemon.ts`, `runtime/src/cli/daemon.test.ts`, `.claude/notes/gotchas.md`, `.claude/notes/techdebt-2026-03-06-daemon-startup-readiness.md`
- **What worked:** The daemon child now emits an explicit `daemon.ready` IPC signal after `DaemonManager.start()` completes, and the CLI waits for that readiness signal instead of racing a 3-second PID-file poll. The rebuilt runtime now restarts cleanly through the normal CLI path, and the new tests cover both successful readiness and surfaced startup errors.
- **What didn't:** Startup still uses a fixed ready-timeout budget on the parent side. That is acceptable now, but if cold-start telemetry grows or more subsystems are added, making the timeout configurable is the next refinement.
- **Rule added to CLAUDE.md:** no

## PR [pending]: managed-process registry atomic persistence
- **Date:** 2026-03-06
- **Files changed:** `containers/desktop/server/src/tools.ts`, `containers/desktop/server/src/tools.test.ts`, `.claude/notes/gotchas.md`, `.claude/notes/techdebt-2026-03-06-structured-process-tools.md`, `.claude/notes/techdebt-2026-03-06-managed-process-registry-persistence.md`
- **What worked:** Managed-process registry writes are now serialized inside the desktop server and published with an atomic temp-file replace, so overlapping lifecycle updates from API calls and child exit hooks no longer race the on-disk registry. The live container smoke confirmed a real `process_start` / `process_stop` cycle persisted valid JSON with the exited state on disk.
- **What didn't:** Lookup by `label` and `pid` is still linear over the in-memory registry. That is acceptable at current scale, but it is the next cleanup target if managed-process volume increases.
- **Rule added to CLAUDE.md:** no

## PR [pending]: desktop tool catalog generation and drift enforcement
- **Date:** 2026-03-06
- **Files changed:** `runtime/scripts/generate-desktop-tool-definitions.ts`, `runtime/package.json`, `runtime/src/desktop/tool-definitions.ts`, `.claude/notes/gotchas.md`, `.claude/notes/techdebt-2026-03-06-structured-process-tools.md`
- **What worked:** The desktop server `TOOL_DEFINITIONS` export is now the single schema source of truth, while the daemon keeps using the same runtime-side catalog path. Drift is caught before runtime `build`, `test`, or `typecheck`, so the session allowlist and prompt-facing schemas cannot silently diverge again.
- **What didn't:** The remaining managed-process debt is persistence safety, not schema drift. Registry writes are still best-effort JSON rewrites and need a separate lock or journal if we want stronger crash/concurrency guarantees.
- **Rule added to CLAUDE.md:** no

## PR [pending]: runtime desktop delegation hardening
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/gateway/daemon.ts`, `runtime/src/gateway/tool-environment-policy.ts`, `runtime/src/gateway/tool-environment-policy.test.ts`, `runtime/src/gateway/sub-agent.ts`, `runtime/src/gateway/sub-agent.test.ts`, `runtime/src/gateway/subagent-orchestrator.ts`, `runtime/src/gateway/subagent-orchestrator.test.ts`, `runtime/src/gateway/tool-handler-factory.ts`, `runtime/src/gateway/tool-handler-factory.test.ts`, `runtime/src/gateway/delegation-scope.ts`, `runtime/src/desktop/session-router.ts`, `runtime/src/desktop/session-router.test.ts`, `runtime/src/llm/chat-executor.ts`, `runtime/src/llm/chat-executor.test.ts`, `runtime/src/llm/chat-executor-text.ts`, `runtime/src/llm/chat-executor-verifier.ts`, `runtime/src/llm/chat-executor-verifier.test.ts`, `runtime/src/utils/delegation-validation.ts`, `runtime/src/utils/delegation-validation.test.ts`
- **What worked:** Centralizing environment-policy and delegation-validation logic let the fix land across top-level chat, subagents, verifier checks, and final-response reconciliation without leaving parallel paths behind. The targeted regression suite now covers desktop-only tool exposure, startup-vs-execution timeouts, tool-grounded delegation evidence, no-progress failure surfacing, and the `npm install vite` guard regression.
- **What didn't:** The touched runtime path still has some pre-existing low-value test setup duplication, especially in `runtime/src/desktop/session-router.test.ts` and `runtime/src/llm/executor.test.ts`. It is not release-blocking, but it remains worth cleaning up separately.
- **Rule added to CLAUDE.md:** yes, `Environment Policy: Enforce tool-surface restrictions as runtime invariants` and `Timeouts: Split startup budget from execution budget for delegated work`

## PR [pending]: runtime delegation decomposition replanning
- **Date:** 2026-03-05
- **Files changed:** `runtime/src/gateway/delegation-scope.ts`, `runtime/src/gateway/tool-handler-factory.ts`, `runtime/src/gateway/tool-handler-factory.test.ts`, `runtime/src/gateway/subagent-orchestrator.ts`, `runtime/src/gateway/subagent-orchestrator.test.ts`, `runtime/src/workflow/pipeline.ts`, `runtime/src/llm/chat-executor-constants.ts`, `runtime/src/llm/chat-executor-planner.ts`, `runtime/src/llm/chat-executor-recovery.ts`, `runtime/src/llm/chat-executor.ts`, `runtime/src/llm/chat-executor.test.ts`, `docs/architecture/flows/runtime-chat-pipeline.md`, `docs/RUNTIME_API.md`, `docs/INCIDENT_REPLAY_RUNBOOK.md`
- **What worked:** The parent planner now treats overloaded delegated work as a first-class decomposition signal. Planner validation catches oversized `subagent_task` steps early, the orchestrator preserves a structured `needs_decomposition` backstop, and `ChatExecutor` performs one bounded refinement pass instead of stalling into repeated failed delegation attempts.
- **What didn't:** `executePlannerPath` is now the densest hot-path method in this area. It is still correct and covered, but it should be the first extraction target if planner behavior expands again.
- **Rule added to CLAUDE.md:** yes, `Delegation Planning: Treat overloaded child scope as a parent replanning signal`

## PR [pending]: runtime delegation traceability and phase classifier hardening
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/gateway/daemon.ts`, `runtime/src/gateway/daemon.test.ts`, `runtime/src/gateway/delegation-scope.ts`, `runtime/src/gateway/delegation-scope.test.ts`, `runtime/src/llm/chat-executor.test.ts`, `docs/architecture/flows/runtime-chat-pipeline.md`, `docs/RUNTIME_API.md`, `docs/INCIDENT_REPLAY_RUNBOOK.md`
- **What worked:** Delegated trace summaries now preserve raw objective/contract/acceptance data plus child validation and nested tool-call outcomes, which makes low-signal failures diagnosable from logs. Narrowing the phase heuristics removed false decomposition rejects caused by overly broad lexical matches.
- **What didn't:** `runtime/src/llm/chat-executor.test.ts` still carries large planner fixture blocks, which makes targeted expectation updates noisier than they should be.
- **Rule added to CLAUDE.md:** yes, `Delegation Incident Triage: Inspect raw delegated args/results, not card summaries` and `Delegation Phase Heuristics: Keep scope classifiers action-based and narrow`

## PR [pending]: runtime directory-claim guard correction
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/utils/delegation-validation.ts`, `runtime/src/utils/delegation-validation.test.ts`, `runtime/src/llm/chat-executor.test.ts`
- **What worked:** The final-response hallucination guard now blocks fake file-creation narratives without misclassifying valid directory-only mutations like `mkdir -p /workspace/pong`.
- **What didn't:** The guard still relies on filename-pattern heuristics for prose claims, so future artifact-pattern changes need regression coverage.
- **Rule added to CLAUDE.md:** yes, `Narrative File Claims: Distinguish directory creation from file writes`

## PR [pending]: runtime simple shell observation reconciliation
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/llm/chat-executor-text.ts`, `runtime/src/llm/chat-executor.ts`, `runtime/src/llm/chat-executor-text.test.ts`, `runtime/src/llm/chat-executor.test.ts`
- **What worked:** Single successful read-only shell calls now surface the actual command output when the model ignores it and emits generic shell advice instead.
- **What didn't:** The deterministic shell-output reconciliation is intentionally narrow. If more command classes need deterministic treatment later, add them with explicit tests rather than broadening the heuristic casually.
- **Rule added to CLAUDE.md:** yes, `Simple Shell Observations: Prefer direct tool output over unsolicited shell tutorials`

## PR [pending]: runtime Grok native-search routing and evidence propagation
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/llm/provider-native-search.ts`, `runtime/src/gateway/types.ts`, `runtime/src/gateway/config-watcher.ts`, `runtime/src/gateway/gateway.test.ts`, `runtime/src/gateway/daemon.ts`, `runtime/src/gateway/daemon.test.ts`, `runtime/src/llm/types.ts`, `runtime/src/llm/grok/adapter.ts`, `runtime/src/llm/grok/adapter.test.ts`, `runtime/src/llm/chat-executor-types.ts`, `runtime/src/llm/chat-executor.ts`, `runtime/src/llm/chat-executor.test.ts`, `runtime/src/llm/chat-executor-verifier.ts`, `runtime/src/llm/chat-executor-verifier.test.ts`, `runtime/src/utils/delegation-validation.ts`, `runtime/src/utils/delegation-validation.test.ts`, `runtime/src/gateway/sub-agent.ts`, `runtime/src/gateway/tool-handler-factory.ts`, `runtime/src/gateway/tool-handler-factory.test.ts`, `runtime/src/gateway/subagent-orchestrator.ts`, `runtime/src/gateway/subagent-orchestrator.test.ts`, `docs/architecture/flows/runtime-chat-pipeline.md`, `docs/RUNTIME_API.md`, `docs/INCIDENT_REPLAY_RUNBOOK.md`
- **What worked:** Grok research turns can now use provider-native `web_search`, delegated research scopes prefer that path over browser MCP noise, and provider citations propagate through executor/subagent/verifier validation so research steps no longer fail just because the evidence came from server-side search instead of a local browser call.
- **What didn't:** The runtime still depends on heuristic intent classification to decide when to append `web_search` to routed subsets. The heuristics are now centralized, but any future broadening should be backed by regression tests to avoid reintroducing browser-vs-search drift.
- **Rule added to CLAUDE.md:** yes, `Grok Research: Prefer provider-native web_search over browser MCP for research/documentation turns`

## PR [pending]: runtime final synthesis grounding ledger
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/llm/chat-executor.ts`, `runtime/src/llm/chat-executor-text.ts`, `runtime/src/llm/chat-executor.test.ts`, `runtime/src/llm/chat-executor-text.test.ts`, `docs/architecture/flows/runtime-chat-pipeline.md`, `docs/RUNTIME_API.md`, `docs/INCIDENT_REPLAY_RUNBOOK.md`
- **What worked:** Post-tool synthesis calls now receive an authoritative runtime execution ledger derived from actual tool records and provider citations, which grounds final answers externally instead of trusting model self-report. The change is centralized in `callModelForPhase(...)`, so both direct tool follow-up and planner synthesis use the same path.
- **What didn't:** `runtime/src/llm/chat-executor-text.ts` is continuing to accumulate prompt/reconciliation helpers. The new ledger builder is covered and bounded, but that file remains an extraction candidate if more synthesis-specific helpers land there.
- **Rule added to CLAUDE.md:** no

## PR [pending]: runtime Grok search capability gating and terminal close routing
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/llm/provider-native-search.ts`, `runtime/src/llm/provider-native-search.test.ts`, `runtime/src/llm/grok/adapter.ts`, `runtime/src/llm/grok/adapter.test.ts`, `runtime/src/gateway/daemon.ts`, `runtime/src/gateway/daemon.test.ts`, `runtime/src/gateway/tool-routing.ts`, `runtime/src/gateway/tool-routing.test.ts`, `docs/architecture/flows/runtime-chat-pipeline.md`, `docs/RUNTIME_API.md`, `docs/INCIDENT_REPLAY_RUNBOOK.md`
- **What worked:** The runtime now suppresses xAI `web_search` on unsupported Grok models instead of trusting a config flag, narrows research routing so generic `current` turns stop triggering provider search, and routes terminal close intent toward `mcp.kitty.close` with cache invalidation when users switch from opening to closing a terminal.
- **What didn't:** Terminal close still depends on the direct kitty tool being present in the session. When it is absent, the fallback remains GUI window focus plus `alt+F4`, so that path still deserves incident coverage.
- **Rule added to CLAUDE.md:** yes, `Grok Server-Side Tools: Gate provider-native search on actual model support` and `Terminal Routing: Treat open/close as separate intents`

## PR [pending]: web preserve composer focus and respect manual scroll state
- **Date:** 2026-03-06
- **Files changed:** `web/src/App.tsx`, `web/src/App.integration.test.tsx`, `web/src/components/chat/ChatInput.tsx`, `web/src/components/chat/MessageList.tsx`, `web/src/components/chat/MessageList.test.tsx`, `web/src/components/activity/ActivityFeedView.tsx`, `web/src/components/activity/ActivityFeedView.test.tsx`, `web/src/components/chat/DesktopPanel.tsx`, `web/src/components/chat/ChatMessage.tsx`, `web/vite.config.ts`
- **What worked:** The chat composer now keeps focus when the desktop panel auto-opens during voice use, both message and activity feeds stop yanking the user back to the bottom after manual scroll-up, and the markdown/syntax-highlighter vendor code is split out of the main web bundle. The web package tests and build passed from the package directory.
- **What didn't:** Running Vitest from the repo root produced false DOM-environment failures because it skipped `web/vitest.config.ts`. That is a command-shape gotcha, not a product bug, and it is now documented.
- **Rule added to CLAUDE.md:** no

## PR [pending]: runtime Doom visible-launch defaults and deterministic stop
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/llm/chat-executor-tool-utils.ts`, `runtime/src/llm/chat-executor-tool-utils.test.ts`, `runtime/src/gateway/tool-handler-factory.ts`, `runtime/src/gateway/tool-handler-factory.test.ts`, `runtime/src/llm/chat-executor-recovery.ts`, `runtime/src/llm/chat-executor-recovery.test.ts`, `runtime/src/gateway/tool-routing.ts`, `runtime/src/gateway/tool-routing.test.ts`, `runtime/src/gateway/doom-stop-guard.ts`, `runtime/src/gateway/doom-stop-guard.test.ts`, `runtime/src/gateway/daemon.ts`
- **What worked:** Minimal Doom launch prompts now normalize to a visible HUD-on `1280x720` window, duplicate same-turn `mcp.doom.start_game` calls are blocked, and explicit webchat stop requests bypass model improvisation and call `mcp.doom.stop_game` directly. Live websocket smoke confirmed both the rewritten launch args and the deterministic stop path.
- **What didn't:** The deterministic Doom stop flow currently duplicates some of the normal webchat final-response/session-memory bookkeeping in `daemon.ts`. If more runtime-owned fast paths are added, extract that shared response path instead of cloning it again.
- **Rule added to CLAUDE.md:** no

## PR [pending]: runtime background-run signal-tail hardening
- **Date:** 2026-03-06
- **Files changed:** `runtime/src/gateway/background-run-supervisor.ts`, `runtime/src/gateway/background-run-supervisor.test.ts`
- **What worked:** Late process and external signals no longer get lost in the cycle tail. The supervisor now keeps the cycle `running` until tail work finishes, preserves only the consumed signal snapshot during carry-forward compaction, suppresses stale working updates when fresh signals are pending, and completes on verified `process_exit` without falling into a second timer-driven cycle. Focused runtime tests and a live websocket smoke against the daemon both passed.
- **What didn't:** `executeCycle()` is still a very large hot-path method, and deterministic terminal completion still relies on regex/classifier heuristics rather than typed tool-domain completion contracts.
- **Rule added to CLAUDE.md:** no

## PR [pending]: runtime desktop restart recovery for durable background runs
- **Date:** 2026-03-07
- **Files changed:** `runtime/src/desktop/manager.ts`, `runtime/src/desktop/manager.test.ts`, `runtime/src/channels/webchat/plugin.ts`, `runtime/src/gateway/daemon.ts`
- **What worked:** Desktop sandboxes now survive daemon restart and reattach from Docker inspect data, so managed-process background runs can recover the same container and continue native `desktop.process_status` verification instead of probing a fresh empty sandbox. Live websocket restart recovery passed end to end with a real `/bin/sleep` managed process, and the completion update was still persisted to session history while the client was disconnected.
- **What didn't:** Sandbox preservation is now runtime-safe, but daemon shutdown still preserves every tracked desktop container. That is correct for restart durability, but it needs a future operator mode split if we want a clean distinction between “restart/suspend” and “fully tear down desktops.”
- **Rule added to CLAUDE.md:** no

## PR #1411: feat(runtime): complete phase 7 governance and phase 8 observability
- **Date:** 2026-03-08
- **Files changed:** `TODO.MD`, `.github/workflows/ci.yml`, `docs/INCIDENT_REPLAY_RUNBOOK.md`, `.claude/notes/gotchas.md`, `.claude/notes/techdebt-2026-03-08-phase7-phase8-completion.md`, `runtime/package.json`, `runtime/scripts/check-background-run-gates.ts`, `runtime/scripts/run-background-run-quality.ts`, `runtime/src/eval/*`, `runtime/src/gateway/*`, `runtime/src/policy/*`, `runtime/src/telemetry/metric-names.ts`, `runtime/src/channels/webchat/*`, `runtime/src/mcp-client/*`, `runtime/src/tools/registry.ts`, `web/src/components/dashboard/AgentStatusView.tsx`, `web/src/hooks/useAgentStatus.test.ts`, `web/src/hooks/useApprovals.ts`, `web/src/hooks/useApprovals.test.ts`, `web/src/types.ts`
- **What worked:** The runtime now has the remaining implementable Phase 7 governance surface and a full Phase 8 replay/eval/alerting path. Scoped budgets, signed audit logging, session credential brokering, MCP trust controls, background-run telemetry, replay artifacts, eval gates, CI benchmarks, and dashboard status all landed together and were validated with targeted suites plus a live daemon websocket smoke after restart.
- **What didn't:** The roadmap still correctly leaves the external Phase 7 security review unchecked because that gate cannot be completed from inside the repository. It is an operational rollout dependency, not missing code.
- **Rule added to CLAUDE.md:** no

## PR #1415: feat(runtime): complete autonomy runtime phases 9-11
- **Date:** 2026-03-08
- **Files changed:** `TODO.MD`, `.github/workflows/ci.yml`, `docs/AUTONOMY_RUNTIME_ROLLOUT.md`, `.claude/notes/gotchas.md`, `.claude/notes/techdebt-2026-03-08-phase9-phase11-completion.md`, `package.json`, `docs-mcp/package.json`, `mcp/package.json`, `sdk/tsconfig.json`, `runtime/package.json`, `runtime/scripts/check-autonomy-rollout-gates.ts`, `runtime/src/gateway/*`, `runtime/src/channels/webchat/*`, `runtime/src/policy/governance-audit-log.ts`, `runtime/tests/delegation-learning.integration.test.ts`, `web/src/App.tsx`, `web/src/components/BBSMenuBar.tsx`, `web/src/components/dashboard/AgentStatusView.tsx`, `web/src/components/runs/RunDashboardView.tsx`, `web/src/hooks/useRuns.ts`, `web/src/hooks/useRuns.test.ts`, `web/tests/e2e/site.spec.ts`, `yarn.lock`, `runtime/yarn.lock`, `mcp/yarn.lock`, `sdk/yarn.lock`
- **What worked:** The remaining in-repo autonomy roadmap is implemented through Phases 9-11. Operator UX, durable subruns, rollout gates, notifier/operator plumbing, final supervisor dedupe hardening, and the rollout documentation all landed together. Broad root validation, web validation, Trivy runtime scanning, and autonomy rollout gates were rerun on the final tree.
- **What didn't:** Two roadmap blockers remain by design: the independent external runtime security review and the external privacy/compliance review. Those are rollout gates, not missing repository work. The MCP build still emits the pre-existing non-fatal `import.meta` CommonJS warning.
- **Rule added to CLAUDE.md:** no
