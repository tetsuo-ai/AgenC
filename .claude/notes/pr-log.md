## PR #[local]: runtime approval policy cleanup
- **Date:** 2026-03-08
- **Files changed:** runtime/src/gateway/approvals.ts, runtime/src/gateway/approval-runtime.ts, runtime/src/gateway/approval-runtime.test.ts, runtime/src/gateway/config-watcher.ts, runtime/src/gateway/config-watcher.test.ts, runtime/src/gateway/daemon.ts, runtime/src/gateway/delegation-runtime.ts, runtime/src/gateway/tool-handler-factory.ts, runtime/src/gateway/tool-handler-factory.test.ts, runtime/src/gateway/types.ts, runtime/src/gateway/voice-bridge.ts, runtime/src/gateway/voice-bridge.test.ts, runtime/src/llm/chat-executor-constants.ts, runtime/src/llm/chat-executor-types.ts, runtime/src/llm/chat-executor-tool-utils.ts, runtime/src/llm/chat-executor-tool-utils.test.ts, runtime/src/llm/chat-executor.ts, runtime/src/policy/policy-gate.ts, runtime/src/policy/policy-gate.test.ts, runtime/src/gateway/approvals.test.ts
- **What worked:** Split approval policy from normal execution, made approvals explicit opt-in, removed greeting and side-effect execution heuristics, removed gateway delegation score vetoes, and propagated concrete block reasons back to callers.
- **What didn't:** Approval/policy runtime wiring still depends on the large daemon bootstrap path, so future policy changes can still regress unless that hotspot is extracted.
- **Rule added to CLAUDE.md:** yes, `Approval Gating: Keep approvals opt-in and scoped to real-risk actions`; `Heuristic Blockers: Do not turn planning heuristics into execution-time denials`

## PR #[local]: observability portal and trace ledger
- **Date:** 2026-03-08
- **Files changed:** runtime/src/observability/{types,errors,sqlite-store,observability,index}.ts, runtime/src/llm/provider-trace-logger.ts, runtime/src/channels/webchat/{types,protocol,handlers}.ts, runtime/src/gateway/daemon.ts, runtime/src/channels/webchat/plugin.test.ts, web/src/hooks/useObservability.ts, web/src/components/observability/ObservabilityView.tsx, web/src/{App.tsx,types.ts,constants.ts}, web/src/components/BBSMenuBar.tsx, docs/RUNTIME_API.md, docs/RUNTIME_PIPELINE_DEBUG_BUNDLE.md, docs/architecture/flows/runtime-chat-pipeline.md
- **What worked:** Introduced a durable observability store, persisted trace/artifact metadata at runtime boundaries, exposed query APIs over WebChat, and shipped a searchable trace portal with artifact/log drill-down.
- **What didn't:** The first pass concentrates the portal UI and handler logic in a couple of larger files that should be split before the next observability expansion.
- **Rule added to CLAUDE.md:** no

## PR #1429: runtime routing hardening and live console
- **Date:** 2026-03-09
- **Files changed:** runtime/src/gateway/{daemon,daemon-trace,llm-stateful-defaults,delegation-tool,sub-agent,tool-handler-factory}.ts, runtime/src/gateway/{daemon,delegation-tool,sub-agent,tool-handler-factory,llm-stateful-defaults}.test.ts, runtime/src/llm/{chat-executor,chat-executor-contract-flow,chat-executor-contract-guidance,chat-executor-routing-state}.ts, runtime/src/llm/{chat-executor,chat-executor-contract-flow,chat-executor-contract-guidance,chat-executor-routing-state}.test.ts, runtime/src/llm/grok/{adapter,adapter-utils}.ts, runtime/src/llm/grok/{adapter,adapter-utils}.test.ts, runtime/src/llm/provider-trace-logger.test.ts, runtime/src/utils/{delegation-validation,trace-payload-serialization}.ts, runtime/src/utils/{delegation-validation,trace-payload-serialization}.test.ts, scripts/agenc-watch.mjs, scripts/agenc-trace-watch.mjs
- **What worked:** Split shared trace and provider helpers out of the daemon and adapters, tightened routed-tool and delegation validation, enabled Grok stateful defaults at the gateway layer, and made the live operator/trace panes usable for stream debugging.
- **What didn't:** The daemon logs still need dedicated endurance verification for long-running webchat memory and subagent loops; the runtime is cleaner, but the indefinite-run story still needs active stress coverage.
- **Rule added to CLAUDE.md:** yes, `Runtime Debugging: daemon.log is the source of truth for runtime and subagent incident triage`

## PR #[local]: runtime continuity and compaction ingestion hardening
- **Date:** 2026-03-09
- **Files changed:** runtime/src/gateway/{daemon,daemon.test,delegation-tool,delegation-tool.test,sub-agent,sub-agent.test,tool-handler-factory,tool-handler-factory.test}.ts, runtime/src/llm/{chat-executor,chat-executor.test,chat-executor-text,chat-executor-text.test,chat-executor-types}.ts, runtime/src/llm/grok/{adapter,adapter-utils,adapter.test}.ts, runtime/src/memory/{ingestion,ingestion.test}.ts
- **What worked:** Verified parent and subagent provider continuity from `~/.agenc/daemon.log`, fixed false-positive compaction-ingestion warnings for manual `session:compact` after-phase payloads without generated summaries, and kept compacted parent and child recall stable in live replay.
- **What didn't:** The runtime still relies on very large gateway/LLM files for this flow, so indefinite-run regression work remains slower and riskier than it should be.
- **Rule added to CLAUDE.md:** no

## PR #[local]: runtime endurance gate hardening
- **Date:** 2026-03-09
- **Files changed:** package.json, yarn.lock, runtime/package.json, runtime/yarn.lock, runtime/src/gateway/daemon.ts, runtime/src/llm/{chat-executor-text,chat-executor-text.test}.ts, runtime/src/memory/{ingestion,ingestion.test}.ts
- **What worked:** Hardened exact-response parsing for parent/child endurance prompts, normalized budget-compaction ingestion events, refreshed runtime `file:../sdk` dependencies before build/typecheck/test, and aligned the repo-root `@solana/spl-token` pin so the desktop tool-definition gate uses a healthy Solana dependency graph.
- **What didn't:** Endurance coverage is still mostly driven by live daemon-log replays rather than a dedicated automated long-run suite, so multi-hour regression confidence still depends on active operator validation.
- **Rule added to CLAUDE.md:** no
