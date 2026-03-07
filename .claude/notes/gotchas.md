## Prompt Budgeting Gotchas

- Keep multimodal tool payload handling aligned between section-budgeting and tool-level image budgeting. If section caps are enforced too aggressively without cap rebalancing, screenshot/image context can disappear unexpectedly even when total prompt budget is healthy.

## Grok Stateful Responses Gotchas

- Stateful continuation is only safe when local message history reconciles with the persisted provider anchor. A missing or stale `previous_response_id` must not be treated as context overflow; classify it as a stateful fallback reason and retry statelessly when configured.
- Reconciliation must include normalized assistant tool calls and tool result identifiers/content shape. Omitting tool-turn linkage from the hash can create false-positive "safe continuation" decisions after tool loops.

## Phase 9 Pipeline Gates Gotchas

- Keep Phase 9 gate thresholds synchronized between `runtime/src/eval/pipeline-gates.ts` defaults and CI env overrides in `.github/workflows/ci.yml`. Drift here makes local pass/fail expectations diverge from CI behavior.

## Phase 10 Documentation Gotchas

- Keep runtime pipeline docs synchronized across architecture flow docs, runtime API config profiles, and incident/debug runbooks. If one changes without the others, operators follow stale thresholds or incorrect repro steps.

## On-Chain Governance Validation Gotchas

- Keep `RateLimitChange` validation policy synchronized across `update_rate_limits`, `create_proposal`, and `execute_proposal`. Any drift can reopen zero-value bypasses that disable anti-spam rate limits.

## Cancel Task Claim-Close Gotchas

- `cancel_task` cleanup now expects `remaining_accounts` triples in strict order: `(claim, worker_agent, worker_authority_rent_recipient)`. Tests and clients must pass all three per worker claim or cancellation will fail with input/account validation errors.

## `init_if_needed` Identity-Binding Gotcha

- For persistent PDA accounts that use `init_if_needed` (for example stake/state records), always enforce a stable identity binding on non-fresh accounts (`stored_pubkey == expected_pubkey`) before mutating balances/state. This prevents future refactors or migration edge-cases from silently accepting mismatched account identity.

## Solana Fender Triage Gotchas

- `solana-fender` can emit account-reinitialization heuristics for thin `#[program]` wrapper functions and non-Anchor Rust entrypoints (for example zkVM guest code). Treat raw findings as triage inputs; confirm exploitability against account constraints/owner checks and maintain a reviewed baseline gate.

## Solana Fender Heuristic Drift Gotcha

- Refactoring a large instruction into multiple helper functions can increase Fender medium heuristics (for example, helper-level "reinitialization" hits on pure parser/builder functions). Keep baseline regexes scoped to explicit helper names and re-verify exploitability after structural refactors.

## Baseline Source Tracking Gotcha

- Do not store new baseline source-of-truth files as `*.json` in this repo root/doc paths because `.gitignore` excludes new JSON files (`*.json`). Keep shared baseline config in tracked script/module files (for example `scripts/*.mjs`) and generate tracked JSON outputs from there.

## Anchor SBF Stack Diagnostics Gotcha

- `anchor build` can emit SBF stack-frame overflow diagnostics for an instruction while still returning exit code `0`; always scan build logs for `Stack offset`/`overwrites values` messages and treat them as release blockers.

## Tech Debt Sweep Gotchas

- Do not duplicate gateway transport state machines across clients (web/mobile). Shared auth, ping, reconnect, and offline-queue logic should live in one reusable module to avoid protocol drift.
- Root-level scripts must declare their own direct runtime dependencies (for example MCP SDK clients) instead of relying on transitive/workspace hoisting. Hoist-dependent scripts are brittle in clean CI or fresh installs.
- Cleanup paths should not silently swallow errors in production code. If failures are intentionally non-fatal, log at least `debug` with context so regressions remain diagnosable.

## Anchor Error Mapping Drift Gotcha

- Keep `runtime/src/types/errors.ts` Anchor error code/name/message tables synchronized with `runtime/idl/agenc_coordination.json`. Manual enum edits can drift after new on-chain errors are added and silently break `getAnchorErrorName`/`getAnchorErrorMessage` behavior for tail codes.

## Config Validator Monolith Gotcha

