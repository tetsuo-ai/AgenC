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
