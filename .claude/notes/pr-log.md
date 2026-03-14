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

## PR #1457: delegated autonomy follow-up hardening
- **Date:** 2026-03-11
- **Files changed:** runtime/src/gateway/{daemon,delegation-runtime,delegation-scope,delegation-tool,host-tooling,sub-agent,subagent-orchestrator,tool-handler-factory,tool-routing}.ts, runtime/src/gateway/{daemon,delegation-scope,host-tooling,sub-agent,subagent-orchestrator,tool-handler-factory}.test.ts, runtime/src/llm/{chat-executor,chat-executor-contract-flow,chat-executor-contract-guidance,chat-executor-planner,chat-executor-recovery,chat-executor-text,chat-executor-tool-utils,chat-executor-types,timeout,tool-turn-validator,types}.ts, runtime/src/llm/{chat-executor,chat-executor-contract-flow,chat-executor-contract-guidance,chat-executor-planner,chat-executor-recovery,chat-executor-tool-utils}.test.ts, runtime/src/llm/grok/{adapter,adapter-utils}.ts, runtime/src/llm/grok/{adapter,adapter-utils}.test.ts, runtime/src/llm/ollama/{adapter,adapter.test}.ts, runtime/src/utils/{delegation-validation,browser-tool-taxonomy}.ts, runtime/src/utils/delegation-validation.test.ts, runtime/src/tools/system/{bash,typed-artifact-domains}.ts, runtime/src/tools/system/bash.test.ts, runtime/src/autonomous/curiosity-interests.ts, runtime/src/autonomous/curiosity-interests.test.ts, containers/desktop/server/src/{tools,toolDefinitions}.ts, runtime/src/desktop/tool-definitions.ts, runtime/scripts/generate-desktop-tool-definitions.ts, scripts/agenc-watch.mjs, docs/RUNTIME_API.md, docs/RUNTIME_PIPELINE_DEBUG_BUNDLE.md, docs/architecture/flows/runtime-chat-pipeline.md
- **What worked:** Hardened delegated child validation and recovery, improved subagent circuit-breaker trace payloads, kept desktop/runtime tool definitions in sync, and finished the request-tree budget follow-up so default child headroom scales with planner budget hints instead of a flat constant.
- **What didn't:** Child prompt/session budgeting is still derived from the top-level runtime LLM config rather than the finally selected child provider, so true provider-specific child context budgeting remains a follow-up.
- **Rule added to CLAUDE.md:** no

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

## PR #[local]: runtime memory endurance replay stabilization
- **Date:** 2026-03-09
- **Files changed:** runtime/src/channels/webchat/{plugin,plugin.test}.ts, runtime/src/gateway/{sub-agent,sub-agent.test,tool-handler-factory,tool-handler-factory.test}.ts, runtime/src/llm/{chat-executor,chat-executor.test,chat-executor-planner,chat-executor-planner.test,chat-executor-text,chat-executor-text.test}.ts, runtime/yarn.lock, scripts/agenc-watch.mjs
- **What worked:** Confirmed parent memory, manual compaction, owner-token resume, and repeated child-session recall from `~/.agenc/daemon.log`; salvaged planner-emitted direct tool calls into deterministic steps; kept exact child-memory contracts stable across delegated reuse; and persisted the live TUI owner token so operator reconnects keep the same chat session.
- **What didn't:** The continuity path still spans large executor/delegation files, and endurance confidence still depends on daemon-log-backed replay instead of a dedicated automated soak suite.
- **Rule added to CLAUDE.md:** no

## PR #[local]: delegated child memory contract hardening
- **Date:** 2026-03-09
- **Files changed:** runtime/src/gateway/{tool-handler-factory,tool-handler-factory.test}.ts, runtime/src/llm/{chat-executor-planner,chat-executor.test}.ts, runtime/src/utils/{delegation-validation,delegation-validation.test}.ts, .claude/notes/{gotchas,pr-log,techdebt-2026-03-09}.md
- **What worked:** Used `~/.agenc/daemon.log` as the authoritative replay source, fixed delegated child mixed-output session-handle rewriting, preserved child store-vs-recall semantics for secret prompts, and made placeholder exact-output contracts validate against real recalled values so parent memory, manual compaction, and subagent continuity all passed in the live `MEMCORE-20260309-1302` session.
- **What didn't:** Planner turns still rely on salvage because Grok continues to emit tool calls instead of strict planner JSON on some delegated requests, so the planner normalization path remains a medium-risk maintenance hotspot.
- **Rule added to CLAUDE.md:** no