- Keep gateway config validation split by section helper functions (especially `llm` and `subagents`). Re-growing a single monolithic validator makes regression diagnosis and targeted tests significantly harder.

## Tech Debt Sweep Gotchas (2026-03-04 Skill Run)

- Keep replay ingestion record normalization in one shared mapper. Duplicating `toReplayStoreRecord`-style transforms across services invites subtle schema drift.
- Avoid copy/pasting status-filter logic across MCP tools. Shared enum-object status matching should live in a single helper to keep behavior aligned.
- Keep runtime orchestration methods below a maintainable size threshold in hot paths. Once flow methods grow into multi-hundred-line blocks, change risk spikes and review quality drops.

## Tech Debt Remediation Gotchas (2026-03-04 Post-Remediation)

- Keep WebChat handler factories (`create*Handler`) as thin dependency binders. Put orchestration in dedicated execution helpers so wiring and runtime behavior can evolve independently.
- For large LLM orchestration paths, keep a minimal public `execute()` entrypoint and move high-branch logic into named private helpers (planner verification loops, tool loops, evaluator loops) to reduce regression blast radius.

## Voice Hot-Reload Gotchas (2026-03-06)

- Do not capture `ChatExecutor` instances in long-lived voice or channel dependency objects. Config hot-reload swaps the executor and provider list; voice/session code must resolve the current executor via a getter at use time.
- xAI Voice Agent custom function tools use top-level `name` / `description` / `parameters` fields in `session.update.tools`. Do not reuse chat-completions nested `function: {...}` tool schema in realtime voice code.

## MCP Package Launch Gotchas (2026-03-06)

- For `npx`-launched MCP servers in `.mcp.json`, pin the command to a real published package and include `-y`. A typoed package name or an interactive install prompt can surface only as an opaque `initialize response` handshake failure during client startup.

## Delegation Contract Enforcement Gotchas (2026-03-06)

- Keep delegation/result enforcement centralized in `runtime/src/utils/delegation-validation.ts`. Direct delegation, planner orchestration, verifier checks, and final-response reconciliation must all consume the same contract and file-evidence rules.
- Do not treat `execute_with_agent` child completion as success based only on transport status. The shared validator must enforce the declared `inputContract`, reject malformed JSON/object outputs, and fail when acceptance criteria are contradicted by structured results.
- For delegated tasks that explicitly create or edit files, require both mutation evidence in child tool calls and artifact evidence in the child output, and apply the same evidence rules to final assistant prose before returning it.

## Desktop Delegation Hardening Gotchas (2026-03-06)

- Keep desktop-vs-host tool exposure centralized in `runtime/src/gateway/tool-environment-policy.ts`. Desktop-only mode must remove `system.*` tools from top-level chat, provider-visible tool schemas, subagent catalogs, and isolated session registries; filtering only one layer is not sufficient.
- For delegated desktop/browser tasks, separate context startup timeout from execution timeout in `runtime/src/gateway/sub-agent.ts`. Cold-start container/MCP setup must not consume the child execution budget silently.
- Guard overloaded delegated objectives before spawning a child. Multi-phase prompts that bundle setup, implementation, verification, research, and browser QA in one request should fail fast and force decomposition instead of timing out into bad parent fallbacks.
- Treat overloaded delegated work as a structured `needs_decomposition` control signal, not a generic validation failure. The parent planner must consume that signal and emit a smaller DAG; child sessions should stay least-privilege scoped and should not recurse by default.
- Desktop long-running command guards must parse actual shell command segments, not substring-match package names. `npm install ... vite ...` is dependency installation, not a foreground server launch.

## Delegation Triage and Scope Heuristic Gotchas (2026-03-06)

- When debugging delegated failures, inspect traced `execute_with_agent` arguments and results, not only UI cards or summary prose. Low-signal child calls such as `browser_tabs` with `{"action":"list"}` on `about:blank` are obvious in raw traces and easy to miss in collapsed output.
- Keep delegated phase classifiers action-based and narrow. Broad lexical triggers like `gameplay` or bare `test` cause false `needs_decomposition` rejects by misclassifying implementation work as research or research work as validation.
- Trace logs for delegated calls should preserve the child objective, contract, acceptance criteria, validation code, stop reason, and nested tool-call summaries so incident triage can identify the real failing tool path instead of a generic wrapper error.

