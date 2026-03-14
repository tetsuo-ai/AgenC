## 2026-03-08
- `approvals.enabled` must be the source of truth. Constructing `ApprovalEngine` unconditionally reintroduces blocking even when operators think approvals are off.
- Desktop click/type/scroll automation should not live in baseline approval defaults. Keep it behind `approvals.gateDesktopAutomation` so normal interactive workflows do not deadlock.
- When `tool:before` hooks abort execution, return the actual policy reason to the caller instead of a generic `"blocked by hook"` error, or incident triage becomes guesswork.
- Greeting suppression, low-score delegation vetoes, and broad side-effect dedupe are planner heuristics, not execution-time invariants. When they hard-block tools, they look like random policy failures to users.
- Trace logs must be serialized as JSON strings, not raw logger object args, or nested request/response diagnostics collapse into `[Object]` and become useless for incident replay.
- Raw provider payload capture must stay behind `logging.trace.includeProviderPayloads`; it is the right tool for exact incident repros, but it duplicates prompt/tool data and will bloat logs if left on casually.
- Direct `LLMProvider.chat(...)` and `chatStream(...)` calls take trace capture under `options.trace`, not as top-level option fields. Top-level `includeProviderPayloads` only belongs on `ChatExecutor.execute(...)`.
- Trace previews are not evidence. If a trace line summarizes or truncates arrays, pair it with an exact artifact reference so routed-tool investigations can distinguish preview limits from real provider payload mismatches.
- For traced `ChatExecutor` surfaces, provider payload traces and executor-state traces must share the same trace ID. If each callback builds its own timestamp-based ID, the execution journal fragments and incident replay stops being authoritative.
- Trace artifact sanitizers must only mark true recursion cycles. If they treat any repeated object/array reference as `"[circular]"`, exact fields like `missingRequestedToolNames` become corrupted even though the runtime data was correct.
- Trace preview logging and artifact persistence must share the same core serializer. If each boundary keeps its own object walker, log previews and stored artifacts will drift again the next time binary sanitization or truncation rules change.
- Operator-facing trace artifact fetches must stay trace-bound. Do not expose raw artifact paths directly to WebChat clients without proving the artifact belongs to an owned trace first.
- The web package needs `@types/node` when it imports runtime source types that reference Node builtins. Type-only cross-package imports are still compiled by `tsc`, so missing Node types will break the web build.

