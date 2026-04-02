# Gotchas

Last updated: 2026-03-25

- The workspace root `/home/tetsuo/git/AgenC` is the umbrella git repo again.
  Use plain `git ...` here, and `git -C <nested-repo> ...` for sibling repos.
- Do not assume historical split-era notes are current. The live note set is in
  root `.claude/notes/`, while `.claude/history/umbrella-repo-notes/` is
  historical only.
- Do not confuse the public umbrella surface with the product itself. The
  actual framework/runtime/operator product lives in `agenc-core`.
- Do not confuse the website with the product runtime. The website and docs are
  public entry surfaces; they are not proof that users can run the product from
  there.
- Do not drift back into the old private-framework assumption. The current
  product direction is public framework + private services where they create
  real advantage.
- When an ADR is superseded, the historical ADR must keep an explicit
  superseded header and point at the replacement ADR. Otherwise readers will
  keep treating historical boundary policy as active product direction.
- Do not let the web UI become a second runtime. TUI and web must stay as
  sibling clients of the same daemon/gateway.
- `agenc-core` has an explicit `test:cross-repo-integration` target because
  some runtime LiteSVM tests depend on protocol workspace fixtures and should
  not be mistaken for pure package-local tests.
- `target/` at the workspace root is local/generated state, not a canonical
  public contract. Public protocol truth lives in
  `agenc-protocol/artifacts/anchor/`.
- Public examples at the root must stay clean of private runtime imports and
  assumptions about local `runtime/`, `mcp/`, or private core builds.
- When adding root-level example shortcuts or onboarding docs, mirror every
  required environment variable in the root docs. The Helius example fails fast
  without `HELIUS_API_KEY`, and the server path also needs
  `HELIUS_WEBHOOK_SECRET`.
- `agenc-core/runtime/src/gateway` is by far the largest module cluster in the
  workspace. A lot of product behavior and integration risk concentrates there.
- `agenc-protocol` is not just an artifact wrapper. It contains a real Anchor
  program plus zkVM guest code.
- Subagent crawling is currently unreliable in this workspace because explorer
  calls hit a model-usage-limit error. If the same error appears, continue the
  crawl locally instead of blocking.
- Do not use `process.chdir(...)` inside Vitest worker tests here. Stub
  `process.cwd()` instead or the worker pool will throw and the CLI tests will
  fail nondeterministically.
- Do not maintain two browser-facing Concordia bridge paths. `agenc-core/web`
  should launch through `@tetsuo-ai/plugin-concordia`, while the Python side
  should stay focused on runner, event, and control services.
- `AGENC_CONFIG` and the canonical default path must point to canonical gateway
  config, not the old flat runtime JSON. Only `--config` and
  `AGENC_RUNTIME_CONFIG` are allowed to select a legacy compatibility file.
- Public runtime artifact smoke cannot assume unpublished workspace packages
  exist on npm. If the runtime tarball depends on local workspace packages, the
  artifact builder must pack and install those workspace tarballs alongside the
  runtime tarball.
- If the public install contract says `agenc` installs runtime artifacts from
  GitHub Releases, the release-hosting repo itself must be public. Otherwise the
  “no-auth install” story is false.
- Wrapper-managed upgrades must not hand daemon/TUI/service templates a
  versioned runtime path. Use the stable `~/.agenc/runtime/current` pointer and
  wrapper-provided entry overrides instead.
- The repo-root `bin/` ignore rule will silently swallow package-level CLI
  entrypoints like `packages/agenc/bin/*.js` unless they are explicitly
  unignored. When adding a new shipped CLI wrapper, verify the bin files are
  tracked in git, not just present in the local worktree, or CI packaging will
  pack a broken install surface.
- `npm pack` output cannot be moved from the repo into a temp-root smoke
  directory with `rename(...)` when those paths live on different filesystems.
  Use `copyFile(...)` plus `unlink(...)` in install/release smoke harnesses.
- Node 18 does not provide `globalThis.File`, but `undici@7` expects it during
  module initialization. If the public bins claim Node 18 support, install the
  `node:buffer` `File` shim before importing CLI/daemon/watch modules.
- The daemon-backed dashboard is only shippable when the web bundle is built
  with `AGENC_DASHBOARD_BASE=/ui/` and then synced into
  `agenc-core/runtime/dist/dashboard/`. Any `--skip-build` release or smoke
  lane must prove that `runtime/dist/dashboard/index.html` already exists.
- Do not freeze the dashboard websocket URL at module load in the web client.
  Resolve the default WS URL at render time so `?ws=...` overrides and the
  live same-origin dashboard URL both work in tests and in the packaged
  `/ui/` runtime surface.