## Narrative File Claim Guard Gotcha (2026-03-06)

- Final-response hallucination guards for file creation must distinguish explicit file artifacts from directory-only paths. A successful `mkdir -p /workspace/pong` followed by “Created the folder `/workspace/pong`” is valid filesystem mutation and must not be rewritten as missing file-write evidence.

## Simple Shell Observation Gotcha (2026-03-06)

- For single successful read-only shell observations such as `pwd`, `whoami`, or `date`, do not let the model replace the real command output with unsolicited shell tutorials or environment advice. If the follow-up ignores the actual stdout and drifts into generic guidance, collapse it back to the direct tool output.

## Grok Native Search Gotchas (2026-03-06)

- Do not force Grok research/doc-comparison turns through browser MCP when provider-native `web_search` is available. Browser tabs/snapshots are a worse fit for official-docs comparisons and create low-signal failure modes like `about:blank` or tab-list loops.
- Treat provider-native search as a real evidence path, not a prompt-only preference. If Grok research uses `web_search`, propagate `providerEvidence.citations` through `LLMResponse`, `ChatExecutorResult`, `SubAgentResult`, verifier checks, and delegated contract validation so research steps can pass without fake local browser tool calls.
- Keep browser MCP/Playwright for interactive page tasks only: localhost QA, DOM inspection, screenshots, clicks, typing, console/network debugging, and other page-state validation.

## Final Synthesis Grounding Gotchas (2026-03-06)

- Do not trust the final model pass to remember or summarize tool execution accurately from prior turns. Before any post-tool synthesis call, inject a bounded authoritative execution ledger built from actual `ToolCallRecord[]` and provider-native evidence.
- Keep the grounding ledger ephemeral to the provider call, not persisted in long-term session history. It should strengthen the final answer without bloating future turns or memory compaction.
- When the ledger must be compacted, preserve failed tool calls and recent successful calls first. Those records carry the highest debugging and truthfulness value for the final summary.
- The current execution ledger is phase-local. If a later phase must explain why an earlier phase chose a path, add a separate bounded phase-transition rationale record rather than stretching the execution ledger into cross-phase narrative memory.

## Grok Search Capability and Terminal Routing Gotchas (2026-03-06)

- Do not treat `llm.webSearch=true` as sufficient to advertise xAI server-side tools. Model capability matters: unsupported Grok models such as `grok-code-fast-1` must suppress `web_search` at advertisement time, routing time, and provider construction time.
- Keep provider-native search heuristics narrow. Broad words like `current` or `recent` will route `web_search` into normal shell/status turns and trigger provider 400s or unnecessary search costs.
- Treat terminal open and terminal close as separate routed intents. Reusing a cached "open terminal" cluster for "close the terminal" causes the model to loop on `desktop.window_list` instead of using direct tools like `mcp.kitty.close`.
- If `mcp.kitty.launch` / `mcp.kitty.close` is available, prompt and routing should prefer those direct tools over GUI-guessing fallbacks. Use `desktop.window_focus` + `desktop.keyboard_key` only when the direct close path is unavailable.

## Web Vitest Invocation Gotcha (2026-03-06)

- Run web package tests from `web/` or explicitly pass `--config web/vitest.config.ts`. Invoking `vitest` from the repo root skips the package `jsdom` config and produces false `document is not defined` / `Element is not defined` failures in React component tests.

## Doom Launch Normalization Gotcha (2026-03-06)

- When a runtime behavior already appears fixed in `runtime/dist`, still inspect the live `runtime/src` path before rebuilding. This Doom regression came from `chat-executor.ts` in source still calling tools with raw `parseResult.args`, even though the built artifact previously contained Doom resolution normalization.
- For Doom MCP launch flows, treat a failed `mcp.doom.start_game` as a round boundary. Follow-up calls like `set_objective` or `get_situation_report` depend on a running game/executor and should not execute in the same model-emitted batch after launch failure.

## Manual Foreground Daemon Logging Gotcha (2026-03-06)

- When recovering the daemon by starting `runtime/dist/bin/daemon.js` in the foreground, fresh trace logs may land on the live process stdout instead of `~/.agenc/daemon.log`. If `daemon.log` stops advancing after a restart, inspect the active daemon PTY before assuming trace logging is broken.