## 2026-03-09
- For runtime or subagent incident triage, start from `~/.agenc/daemon.log` for the exact `sessionId`/`traceId` before trusting UI summaries, payload previews, or artifact snippets. The trace lines are the authoritative execution journal.
- Tool-routing intent cache must not blend the previous user turn into a strong current typed-domain prompt. Explicit artifact prompts like email/calendar/pdf/sqlite/spreadsheet/docx need current-turn routing to dominate or stale clusters will keep the wrong tool family hot.
- For typed artifact families that require both metadata and content reads, routing the tools is not enough. Add staged contract guidance (`info` first, then `read`/`extract`) or the model will often stop after the first successful metadata tool call.
- Autonomy-ladder stage budgets need to reflect real multi-call contracts. Once a typed artifact rung becomes `info -> read -> final answer`, a 20s budget is too tight for live provider latency even when the runtime path is correct.
- Contract guidance must resolve against the full allowed tool universe, not only the currently active routed subset. Otherwise required follow-up tools like `mcp.doom.set_objective` disappear after the first turn even though the runtime contract still requires them.
- Tool-call permission checks must validate against the tool subset actually attached to the response-producing model call, not a stale generic routed subset. Otherwise contract-forced tools can be offered to the model and then rejected locally during execution.
- Final synthesis should inherit the current active routed subset unless a narrower override is explicitly requested. Falling back to the broad initial route reopens irrelevant tools and adds avoidable latency on verification-heavy tasks like Doom.
- Daemon trace helpers are shared runtime primitives, not one-off webchat utilities. When moving them, carry the full primitive set (`createTurnTraceId`, `summarizeTraceValue`, tool-failure types) or channel handlers will compile but fail at runtime on the first traced turn.
- When a runtime contract narrows the next step to one deterministic tool, do not leave provider selection as streamed `"required"`. Force a named function `tool_choice` and use plain `chat` for that turn, or Grok can burn ~60s deciding the only legal tool and trip the no-chunk stall timeout.
- Live operator TUIs must never render raw `data:image/*`, long base64 blobs, or full tool JSON bodies directly into the feed. Sanitize binary-like payloads, summarize structured results, and cap per-event body lines or one tool result will destroy the screen.
- Rich ANSI styling is safest on fixed-width rows only. If a Live TUI needs wrapped content, wrap the plain text first and then style the final line fragments, or escape-sequence clipping will eventually leak into the layout.
- Watch/preview scripts must not import local dependencies through workspace-specific absolute paths like `/workspace/...`. Use repo-relative imports (for example `../node_modules/...`) or package imports so the tools run in tmux, local shells, and symlinked workspaces.
- `chat.usage`, `run.inspect`, and similar internal sync events should update summary chrome, not dominate the main operator feed. Surface them only as compact metrics unless the operator explicitly requests raw detail.
- The Live TUI only feels theatrical when the operator pane keeps enough width for the header chrome and summary blocks. If tmux steals too many columns for adjacent panes, switch to compact mode or rebalance the split before tweaking colors again.
- In a side-by-side stream layout, the live pane and trace pane need the same visual language. If one looks like a themed console and the other looks like a stock logger, the whole presentation collapses back into "debug tooling" no matter how polished the left pane is.
- Grok provider continuity is opt-in at the runtime config layer. If `llm.statefulResponses` is omitted, daemon traces will show `previous_response_id: null` and no provider-side compaction even when prompts are large; apply explicit defaults at gateway startup if continuity is a baseline requirement.
- Memory ingestion hooks must treat `session:compact` `phase: "after"` payloads without a generated summary as expected no-ops. Manual or local compactions often emit `summaryGenerated: false` with no `summary`, and warning on that path pollutes `~/.agenc/daemon.log` during endurance triage.
- The runtime package cannot rely on `npm run build --prefix ../sdk` alone when `@agenc/sdk` is installed as `file:../sdk`. `tsc` and runtime builds read `runtime/node_modules/@agenc/sdk`, so build/typecheck/test scripts must refresh that local copy before checking or bundling.
- `runtime/scripts/generate-desktop-tool-definitions.ts` imports `containers/desktop/server/src/tools.ts`, which resolves through the repo-root dependency graph instead of `runtime/node_modules`. If the root `@solana/spl-token` pin drifts behind runtime/sdk, the generator can fail even while runtime-local builds look healthy.
- Planner-mode provider output is not guaranteed to stay in strict JSON. Grok can emit direct function calls from the planner turn; salvage those tool calls into deterministic planner steps instead of treating them as `planner_parse_failed`, or repeated child-memory recall will fall back to a less stable path.
- Child-session secret sanitization must distinguish recall from store turns. Rewriting `TOKEN=...` literals is correct for delegated recall prompts, but doing it on the initial child store turn prevents the subagent from learning the value and makes continuity bugs look like compaction failures.
- Exact-response endurance prompts need alias-aware literal extraction and delegated suffix restoration. Prompts like `return ... as TOKEN=ONYX-SHARD-58` and child replies that only return `ONYX-SHARD-58` still need to reconcile back to the parent contract exactly.
- The tmux live watch client needs persisted `ownerToken` state, not just `clientKey`, if the same operator session should survive reconnects and window respawns without silently creating a new chat session.
- Delegated child output can mix a contract string and a JSON object in the same response. Normalize embedded JSON payloads before session-handle rewriting, or `childSessionId`/`subagentSessionId` continuity breaks even when the child actually returned the right handle.
- Placeholder exact-output contracts like `TOKEN=<memorized_token>` need their own validator path. Treat them as exact-shape contracts, not generic token-evidence checks, or delegated recall will fail with `acceptance_evidence_missing` even when the child returns the correct real token.
- Keep delegated child-memory prompt shaping and validator-side exact-output parsing on the same helper surface. If token placeholder rewriting, JSON-hint stripping, or exact-output matching drift into separate files again, store/recall fixes will silently diverge.
- Keep planner parse-plus-salvage behavior behind a dedicated normalizer instead of merging diagnostics inline in `ChatExecutor`. Provider-fragile planner output is a compatibility layer, not executor orchestration logic.
- Keep `execute_with_agent` runtime orchestration out of the generic session tool handler. Approval/routing/notify plumbing and delegated child-session lifecycle have different failure modes; mixing them turns every child-memory fix into a factory-file regression risk.
- Keep the planner pipeline retry/verifier loop in its own helper module. It carries separate policy state (`maxRounds`, verifier confidence, retry diagnostics) and becomes unreadable quickly when left inline beside the rest of `ChatExecutor`.
- Keep web-session continuity helpers on a dedicated gateway module. Stateful option shaping, persisted web runtime-state keys, and post-turn lineage anchor persistence must stay together or reset/hydration paths will drift and silently break provider continuation.
- Keep shared text-channel turn execution off the daemon methods. Telegram and external-channel turns should share one traced execution helper plus a small daemon-side tool-handler factory, or provider/trace/session fixes will fork again across channels.
- Keep the full webchat conversation turn off `daemon.ts`. Abort-controller wiring, trace capture, stateful session carry-forward, browser usage updates, and synthesized subagent events belong on one dedicated helper surface, with the daemon only owning trace/lock maps and bridge callbacks.
- Voice observability must stay trace-compatible with webchat observability. If tool trace event names, payload fields, or sanitization rules change in the daemon traced-tool wrapper, update `runtime/src/gateway/voice-bridge.ts` in the same change or extract the wrapper into shared code, or the Logs pane will silently lose voice parity again.