## PR #[local]: zk image rotation and admin flow
- **Date:** 2026-03-10
- **Files changed:** programs/agenc-coordination/src/{errors,events,lib,state}.rs, programs/agenc-coordination/src/instructions/{complete_task_private,initialize_zk_config,mod,update_zk_image_id,zk_config_helpers}.rs, sdk/src/{constants,index,proof-validation,protocol,tasks,validation}.ts, sdk/src/__tests__/{contract,proof-validation,protocol}.test.ts, runtime/{idl/agenc_coordination.json,src/types/agenc_coordination.ts}, runtime/src/events/idl-contract.ts, scripts/zk-config-admin.ts, package.json, docs/MAINNET_DEPLOYMENT.md, .claude/notes/{gotchas,techdebt-2026-03-10-zk-config-admin}.md
- **What worked:** Moved trusted RISC Zero image selection on-chain via `zk_config`, regenerated and synced IDL/types, added a thin authority CLI for show/init/rotate, and closed the stale runtime event-contract drift so the IDL gate passes again.
- **What didn't:** The admin flow still depends on an operator providing the new guest image ID explicitly; that is deliberate, but it means release discipline around the separate prover repo remains mandatory.
- **Rule added to CLAUDE.md:** yes, `Authority Model: Do not invent multisig requirements for ZK image rotation`; `Scope Control: Do not spin up historical worktrees without explicit user buy-in`; `Architecture Advice: Clarify deployment model before recommending prover topology`

## PR #[local]: unlimited recall budget default for autonomous runs
- **Date:** 2026-03-12
- **Files changed:** runtime/src/llm/{chat-executor-constants,chat-executor,chat-executor-types,chat-executor.test}.ts, runtime/src/gateway/types.ts, docs/{RUNTIME_API.md,architecture/flows/runtime-chat-pipeline.md}, .claude/notes/{gotchas,pr-log,techdebt-2026-03-12-recall-budget.md}, CLAUDE.md
- **What worked:** Aligned `maxModelRecallsPerRequest` semantics so `0` and an omitted value both mean unlimited, removed the hidden 24-recall stop for long codegen runs, updated docs/comments, and verified with targeted executor/background-run tests plus a live daemon restart into `agenc-watch`.
- **What didn't:** "Indefinite" is still bounded by the real guards: request timeout, tool budgets, failure budgets, and no-progress breakers. Child subagents also still inherit their own tool budgets, so long delegated phases can stop there even though recall budget no longer does.
- **Rule added to CLAUDE.md:** yes, `Autonomous budgets: keep recall budget unlimited unless an operator sets a cap`

## PR #[local]: live benchmark routing and prompt neutrality
- **Date:** 2026-03-12
- **Files changed:** runtime/src/gateway/tool-routing.ts, runtime/src/gateway/tool-routing.test.ts, CLAUDE.md, .claude/notes/{gotchas,pr-log}.md
- **What worked:** Fixed the host code/file/system phrasing route miss that collapsed a live codegen benchmark into the wrong tool subset, relaunched the benchmark with a normal user-style prompt, and codified that streamed autonomy prompts must not carry tool-policy steering.
- **What didn't:** The routed host coding subset is still noisier than it should be for pure codegen turns, so follow-up routing cleanup is still warranted after the stream-critical regressions are closed.
- **Rule added to CLAUDE.md:** yes, `Benchmark prompts: keep streamed codegen prompts natural`