## Background Run Supervisor Gotchas (2026-03-06)

- Long-running webchat work must be owned by the runtime, not by a single LLM completion. A launched process or monitor is only setup state; the daemon must keep scheduling follow-up cycles until completion, block, failure, or explicit user stop.
- Ground background-run user updates against successful tool evidence. If a cycle only produced tool errors, do not publish the actor's optimistic narration; publish the error/retry state instead and keep supervising.
- Feed the next background cycle explicit prior tool evidence, not just the last assistant prose. Without that artifact, the actor tends to repeat bad status checks instead of recovering from the concrete failure it just saw.
- Keep background-run task text out of the foreground LLM session history. UI/history and memory can store those updates for the user, but if the raw objective and supervisor updates stay in `SessionManager`, unrelated follow-up requests inherit stale task context and the model continues the old job instead of answering the new question.
- Prompt-level “take one bounded step” guidance is not enough. Background cycles need hard runtime budgets for tool rounds/model recalls, otherwise the model will keep polling inside a single `execute()` call and starve the supervisor loop.
- Background runs also need runtime heartbeats while a cycle is still in progress. Waiting-state heartbeats alone do not cover slow provider/tool calls, and the session will look hung even when the supervisor still owns the task.

## Detached Desktop PID Semantics Gotcha (2026-03-06)

- For `desktop.bash` background launches, a detached wrapper shell PID is not the same thing as the real background workload PID. Return explicit fields (`launcherPid`, `backgroundPid`, `pidSemantics`) and only use `pid` as the primary PID after semantics are clarified, otherwise the model and user-facing summaries will report the wrong process identity.

## Structured Desktop Process Tooling Gotcha (2026-03-06)

- The desktop server `TOOL_DEFINITIONS` export in `containers/desktop/server/src/tools.ts` is the source of truth. `runtime/src/desktop/tool-definitions.ts` is generated from it by `npm --prefix runtime run generate:desktop-tool-definitions`, and runtime `build` / `test` / `typecheck` now fail fast on drift through `check:desktop-tool-definitions`.
- For long-running desktop work, prefer explicit `desktop.process_start` / `desktop.process_status` / `desktop.process_stop` over `desktop.bash` background heuristics. Start/status/stop semantics belong in structured tools; `desktop.bash` should stay the one-shot shell escape hatch.
- Do not write `/tmp/agenc-processes/registry.json` directly from managed-process lifecycle code. Persist through the serialized atomic writer in `containers/desktop/server/src/tools.ts` so overlapping `process_start` / `process_stop` / exit-hook updates cannot tear the registry file or publish out-of-order state.

## Daemon Startup Readiness Gotcha (2026-03-06)

- Do not treat daemon startup as “PID file appeared within 3 seconds.” The child process should report explicit readiness over IPC after `DaemonManager.start()` completes, and the parent CLI should wait on that readiness signal with a realistic startup budget. PID-file polling alone races slow startup paths like desktop manager/bootstrap and produces false negative `restart` errors even when the daemon is actually healthy.

## Desktop Doom MCP Image Gotchas (2026-03-06)

- Desktop MCP integrations must be installed into the desktop image itself, not assumed from prior local state. If the daemon expects `/usr/local/bin/<server>`, verify the image actually contains that launcher after every rebuild.
- The desktop image entrypoint runs requested commands through `sudo`, so MCP launchers and helper binaries must live on `sudo`'s secure path. Export non-secure-path binaries through the manifest-driven installer in `containers/desktop/install-secure-path-launchers.sh` plus `containers/desktop/secure-path-launchers.txt`; do not add ad hoc `/usr/games` symlinks inline in the Dockerfile.
- For Python MCP servers with package-relative imports, do not rely on `fastmcp run src/...` wrappers unless the upstream package guarantees that entry shape. A module-based wrapper like `python -c "from package.module import mcp; mcp.run()"` is safer inside the image.
- Treat Doom MCP startup as a first-class image smoke contract. After rebuilding `agenc/desktop:latest`, run `npm run desktop:image:doom:smoke` so regressions in launcher exposure, patch wiring, or MCP startup fail immediately instead of surfacing later in daemon logs.

## Doom Webchat Runtime Gotchas (2026-03-06)