## 2026-03-10
- Security checks and validation examples must fail closed by default. Do not ship `--allow-fail`, `--no-audit`, unsigned webhook acceptance, or env-driven trusted-endpoint bypasses as the default path.
- Soak report JSON is a summary, not proof. For local social runs, verify required behavior from per-agent daemon traces (`webchat.inbound`, `webchat.tool_routing`, `webchat.provider.request/response`, `webchat.executor.*`, `webchat.chat.response`) before calling a turn correct.
- Explicit deterministic tool requirements must be derived from the union of the initial routed subset and the expanded routed subset. If cached routing drops a user-named tool like `social.getRecentMessages` from the initial allowlist, planner enforcement will validate the wrong contract unless the expanded subset is merged back in.
- If a turn has an explicit deterministic tool contract, put that contract into the first planner prompt, not just the refinement prompt. Otherwise planner repair becomes the normal path and latency scales with model drift.
- On-chain agent registration only accepts `http://` or `https://` endpoints, but the social messaging transport is WebSocket. Runtime off-chain messaging must normalize registered `http(s)` endpoints to `ws(s)` before connecting, or local/social bring-up will fail in one direction or the other.
- Doom background supervision prompts must not accidentally re-trigger the foreground Doom setup contract. When a background cycle needs Doom MCP tools after an initial launch, scope contract inference to the explicit background-objective section or carry structured run metadata instead of letting carry-forward/tool-evidence prose drive relaunch gating.
- Doom background recovery must preserve the exact recovery objective, not a prose approximation. If the first turn launches `hold_position` with movement constraints like `no_strafe`, `no_back_forth`, or `smooth_movement`, carry those exact args into the background run and reapply them on idle/restart recovery.
- Dialogue-only suppression heuristics must treat explicit dotted tool references like `social.searchAgents` or `social.sendMessage` as real tool-invocation cues. Otherwise exact-response prompts can zero the routed allowlist and produce `empty_allowlist` hallucination paths instead of executing the named tools.
- In local multi-daemon tmux runs, the foreground pane and the configured daemon log file must show the same execution journal. If `AGENC_DAEMON_LOG_PATH` is not actually backing the foreground process, fix that first or every trace bundle and `observability.logs` export will be incomplete.
- The social tmux launcher should tail the per-agent log files in its `LOGS` window, not the legacy shared `~/.agenc/daemon.log`. Otherwise operators will debug one daemon in the pane while the persisted evidence comes from another process.
- Peer-to-peer social DMs must not be replayed through webchat as assistant replies. Surface them as transport-only events (for example `social.message`) or a dedicated peer-message role, otherwise the receiving agent's chat history gets polluted with messages it never authored.
- When the live tmux watch client reconnects after daemon startup, emit an explicit success event in the pane. Leaving only the initial `WS-ERROR` visible makes a healthy localnet stack look broken until some unrelated tool or social event arrives.
- Exact-output contracts must not survive failed tool execution unchanged. If a turn hits tool errors and the model still returns a success sentinel like `R2_DONE_A2`, reconcile it into an explicit failure summary before showing it to the operator.
- Imperative prompts that literally say to `use` or `call` a named tool need contract guidance on the initial turn. Otherwise single-tool turns like `social.requestCollaboration` can fall through the direct path and return no tool calls at all.
- Stateful Grok continuation must not persist `previous_response_id` anchors for empty assistant turns with no tool calls. Those anchors poison the next request and can surface as opaque provider 400s instead of a local recovery path.
## 2026-03-10 - Localnet social soak readiness must use fresh logs