- Connector lifecycle state has to propagate through every status surface:
  `GatewayStatus.channelStatuses`, `runtime/src/browser.ts`,
  `runtime/src/channels/webchat/types.ts`, the watch status fingerprint, and
  the dashboard status view. If any one layer omits it, connector-only changes
  stop repainting in at least one client.
- `agenc onboard` must stay dual-mode: only launch the interactive TUI when
  stdin/stdout are real TTYs and the caller did not request `json`/`jsonl`.
  Automation and machine-readable shells still need the structured
  non-interactive path.
- Do not overload `runtime/src/gateway/workspace-files.ts` with onboarding-only
  overwrite/backup semantics. Generic workspace scaffolding is shared runtime
  behavior; onboarding-specific file writes belong in
  `runtime/src/onboarding/workspace.ts`.
- Public examples currently duplicate AgenC router/verifier constants and PDA
  derivation logic. If any example updates those values, update the sibling
  examples or extract a shared helper first to avoid silent drift.
- The exact umbrella-root contract inventory now lives in
  `scripts/umbrella-contract-manifest.mjs`, while
  `.github/workflows/umbrella-validation.yml` intentionally uses broad
  root-owned globs (`docs/**`, `examples/**`, `scripts/**`) only for trigger
  coverage. When adding, renaming, or deleting a tracked root contract file,
  update the manifest first.
- In project `.codex/config.toml`, `agents.<name>.config_file` paths resolve
  relative to the directory containing that config file. Use
  `agents/<name>.toml` from the root `.codex/config.toml`, not
  `.codex/agents/<name>.toml`, or Codex will look under `.codex/.codex/...`.
- In `agenc-core` dashboard transport naming, keep the internal runtime tool
  registry on `tools.*` and reserve `market.*` for marketplace/economy
  surfaces. Reusing `skills.*` for both creates product/UI drift fast.
- In `agenc-core` CLI routing, `market tui` has to override the default root
  CLI output format to `table` when the caller did not explicitly request
  `json`/`jsonl`. The global CLI default is `json`, and leaving that in place
  makes an interactive TTY command fail its own output-format gate.
- In `agenc-core` marketplace flows, `market disputes resolve` is not an
  agent-signed action. It must run with the protocol authority keypair, and
  dispute resolution needs at least 3 arbiter votes under current on-chain
  rules.
- In `agenc-core` Marketplace V2 bid-exclusive flows, the public mutation
  tools have to derive accepted-bid settlement PDAs themselves. The CLI does
  not expose raw `bid_book` / `bid` / `bidder_market_state` inputs, so leaving
  that derivation out of `agenc.completeTask` or `agenc.resolveDispute` makes
  the official runtime surface fail even though the low-level operations
  already support the settlement suffix.
- In `agenc-core` security MCP tooling, `solana-fender` currently needs a
  local install or correctly configured MCP binding before its checks are
  usable in-session.
- In `agenc-core`, MCP tests import `@tetsuo-ai/runtime` through the package
  export surface, not the TypeScript source tree. If runtime source changes
  affect exported behavior, `@tetsuo-ai/mcp` needs a fresh runtime build in
  `pretest` or it will execute stale `runtime/dist` artifacts and report false
  regressions.
- MCP transport compatibility work needs a
  stdio bridge that can speak both newline-delimited JSON and
  `Content-Length` framing. The local Node MCP SDK transport uses line-based
  stdio, while the Codex-mounted MCP client currently expects framed stdio, so
  a one-format wrapper will appear fixed in one surface and broken in the
  other.
- The umbrella session-end tech debt scan now lives in
  `scripts/techdebt.mjs`. `/techdebt` is a machine-local wrapper for
  convenience, while the committed repo entrypoint is `npm run techdebt`.
- When protocol instruction account shapes change, re-check the runtime
  `accountsPartial(...)` call sites against the generated protocol IDL. Recent
  examples were `complete_task` adding `creator`, `cancel_task` requiring the
  optional token account slots to be wired explicitly, and `vote_dispute`
  needing `defendant_agent` for current validation.
- For codegen tasks, a successful build is not enough to accept completion.
  The shell run on 2026-03-24 compiled successfully while still shipping
  explicit placeholder behavior (`fg not implemented`, `bg not implemented`,
  `Pipes not fully implemented yet`, and multiple `/* Stub */` blocks). Any
  completion path for “implement X” work must treat stub markers and
  unverified required behaviors as incomplete, even if the binary builds.
- Delegation/runtime tests and planner fixtures must express artifact ownership
  or structured execution envelopes explicitly. Do not rely on `cwd=` or
  `working_directory=` context hints to imply scope or ownership; the sealed
  runtime strips those directives before prompt/spec/probe surfaces can use
  them.
- Direct `execute_with_agent` local-file delegation must derive child scope
  from the trusted parent session workspace root before preflight. Do not make
  the model invent `executionContext.workspaceRoot`, and do not trust public
  overrides like `/`; only verified descendant narrowing under the parent root
  is valid on the live direct path.