## PR #[local]: grok store-disabled continuation gating and delegation trace cleanup
- **Date:** 2026-03-12
- **Files changed:** runtime/src/gateway/{llm-stateful-defaults,subagent-orchestrator,tool-handler-factory}.{ts,test.ts}, runtime/src/llm/{chat-executor-recovery,chat-executor,grok/adapter,grok/adapter.test,provider-capabilities,provider-capabilities.test,types}.ts, .claude/notes/{gotchas,pr-log,techdebt-2026-03-12-grok-store-disabled}.md
- **What worked:** Reproduced delegated full-codebase generation in isolated `/workspace` sandboxes, fixed noisy retry lifecycle emissions, surfaced tool-result `isError` on both client and subagent events, gated Grok `previous_response_id` continuation behind `store:true`, and then centralized fallback-reason defaults so stateful summary accounting no longer relies on a hand-maintained mirror map.
- **What didn't:** The live verification used focused daemon probes and targeted Vitest coverage rather than a full repo-wide test pass, so broader runtime confidence still depends on the existing larger suite.
- **Rule added to CLAUDE.md:** no
## PR #1464: recover daemon attach for spaced paths
- **Date:** 2026-03-14
- **Files changed:** runtime/src/cli/{daemon,daemon.test,operator-console,operator-console.test}.ts, .claude/notes/{pr-log,techdebt-2026-03-14-operator-console-daemon-attach}.md
- **What worked:** Replaced flat `ps` flag scraping with structured argv parsing from `/proc/<pid>/cmdline` plus a fallback parser, and taught `agenc` operator-console to attach to an already-running matching daemon when PID-file discovery is missing instead of trying to start a duplicate daemon.
- **What didn't:** Non-`/proc` platforms still fall back to best-effort process-string parsing, and daemon identity resolution still lives in both `daemon.ts` and `operator-console.ts` instead of one shared decision point.
- **Rule added to CLAUDE.md:** yes, `Process Discovery: Do not parse process identity from flat \`ps\` text when argv fidelity matters`

## PR #[local]: operator watch seams and `@file` tags
- **Date:** 2026-03-13
- **Files changed:** scripts/agenc-watch.mjs, scripts/lib/agenc-watch-{agent-stream,composer,diff-render,file-links,log-tail,markdown-core,render-cache,rich-text,runtime,state,surface-bridge,surface-dispatch,surface-summary,terminal-sequences,tool-presentation,transcript-cards,viewport,workspace-index}.mjs, scripts/agenc-watch-*.test.mjs, scripts/fixtures/agenc-watch-*.fixture.mjs, runtime/src/channels/webchat/operator-events.ts, runtime/src/channels/webchat/operator-events.test.ts, runtime/src/operator-events.ts, runtime/src/cli/operator-console.ts, runtime/src/cli/operator-console.test.ts, runtime/package.json, runtime/vitest.config.ts, web/src/hooks/useRuns.ts, web/src/hooks/useRuns.test.ts, web/src/test-setup.ts, .claude/notes/{gotchas,pr-log,techdebt-2026-03-13,refactor-plan-2026-03-13-watch-composer-tags}.md
- **What worked:** Moved the watch surface onto explicit event/render/composer/state seams, cleaned up streaming reconciliation and markdown rendering, added bounded repo-local `@file` tag completion plus transcript styling, and verified the full watch suite with live sandbox smokes.
- **What didn't:** `scripts/agenc-watch.mjs` is still a large composition root, and the first live `@file` smoke used stale composer text, which proved the popup path but was noisier than an ideal clean-room transcript proof.
- **Rule added to CLAUDE.md:** no

## PR #[local]: operator console controller extraction follow-up
- **Date:** 2026-03-14
- **Files changed:** REFACTOR-MASTER-PROGRAM.md, scripts/agenc-watch.mjs, scripts/lib/agenc-watch-{commands,input,transport,planner,subagents,markdown-core,markdown-parse,markdown-stream,tool-presentation,tool-presentation-normalizer,tool-presentation-copy}.mjs, scripts/agenc-watch-{commands,input,transport,planner,subagents,markdown-module-split,tool-presentation-normalizer}.test.mjs, .claude/notes/{pr-log,gotchas,techdebt-2026-03-14,refactor-plan-2026-03-14-operator-console-architecture}.md
- **What worked:** Pulled command dispatch, terminal input, websocket/bootstrap lifecycle, planner/subagent event families, markdown parse/stream logic, and tool-presentation normalization behind explicit watch-local controllers/modules while keeping the full watch matrix green at 152 passing tests.
- **What didn't:** `scripts/agenc-watch.mjs` still owns the top-level frame/layout assembly, so the operator console is now modular in behavior and transport but not yet a pure thin-shell renderer.
- **Rule added to CLAUDE.md:** no

## PR #[local]: operator console frame controller completion
- **Date:** 2026-03-14
- **Files changed:** scripts/agenc-watch.mjs, scripts/lib/agenc-watch-frame.mjs, scripts/agenc-watch-frame.test.mjs, CLAUDE.md, .claude/notes/{gotchas,pr-log,techdebt-2026-03-14}.md
- **What worked:** Finished the last in-scope watch hotspot by moving frame/layout/detail/export/scroll rendering behind `createWatchFrameController(...)`, deleted the duplicated inline frame slab from `scripts/agenc-watch.mjs`, and added direct seam coverage on top of the full watch suite.
- **What didn't:** The operator console still has a long composition-root script and a deliberately explicit dependency bag for the frame controller, so the next gain is narrowing the shell/package boundary rather than adding more behavior inline.
- **Rule added to CLAUDE.md:** yes, `Refactor Completion: Do not stop while the last declared in-scope hotspot is still in the entrypoint`