- When booting the 4-agent localnet social stack, do not trust persisted daemon logs without truncating them first.
- If the launcher waits on `Gateway started on port ...` / `Messaging listener started on port ...` / `Daemon started {` markers, stale log lines can create a false-ready signal.
- The safe pattern is:
  - truncate the per-agent log before launching the foreground daemon
  - require both TCP port readiness and the fresh log readiness markers before starting soak traffic
- Keep that readiness contract in one module, [agenc-social-readiness.mjs](/home/tetsuo/git/AgenC/scripts/agenc-social-readiness.mjs), so the launcher and soak runner cannot silently drift.

## 2026-03-10 - Keep the repo prover surface remote-only

- Do not reintroduce `agenc-zkvm-host`, `zkvm/methods`, vendored `ark-*` patches, or any `local-binary` prover backend into the repo workspace unless upstream RISC Zero/Boundless audit clean again.
- The safe pattern is:
  - keep `zkvm/` limited to shared schema types
  - send proof generation through an authenticated remote prover endpoint
  - treat local prove/build toolchains as external infrastructure, not repo dependencies

## 2026-03-10 - ZK image trust must come from `zk_config`, not hardcoded SDK/program constants

- Do not hardcode the trusted RISC Zero image ID in `complete_task_private` or SDK preflight paths.
- The safe pattern is:
  - store the active trusted image ID in the on-chain `zk_config` PDA
  - make the program read that PDA during `complete_task_private`
  - make SDK preflight/wrappers read `zk_config` instead of assuming a local constant is authoritative

## 2026-03-11 - Request-tree breaker traces must log structured usage, not opaque strings

- If a delegated child request-tree circuit breaker trips, the emitted `subagents.failed` payload must include the breached limit kind plus the actual per-step and cumulative usage counters.
- Logging only the threshold string forces operators back into provider artifacts to infer what happened and breaks the “logs are the source of truth” contract.

## 2026-03-11 - Default child request-tree headroom must scale with planner budget hints

- A flat default like “150k tokens per planned subagent step” underbudgets long coding phases and overbudgets short research phases.
- When no explicit operator ceiling is set, derive request-tree child-token headroom from the planner’s `max_budget_hint` durations, then apply retry/verifier pass multipliers on top of that derived per-step envelope.

## 2026-03-12 - Execution turns must fail closed on plan-only completions

- If a coding or file-mutating turn can be grounded with tools, do not accept a bare `Plan` reply as `completed`.
- Keep two layers aligned:
  - the daemon system prompt must be execute-first for tool-using turns
  - the executor must locally reject or retry plan-only completions even if the model ignores that prompt
- Live watch UIs should also avoid mixed-state headers like `idle / thinking`; contradictory chrome makes backend retries look like hangs.

## 2026-03-12 - Live watch layout must fit whole panels and follow current source writes