- Doom MCP `start_game` defaults are not safe for user-facing launch prompts: omitted args fall back to headless, HUD-off, `RES_320X240`. Normalize `mcp.doom.start_game` in the runtime so visible launches force a real window, HUD, and a sane resolution before the call leaves the executor.
- Explicit "stop Doom" webchat requests should be runtime-owned, not model-owned. The model will often reach for `desktop.process_stop`, `kill`, or `sudo pkill`, but the game is owned by the Doom MCP. For webchat, short-circuit those requests to `mcp.doom.stop_game` directly.

## Durable Webchat Session Recovery Gotchas (2026-03-06)

- WebSocket `clientId` is not a durable session identity. If webchat resume/list behavior needs to survive reconnects or daemon restarts, the browser must supply a stable client-owned key and the runtime must persist session ownership/index metadata against that key.
- Rebinding a resumed webchat session to the socket is not sufficient on its own. After daemon restart, the foreground `SessionManager` history must be rehydrated from persisted memory before the next user turn, or the model will answer from a blank local session despite the runtime having durable thread history.
- Runtime-owned background updates should still advance durable session metadata even while no browser socket is attached. Otherwise recovered background work continues in memory, but `chat.sessions` / `chat.resume` metadata lags behind the real task progress after restart.

## Durable Background Run Context Gotchas (2026-03-06)

- Restart durability alone is not enough for a real supervisor loop. If active runs only keep a rolling `slice(-N)` transcript, long-lived work will still lose the operator’s intent and verified state even though the run itself survives.
- Treat follow-up user messages during an active background run as runtime signals, not as an automatic cancel-and-replace. Cancelling on every operator intervention collapses the task runtime back into a bounded chat model.
- Carry-forward state must stay compact and explicit: summary, verified facts, open loops, and next focus. Dumping raw prior history back into the actor prompt defeats the point of durable supervision and recreates long-context drift.

## Background Run Signal-Tail Gotchas (2026-03-06)

- Do not flip a background run from `running` to `working` until the cycle tail is actually done. If the state changes early, a late signal can schedule overlapping cycles or skip the current cycle's deterministic completion path.
- Carry-forward compaction must only consume the signal snapshot it actually summarized. Clearing the whole `pendingSignals` array drops late-arriving process/operator events and forces a timer fallback even when the runtime already has decisive evidence.
- If a fresh external signal is still pending at the end of a working cycle, do not publish the stale working update first. Re-wake immediately on the pending signal or finish deterministically from the verified runtime event.

## Background Run Control Plane Gotchas (2026-03-06)

- Bare session-control messages like `status`, `stop`, `pause`, and `resume` must be runtime-owned. Do not let them fall through to the model when the session is in or near a background-run workflow, or the model will reinterpret them as general tool-use prompts and do something unrelated.
- Keep a persisted recent-run snapshot per session even after terminal completion. Without that, runtime-owned `status` after completion regresses to `No active run` with no operator context, and bare control messages lose the last known task state after the active in-memory run is deleted.
- `pause` is not `stop`. Treating `pause` as a stop-regex alias silently destroys durable work instead of preserving it for later resume.
- Queued operator instructions while paused should stay queued but must not wake the run until an explicit resume. Otherwise paused state is only cosmetic and the runtime keeps acting behind the operator’s back.

## Desktop Restart Recovery Gotchas (2026-03-07)

- A durable background supervisor is not actually durable if daemon restart destroys the tool environment it depends on. For desktop-managed processes, `DesktopSandboxManager.stop()` must preserve live containers and `start()` must recover them from Docker inspect data instead of blindly deleting every labeled container as an “orphan.”
- Recovered desktop sandboxes need more than a container ID. The runtime must rebuild session mapping, auth token, port bindings, resolution, and resource metadata before follow-up `desktop.process_status` calls can reattach to the same workload.
- Live websocket resume tests must use a stable `clientKey`. `chat.resume` is owner-scoped by design, so reconnect tests with a throwaway websocket client and no durable client key will fail even if the runtime recovery path is correct.
- Once outbound messages are persisted to history/session metadata before socket delivery, “no client mapping” during daemon restart is expected. Keep that path at debug level; warn-level logs turn normal reconnect windows into incident noise.