## PR #[local]: operator console app lifecycle and transcript store extraction
- **Date:** 2026-03-14
- **Files changed:** scripts/agenc-watch.mjs, scripts/lib/agenc-watch-{app,event-store,surface-bridge,surface-dispatch}.mjs, scripts/agenc-watch-{app,event-store,entry,surface-bridge,surface-dispatch}.test.mjs, .claude/notes/{gotchas,pr-log,techdebt-2026-03-14}.md, CLAUDE.md
- **What worked:** Reduced `scripts/agenc-watch.mjs` to a thin executable wrapper, moved transcript mutation behind a real `eventStore` seam, added a disposable app lifecycle with startup/dispose coverage, and kept both the full watch suite and runtime launcher contract green.
- **What didn't:** `scripts/lib/agenc-watch-app.mjs` is now the main composition root, and `scripts/lib/agenc-watch-frame.mjs` still writes to global `process.stdout`, so the final package-boundary cleanup is now in app/frame injection rather than the executable path.
- **Rule added to CLAUDE.md:** yes, `Refactor Copyovers: audit stale helper references after moving a large entrypoint into a new module`

## PR #[local]: operator console UX hardening and frame snapshots
- **Date:** 2026-03-14
- **Files changed:** scripts/lib/agenc-watch-{app,diff-render,frame,input,rich-text,surface-summary}.mjs, scripts/fixtures/agenc-watch-frame-{harness,snapshot}.fixture.mjs, scripts/agenc-watch-{app,diff-render,frame,frame-snapshot,input,surface-summary}.test.mjs, scripts/fixtures/agenc-watch-mutation-replay.fixture.mjs, CLAUDE.md, .claude/notes/{gotchas,pr-log,techdebt-2026-03-14}.md
- **What worked:** Added a shared visible-frame snapshot seam, richer runtime/provider/failover chrome, focused DAG and delegated-agent readability improvements, diff-detail hunk navigation on `ctrl+p`/`ctrl+n`, before/after diff section markers, and exact snapshot coverage for wide, diff-detail, and narrow reconnect operator views while keeping the full watch matrix green.
- **What didn't:** `scripts/lib/agenc-watch-app.mjs` is still the main composition root, and the app test surface still leans on focused helper validation plus the broader watch matrix instead of a deeper app-level scenario harness.
- **Rule added to CLAUDE.md:** yes, `Execution Rule: If The User Says "Implement This Backlog", Execute The Backlog Instead Of Restating It`

## PR #[local]: operator console live replay capture
- **Date:** 2026-03-14
- **Files changed:** scripts/fixtures/agenc-watch-live-replay-{harness,raw.fixture}.mjs, scripts/agenc-watch-live-replay.test.mjs, CLAUDE.md, .claude/notes/{gotchas,pr-log,techdebt-2026-03-14}.md
- **What worked:** Replaced synthetic replay inputs with raw daemon websocket envelopes, made the shared replay harness load the built runtime operator-event contract by default, and kept the replay checkpoints stable through the same normalization path the live console uses.
- **What didn't:** Replay still uses curated deterministic envelope fixtures rather than exported live daemon recordings, so transcript realism is now at the protocol boundary but not yet at full captured-session fidelity.
- **Rule added to CLAUDE.md:** yes, `Runtime Rule: Watch Live Replay Must Use Raw Daemon WebSocket Envelopes`

## PR #1471: refresh README runtime and TUI guidance
- **Date:** 2026-03-14
- **Files changed:** README.md, runtime/src/bin/agenc.ts, .claude/notes/pr-log.md
- **What worked:** Rewrote the root README around the current runtime-centric repo surface, removed stale and broken launch/docs fragments, added the devnet/testnet-only warning, and restored the missing `agenc` bin wrapper so the documented `runtime/dist/bin/agenc.js` launcher is produced by the runtime build.
- **What didn't:** Verifying the launcher in a clean worktree required package-local `npm install` first because the worktree does not inherit `node_modules`, so the build proof depends on local dependency hydration rather than an already warm checkout.
- **Rule added to CLAUDE.md:** no