- In `agenc-watch`, never truncate the sidebar by slicing a raw stack of panel rows to viewport height. Fit whole panels or compact them first, or borders and metric rows will get cut off mid-box.
- In follow mode, recent source-preview events should anchor the viewport. Blind bottom-following hides the code being written behind later summary rows and makes the operator surface look stale even while writes are happening.

## 2026-03-12 - Watch surfaces must not mix direct `subagents.*` messages with observability replay as independent UI events

- `agenc-watch` receives both typed websocket lifecycle messages and the generic `events.event` observability feed for subagent activity.
- If both feeds are rendered independently, the transcript duplicates `spawned/started` rows and anonymous top-level lifecycle events create ghost `child` plan entries that never retire.
- The safe pattern is:
  - treat typed `subagents.*` messages as the operator surface source of truth
  - use `events.event` only for raw diagnostics or explicit observability views
  - never create a persistent plan step when a lifecycle payload has no `subagentSessionId`, `stepName`, or `objective`

## 2026-03-12 - Top-level delegation lifecycle events must include the delegated objective

- Parent-side `subagents.planned` and `subagents.policy_bypassed` events are operator-facing, not just internal telemetry.
- If those payloads omit the delegated task text, the live watch can only show anonymous filler like `child` or `Delegation planned`, which makes the surface feel broken even when the runtime is behaving correctly.
- When emitting top-level delegation lifecycle events from `execute_with_agent`, include the normalized delegated task/objective in the payload.

## 2026-03-12 - Recall budget defaults must not silently cap healthy autonomous runs

- `ChatExecutor` previously treated an omitted `llm.maxModelRecallsPerRequest` as a hidden hardcoded cap of 24, and treated `0` as zero recalls instead of unlimited.
- That drift is especially dangerous because other runtime surfaces were already using `0` as the intended "unlimited" value for autonomous/background work.
- Keep the semantics aligned: `0` or omitted means unlimited recall budget, while request timeout, tool budgets, failure budgets, and no-progress breakers remain the real stop conditions.

## 2026-03-12 - Live codegen benchmarks should reveal routing bugs, not hide them with prompt policy

- If a streamed benchmark prompt includes hard tool rules like "use only host code/file/system tools," the run stops being a realistic autonomy test and starts becoming a routing workaround.
- The right fix is to make natural coding prompts route to the correct host file/code tools in `tool-routing.ts`, then verify that behavior from daemon traces.
- The live benchmark prompt should stay normal-language, while any routing failure is treated as a runtime/logging bug to patch and regression-test.

## 2026-03-12 - xAI Responses `store:false` must not use `previous_response_id`

- The xAI Responses docs and live daemon traces agree: `store:false` requests should continue locally via replayed `response.output`, not by sending `previous_response_id`.
- If the Grok adapter still sends `previous_response_id` while `store:false`, xAI responds with `404 Response ... not found` and every delegated follow-up pays an avoidable stateless retry.
- Treat `store:false` as a local-replay-only mode in the adapter and emit an explicit `store_disabled` fallback reason so the trace explains why provider continuation was skipped.

## 2026-03-10 - Newer SBF toolchains expose stack overflows in large Anchor `Accounts` validators

- `cargo-build-sbf --tools-version v1.52` surfaced 4 KB frame overflows that the older local toolchain was not blocking on.
- The minimal fix in this repo was to `Box<Account<...>>` the large accounts in heavy validation structs instead of pretending the old `.so` was still acceptable.
- If local deploys suddenly fail on `try_accounts` frame size, inspect the failing `#[derive(Accounts)]` struct first.

## 2026-03-13 - Hooks that mirror object props into state must short-circuit equal snapshots

- `web/src/hooks/useRuns.ts` hit a render loop because a `useEffect([backgroundRunStatus])` mirrored a freshly allocated capability object into local state on every render.
- This is easy to miss in tests because `renderHook(() => useHook({ someObject: makeObject() }))` recreates the prop object every pass even when the values are identical.
- Safe pattern:
  - avoid storing pure derived objects in state when possible
  - if you do mirror them, compare the meaningful fields and return the existing state when nothing changed
  - in hook tests, prefer stable fixtures or `renderHook` props over inline `makeObject()` calls for object inputs