- xAI’s OpenAI-compatible inference endpoints are permissive enough that
  undocumented fields and even obviously fake fields can still return HTTP
  `200`. Treat `200` as proof of transport acceptance only, not proof that the
  field is supported or had semantic effect. In AgenC, undocumented xAI fields
  must fail closed at our adapter boundary instead of being passed through on
  the assumption that xAI honored them.
- Trivial parent-safe introspection turns like `pwd`, `ls`, “what is the
  current working directory?”, and “list files here” must bypass history
  blending and must not keep `execute_with_agent` in the routed subset unless
  the user explicitly asks for child isolation. Otherwise short follow-up turns
  inherit stale coding/delegation context and drift into unnecessary child
  delegation.
- Delegated cwd/workspace-root text is never operational truth by itself. Tag
  `execute_with_agent` results with delegated-scope trust metadata, redact
  rejected or informational-only scope claims from replay/progress, and keep
  only trusted runtime-derived scope in future memory retrieval. Logs may keep
  the raw failure/output, but prompt assembly must not.
- In Concordia, GM observations sent through the daemon must be marked
  `ingest_only` and appended directly to session/memory state instead of
  being routed through the full chat executor. Otherwise passive world-state
  updates burn planner/provider budget and make simulation turns look much
  slower than they are.
- `agenc-plugin-concordia` is loaded by the runtime through dynamic
  `import()`, so its packaging contract is ESM-first. Do not keep a fake CJS
  bundle around if it depends on `import.meta.url`; either make the package
  ESM-only or add a genuinely dual-format-safe path resolver.
## 2026-04-02
- Concordia run isolation must use `simulationId` as the live run key. `worldId` is scenario metadata only; reusing it as the session namespace will collapse concurrent runs of the same world back together.
- Concordia resume must mint a new `simulationId` and carry continuity through `lineageId` / `parentSimulationId`. Reusing the checkpoint run ID for the resumed run makes checkpoints, sessions, and live events indistinguishable.
- Concordia bridge routes that create or mutate run state (`/setup`, `/act`, `/observe`, `/event`, `/checkpoint`) must reject missing `simulation_id` instead of silently deriving one from `worldId`. Silent fallback reintroduces cross-run collisions.

- Concordia isolation must be keyed by world as well as agent. If the daemon session layer keys only by channel and sender, observations and history bleed across simulations with the same agent ID.
- Concordia periodic memory tasks must run on completed simulation steps, not on every `/act` call. In simultaneous mode, per-agent action counting fires reflection/consolidation too often and distorts memory behavior.
- Never let Concordia bridge timeouts resolve as fake empty actions. Timeouts and resets need to fail hard so the Python `ProxyEntity` can surface a real bridge failure instead of poisoning the simulation with silent success.
- Concordia GM observations must enter the next turn as `system` history, not `user` history. Treating them as user messages makes world-state observations compete with or override agent intent.
- Concordia adapter session state must update `turnCount` and `lastAction` when `/act` returns successfully. Waiting for checkpoint/resume state to catch up leaves the live UI and prompt framing stale.
- Concordia simultaneous and sequential engine `run_loop(...)` signatures must stay in lockstep for shared runner inputs like `scenes`. The Python runner always forwards scene configs, so a signature mismatch turns every launch into an immediate 500.
- Concordia observation prompt overrides must preserve the upstream `call_to_make_observation` prefix and suffix around `{name}`. The custom `FreshObservationComponent` still relies on Concordia's stock parser contract, and changing the trailing prompt text will crash the first observation step.
- In Concordia Phase 0 lifecycle work, stopping a simulation must short-circuit after the step gate and before every expensive phase: observation, action collection, resolution, checkpointing, and callback emission. If the engines only check stop before waiting, the sim can still hang or mutate state after a user presses Stop.
- In Concordia bridge request routing, missing `request_id` metadata must not leave pending `/act` promises hanging. Use a unique session-level fallback only as a recovery path, and reject mismatched session responses immediately so the runner fails fast instead of timing out silently.
- Concordia request correlation is only mandatory for actionable turns. `ingest_only` observations and other out-of-band bridge writes should bypass the runtime correlation guard, and adapter-side sends with no pending request should log at debug rather than warn.
- Concordia session and agent-state lookups must never key on `agentId` alone once concurrent runs exist. Use `simulationId`-aware lookup APIs or the state/read path becomes ambiguous the moment the same agent appears in two runs.
- Concordia TS/Python bridge payloads should be assembled through the shared simulation-identity helpers, not by hand. Rebuilding `simulation_id` / `lineage_id` / `parent_simulation_id` inline across adapters, runners, checkpoints, and events is how cross-run bugs creep back in.