## 2026-03-13 - Web tests on Node 25 should not touch bare storage globals

- Node 25 exposes experimental web-storage globals, and touching the wrong getter during Vitest/jsdom setup can emit `--localstorage-file was provided without a valid path`.
- In this repo, the safe pattern is:
  - install a deterministic in-memory shim in `web/src/test-setup.ts`
  - read/write browser storage via `window.localStorage` or a helper that resolves from `window`
  - avoid probing bare `localStorage` during setup-file evaluation

## 2026-03-13 - File-link display text and hyperlink targets must be normalized separately

- In the watch TUI, visible file references should preserve the operator-facing suffix style they already carry, such as `path/to/file.ts:18`.
- Hyperlink targets need stricter normalization, for example `file:///...#L18`, so terminals can open the right file location reliably.
- If the same normalization step is reused for both display text and href generation, the UI regresses from familiar `:line` suffixes to raw `#Lline` fragments and breaks existing expectations.

## 2026-03-13 - Watch transcript cards must not reuse the first preview line as both headline and body

- In `agenc-watch`, agent and user cards derive their visible headline from the first preview line when available.
- If that line is not consumed from the body preview, the transcript shows a duplicated card with the headline repeated immediately below it behind a body guide, which reads like a rendering bug rather than useful emphasis.
- Generic meta rows like `Agent Reply` and `Prompt` also add visual noise when the headline already captures the useful content, so suppress them for the default card shapes.

## 2026-03-13 - Stream completion and final message reconciliation are two separate watch states

- The websocket `chat.stream` `done` signal means the chunk stream ended, not that the transcript card is safe to finalize.
- If the watch surface flips the live agent event to `complete` before the subsequent `chat.message` reconciles the final body, the final message path cannot find the live card and creates a duplicate agent event.
- Keep a pending-final state until `chat.message` commits the final body into the existing live card.

## 2026-03-13 - Watch `@file` tags should stay literal and watch-local until there is a real multi-kind mention contract

- For the operator TUI, `@runtime/src/foo.ts` is currently a UI convenience, not a runtime protocol object.
- Keep the stored prompt/history/export text literal, drive autocomplete from a bounded repo-local file index, and reuse the existing file-link/terminal renderer for display styling.
- Do not introduce hidden mention IDs, generalized plugin/app tags, or cross-workspace lookup just to support file tags in the watch surface.

## 2026-03-14 - Inline watch file links need render metadata before wrapping

- If inline `@file` tags or plain file references are compacted to display text like `@runtime/…/types.ts:12`, render-time regex alone no longer has enough information to build a reliable OSC 8 href.
- The safe pattern is:
  - attach inline file-reference metadata during normalization/compaction
  - preserve that metadata through wrapping
  - inject styling and hyperlinks from the preserved render object in `renderDisplayLine()`
- Do not try to reconstruct hyperlink targets from already-compacted display text after wrapping.

## 2026-03-14 - Watch inline file rendering must keep one canonical segment model

- The watch TUI now has two distinct file-reference sources:
  - structured file-link metadata on events
  - inline file-reference segments derived from literal transcript text
- The render layer must not keep both `inlineFileReferences` and `inlineSegments` alive at the same time for text-bearing lines.
- Keep `file-link` entries authoritative when explicit event metadata exists, and use `inlineSegments` as the only inline render model for compaction, wrapping, styling, and OSC 8 hyperlink emission.

## 2026-03-14 - Wrapped watch lines must not rebuild cwd-sensitive inline file links

- `wrapRichDisplayLines()` may receive already-normalized lines with inline file-reference metadata and hrefs built from a specific `cwd`.
- If wrapping re-runs file-link normalization on those lines without the original options, relative or compacted quoted paths can be rebuilt against `process.cwd()` and silently point at the wrong file.
- Preserve existing `inlineSegments` and only normalize lines that have not already gone through the file-link compaction path.

## 2026-03-14 - Watch controller extractions should own timers and event-family logic, not leak it back into the entrypoint

- For the operator console, pulling code into a helper file is not enough if `agenc-watch.mjs` still manually owns the same reconnect timers, bootstrap retries, or event-family switch logic.
- The safer pattern in this repo is:
  - keep `agenc-watch.mjs` as the composition root
  - move command/input/transport/planner/subagent behavior behind explicit controller factories
  - pass state and callback dependencies into those controllers instead of re-importing globals from the entrypoint
- This keeps the watch surface aligned with `REFACTOR-MASTER-PROGRAM.md` and makes later package/repo extraction plausible instead of cosmetic.

## 2026-03-14 - A refactor is not complete while the old hotspot still lives in the entrypoint

- For the watch TUI, landing a new controller module without deleting the old inline frame/layout logic left two sources of truth and made the refactor look finished when it was only half wired.
- The safe close-out rule is:
  - instantiate the extracted controller in the real entrypoint
  - switch the entrypoint to thin delegation wrappers
  - physically remove the displaced inline implementation
- add at least one direct seam test so the new boundary is proved independently of the giant top-level suite
- If the old hotspot is still present in the entrypoint, the refactor is still in progress.

## 2026-03-14 - Copying a large entrypoint into a new module can silently revive stale helper dependencies

- When `scripts/agenc-watch.mjs` was copied into `scripts/lib/agenc-watch-app.mjs`, the new module still referenced helper names that had already been extracted elsewhere (`activePlanEntries`, `activeAgentEntries`, and the old transcript mutators).
- A boundary move is not complete just because the file path changes; copied modules must be audited for stale helper references before the new seam is considered real.
- The safe pattern is:
  - convert the copied file into the new lifecycle/module shell
  - replace old inline helpers with the new seam objects immediately (`eventStore`, frame controller helpers, wrapper lifecycle)
  - run direct seam tests before trusting the full watch matrix

## 2026-03-14 - Frame-level watch regressions show up first in header row count and snapshot drift

- The operator-console header is now dense enough that adding a chip row or active-status row changes `headerRows`, which changes body height and every downstream layout assertion.
- When changing watch chrome, update the pure frame snapshot expectations and any layout tests in the same pass instead of treating those deltas as incidental fallout.
- The safe pattern is:
  - keep one shared visible-frame builder for render and snapshot tests
  - freeze time/animation in the frame harness
- let exact snapshot failures drive intentional fixture updates instead of weakening the assertions

## 2026-03-14 - Live replay fixtures must stay at the daemon envelope layer

- The watch replay harness can look end-to-end while still missing the real production seam if tests inject already-normalized `surfaceEvent` objects.
- For operator-console replay coverage, the minimum acceptable input is the raw websocket envelope shape:
  - direct control-plane messages like `status.update`, `chat.session`, and `chat.stream`
  - wrapped `events.event` payloads with `{ eventType, data, timestamp }`
- The harness should load the real operator-event helpers by default so replay tests fail if normalization drifts or the runtime artifact is missing.

## 2026-03-14 - Diff navigation is safest on control characters, not printable keys

- The watch composer stays active while detail is open, so printable diff-navigation shortcuts would steal normal typing when an operator wants to keep composing with detail visible.
- `ctrl+p` / `ctrl+n` work better for hunk navigation because they do not collide with ordinary prompt text and can be gated cleanly on diff-detail mode.
- Keep explicit non-regression tests proving the shortcuts are ignored outside diff detail mode.

## 2026-03-14 - Watch live replay harnesses must inject the same timer functions the app uses

- The first replay harness pass looked wired correctly but still failed to submit prompt input because `createOperatorInputBatcher(...)` was quietly using global timers instead of the fake replay clock.
- For watch-app replay, it is not enough to fake websocket and stdout. Every queued path that affects lifecycle or input dispatch must share the same injected timer source:
  - app startup timers
  - reconnect/bootstrap timers
  - frame render timers
  - operator input batching timers
- If one of those paths keeps real timers, replay checkpoints can look deterministic while missing actual queued work.
