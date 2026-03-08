# TODO: Fully Autonomous Durable Task Runtime

**Prepared:** March 7, 2026  
**Scope:** Runtime autonomy, durability, supervision, safety, evals, and operations.  
**Relationship to existing roadmap:** This supplements [docs/ROADMAP.md](docs/ROADMAP.md). That file covers the broader product and protocol roadmap. This file is the autonomy-runtime program needed to make AgenC behave like a real durable task runtime rather than a bounded chat loop.

## Target End State

The target is not "the model keeps talking forever." The target is a runtime that:

- Owns long-running tasks as first-class `AgentRun` objects.
- Persists task state, evidence, artifacts, leases, and operator controls durably.
- Survives daemon restarts, worker crashes, network partitions, and provider retries.
- Uses explicit wake reasons instead of hoping the model decides to continue.
- Completes tasks from deterministic evidence or typed verifiers, not freeform narration.
- Separates control plane, worker plane, and tool environments.
- Enforces policy, budget, security, and auditability at the runtime layer.
- Supports background execution, pause/resume/stop, human intervention, and safe escalation.
- Produces replayable traces, evals, and SLOs suitable for production operations.

## Research Basis

This plan is based on the current public guidance that is most relevant to durable agent runtimes:

- OpenAI Background mode: long-running tasks should run asynchronously with explicit polling, status, and completion handling rather than depending on a single interactive request.
  - https://developers.openai.com/api/docs/guides/background/
- OpenAI Deep research: long-running research flows should use background mode and webhook notification, and the runtime contract matters for long jobs.
  - https://developers.openai.com/api/docs/guides/deep-research/
- OpenAI Prompt guidance for GPT-5.4: long-running/tool-heavy agents need explicit output contracts, completion criteria, verification loops, tool persistence rules, and preserved `phase` semantics.
  - https://developers.openai.com/api/docs/guides/prompt-guidance/
- OpenAI Compaction: long-running, tool-heavy workflows need milestone-based compaction and opaque carry-forward state.
  - https://developers.openai.com/api/docs/guides/compaction/
  - https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide/#4-compaction-extending-effective-context
- OpenAI session memory guidance: trimming is deterministic but forgetful; summarization/carry-forward preserves long-horizon continuity but needs observability and summary evals.
  - https://developers.openai.com/cookbook/examples/agents_sdk/session_memory/
- Anthropic "Building effective agents": start with the simplest architecture that works, then add orchestration only where it improves results.
  - https://www.anthropic.com/engineering/building-effective-agents
- Anthropic "Writing tools for agents": use explicit, well-namespaced, structured tools and clear descriptions instead of overloading freeform tool behavior.
  - https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic "Effective context engineering for AI agents": runtime context, memory boundaries, and state shaping are first-order design concerns.
  - https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic "Demystifying evals for AI agents": production agent quality needs transcript, trajectory, and outcome evals, not only final-answer spot checks.
  - https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Anthropic "Effective harnesses for long-running agents": the harness should own progress, state, and iteration across long tasks.
  - https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- LangGraph durable execution and persistence docs: long-lived agents need explicit checkpoints, resumability, and stateful graph execution.
  - https://docs.langchain.com/langgraph/durable-execution
- Temporal durable execution/workflow guidance: durable orchestration requires replay-safe state transitions, leases, signals, retries, and crash-proof workflow ownership.
  - https://docs.temporal.io/

## Current AgenC Baseline

The current runtime already has real foundations:

- Persisted background-run state and leases in `runtime/src/gateway/background-run-store.ts`.
- Runtime-owned supervisor loop in `runtime/src/gateway/background-run-supervisor.ts`.
- Background run recovery on boot via `recoverRuns()` in `runtime/src/gateway/background-run-supervisor.ts`.
- Durable web session metadata in `runtime/src/channels/webchat/session-store.ts`.
- Structured managed-process supervision in `containers/desktop/server/src/tools.ts`.
- Desktop sandbox recovery across daemon restart in `runtime/src/desktop/manager.ts`.
- Background status controls and session wiring in `runtime/src/gateway/daemon.ts`.

This is enough to say AgenC is no longer just a single-turn tool-using chat loop.

It is **not** enough yet to call the system fully autonomous or enterprise-grade across the full runtime surface.

## Gap Summary vs Research

| Area | Current AgenC state | Gap |
| --- | --- | --- |
| Durable run ownership | Partial | Supervisor exists, but lifecycle semantics, budgets, migrations, and domain coverage are incomplete |
| Restart recovery | Partial | Background runs and desktop sandboxes recover, but not all budgets, watchers, domains, and leases fully reconcile |
| Event-driven execution | Partial | Wake reasons exist, but adapters are not uniform across tools, browser, files, webhooks, and external systems |
| Deterministic completion | Partial | Managed-process path is stronger; many other domains still depend on heuristics or model wording |
| Context continuity | Partial | Local carry-forward exists; provider-native compaction/checkpointing is not integrated |
| Tool contracts | Partial | Structured process tools exist; many long-running/stateful capabilities still lack typed handles and resume semantics |
| Worker plane | Missing | Scheduler and execution remain mostly in-daemon rather than split into durable control/worker planes |
| Governance and security | Partial | Good safety work exists, but full enterprise policy, quotas, audit, tenancy, and approval flows are not complete |
| Observability and evals | Partial | There is strong trace/debugging work, but not yet a full run-level replay/eval/chaos/SLO system |
| Multi-agent durability | Early | Some delegation/subagent support exists, but not yet a robust typed orchestration layer on top of the durable runtime |

## Non-Negotiable Invariants

These invariants should guide every phase below:

1. **Runtime owns the run.** The model can propose actions or claim completion, but the runtime decides state transitions.
2. **No opaque completion.** A run cannot become `completed` without deterministic evidence or a typed verifier that is itself testable.
3. **Every wake-up has a reason.** `timer`, `tool_result`, `process_exit`, `webhook`, `user_input`, `approval`, `recovery`, and domain-specific wake sources must be explicit and logged.
4. **Every stateful tool returns a durable handle.** If a task can outlive one tool call, the tool must return a typed identifier that supports `status`, `resume`, and `stop/cancel`.
5. **Recovery must be idempotent.** After daemon or worker restart, replay/recovery cannot duplicate irreversible side effects.
6. **Policy is runtime-enforced.** High-risk actions, secrets, budgets, and approvals cannot depend on prompt wording alone.
7. **Context is layered.** Recent verbatim context, compact carry-forward state, evidence/artifacts, and provider-native compacted state must be treated as different storage classes.
8. **Everything important is replayable.** A production incident must be reproducible from persisted run state, event logs, tool records, and compacted context pointers.

## Phase 0: Architecture Contract and ADR

**Objective:** Freeze the design contract for a durable autonomous runtime before adding more behavior.

**Current AgenC starting point**

- The run object and persistence model already exist in `runtime/src/gateway/background-run-store.ts`.
- The supervisor loop already exists in `runtime/src/gateway/background-run-supervisor.ts`.
- There is no runtime ADR documenting the intended autonomy architecture.

**Work**

- [x] Create an ADR for the autonomous runtime architecture.
- [x] Define the canonical `AgentRun` state machine, including `pending`, `running`, `working`, `paused`, `blocked`, `completed`, `failed`, `cancelled`, and `suspended`.
- [x] Define the lifecycle semantics for `pause`, `resume`, `cancel`, `suspend`, `teardown`, and `recover`.
- [x] Define the canonical run contract schema:
  - objective
  - success criteria
  - completion criteria
  - blocked criteria
  - required verification
  - budget envelope
  - approval envelope
  - artifact references
  - domain type
  - run ownership metadata
- [x] Define the canonical event schema and naming conventions for all wake sources.
- [x] Define compatibility and migration policy for persisted run records.
- [x] Define what "fully autonomous" means in this repository so the term stops drifting.

**Tests / exit criteria**

- [x] Property tests for valid/invalid state transitions.
- [x] Backward-compatible persisted schema load tests.
- [x] ADR merged and referenced from `docs/architecture/`.

## Phase 1: Durable Run Kernel Hardening

**Objective:** Make the core run kernel crash-safe, restart-safe, lease-safe, and migration-safe.

**Current AgenC starting point**

- Leases already exist in `runtime/src/gateway/background-run-store.ts`.
- Boot-time recovery already exists in `runtime/src/gateway/background-run-supervisor.ts`.
- Some lifecycle information is persisted, but not every budget, watcher, or recovery detail is durable yet.

**Work**

- [x] Persist every piece of run state needed for deterministic recovery:
  - next wake time
  - heartbeat cadence
  - approval wait state
  - external watcher registrations
  - restart counters
  - idle/activity budgets
  - compaction checkpoints
  - pending human/operator signals
  - unresolved blockers
- [x] Split `pause` from `suspend-for-recovery` from `teardown`.
- [x] Add run schema versioning and forward migration helpers.
- [x] Add durable fencing tokens for split-brain protection across multiple daemon or worker instances.
- [x] Add corruption-handling and partial-write recovery for persisted run records.
- [x] Persist and restore idle-budget state for recovered desktop sessions and other long-lived environments.
- [x] Add garbage collection policy for terminal runs, expired leases, and orphaned artifacts.

**Tests / exit criteria**

- [x] Kill daemon mid-cycle and recover without losing run ownership.
- [x] Simulate double-daemon boot and verify only one lease owner progresses the run.
- [x] Corrupt persisted state and verify safe failure or migration behavior.
- [x] Restart recovery tests for every persisted field, not only objective/state.

## Phase 2: Event-Driven Wake Plane

**Objective:** Replace timer-heavy supervision with a real event-driven wake architecture.

**Current AgenC starting point**

- Wake reasons already exist in `runtime/src/gateway/background-run-store.ts`.
- Process-exit signals already participate in the supervisor.
- Most non-process domains still rely too heavily on polling or model-driven follow-up.

**Work**

- [x] Introduce a dedicated wake bus abstraction with durable enqueue/dequeue semantics.
- [x] Implement adapters for:
  - [x] tool-result events
  - [x] managed-process exit
  - [x] webhook ingress
  - [x] browser page state changes
  - [x] downloads/uploads
  - [x] filesystem watchers
  - [x] socket/server health transitions
  - [x] scheduled cron/timer wakes
  - [x] operator instructions
  - [x] approval decisions
  - [x] external MCP callback/event sources
- [x] Add dedupe/idempotency for repeated wake events.
- [x] Add ordering guarantees or per-domain sequencing contracts.
- [x] Add dead-letter handling for malformed or repeatedly failing wake events.
- [x] Add backpressure and fan-out controls so noisy event streams cannot starve runs.

**Tests / exit criteria**

- [x] Deterministic fake-clock tests for timers plus event wakes.
- [x] Duplicate event delivery tests.
- [x] Out-of-order event handling tests.
- [x] High-volume soak test where event load does not starve heartbeats or operator controls.

## Phase 3: Typed Run Domains and Deterministic Verifiers

**Objective:** Move from heuristic supervision to typed domain contracts with explicit completion and blocker logic.

**Current AgenC starting point**

- Managed-process supervision is the strongest typed domain today.
- Many other domains still rely on general-purpose prompt contracts and heuristic evidence handling.

**Work**

- [x] Introduce a `RunDomain` interface with:
  - planner contract
  - verifier contract
  - blocker detection
  - status summarizer
  - recovery strategy
  - event subscriptions
  - artifact contract
- [x] Implement first-class run domains for:
  - managed background processes
  - browser/web automation
  - desktop GUI automation
  - code workspace tasks
  - research/report generation
  - pipeline/workflow execution
  - remote MCP long-running jobs
  - approval-gated tasks
- [x] Remove model-only completion authority from core domains.
- [x] Require every core domain to define typed `success`, `blocked`, `needs_attention`, and `safe_to_continue` states.
- [x] Add domain-specific restart/retry policies instead of generic retry heuristics.
- [x] Standardize verifier outputs so the supervisor can reason over them without parsing prose.

**Tests / exit criteria**

- [x] Golden tests for each domain’s verifier.
- [x] Adversarial tests where the model falsely claims success and the verifier rejects it.
- [x] Recovery tests per domain after restart.
- [x] Exit only when core domains can complete or block deterministically without relying on final-answer narration.

## Phase 4: Context, Memory, and Compaction Engine

**Objective:** Give long-running runs durable, scalable context without summary drift or token explosion.

**Current AgenC starting point**

- Local carry-forward summaries already exist in `runtime/src/gateway/background-run-supervisor.ts`.
- Recent progress retrieval already exists in `runtime/src/gateway/progress.ts`.
- Provider-native compaction and opaque checkpoint integration are not yet wired in.

**Work**

- [x] Define a layered run-memory model:
  - recent verbatim interaction window
  - run-level carry-forward summary
  - verified fact ledger
  - artifact/evidence store
  - provider-native compacted state
  - long-term memory/retrieval anchors
- [x] Integrate provider-native `phase` preservation for long-running/tool-heavy assistant turns where supported.
- [x] Integrate provider-native `previous_response_id` continuation where supported and safe.
- [x] Integrate `/responses/compact` or equivalent opaque compaction for supported providers.
- [x] Compact after milestones, not every cycle.
- [x] Add compaction/re-expansion tracing so incidents can be replayed.
- [x] Add poisoning detection and repair flow for bad summaries or compacted state drift.
- [x] Add rules for binary artifacts and large tool outputs so they stay out-of-band by default.

**Tests / exit criteria**

- [x] Long-session coherence tests with and without compaction.
- [x] A/B evals comparing raw-history continuation vs compacted continuation.
- [x] Summary-drift regression suite.
- [x] Replay tests proving a run can resume from compacted state without behavior drift.

## Phase 5: Structured Tool and Environment Contracts

**Objective:** Eliminate runtime ambiguity by making long-lived tool interactions explicitly stateful and resumable.

**Current AgenC starting point**

- `desktop.process_start/status/stop` already exist and are the correct pattern.
- Many other stateful capabilities still rely on one-shot tool shapes or freeform shell fallbacks.

**Work**

- [x] Standardize a handle-based contract for all long-lived tools:
  - [x] desktop managed processes (`desktop.process_start/status/stop`)
  - [x] host managed processes (`system.processStart/status/resume/stop/logs`)
  - [x] browser sessions (`system.browserSessionStart/status/resume/stop/artifacts`)
  - `start`
  - `status`
  - `resume`
  - `cancel/stop`
  - `logs/artifacts`
- [x] Extend structured contracts to:
  - [x] browser sessions
  - [x] downloads/uploads
  - [x] web servers
  - [x] remote MCP jobs
  - [x] code execution sandboxes
  - [x] long-running research tasks
- [x] Add idempotency keys across all side-effecting tools.
- [x] Add cancellation semantics everywhere.
- [x] Add structured error taxonomy across runtime, tool bridge, and provider layers.
- [x] Add resource envelopes for CPU, memory, disk, network, and wall-clock budgets.
- [x] Make freeform shell a deliberate escape hatch, not the default long-run substrate.

**Tests / exit criteria**

- [x] Contract tests shared by every long-lived tool family.
  - [x] desktop managed processes
  - [x] host managed processes
  - [x] browser sessions
  - [x] web servers
  - [x] remote MCP jobs
  - [x] code execution sandboxes
  - [x] long-running research tasks
- [x] Retry/idempotency tests for duplicate `start` calls.
  - [x] desktop managed processes
  - [x] host managed processes
  - [x] browser sessions
  - [x] web servers
  - [x] remote MCP jobs
  - [x] code execution sandboxes
  - [x] long-running research tasks
- [x] Cancellation tests for every handle-based tool.
  - [x] desktop managed processes
  - [x] host managed processes
  - [x] browser sessions
  - [x] web servers
  - [x] remote MCP jobs
  - [x] code execution sandboxes
  - [x] long-running research tasks
- [x] Security tests for SSRF, secret leakage, privilege misuse, and unsafe open-world calls.

## Phase 6: Control Plane / Worker Plane Split

**Objective:** Move the durable runtime from a single daemon process toward a proper control plane and worker plane.

**Current AgenC starting point**

- Scheduler and execution are still mostly in the daemon process.
- The current system is durable enough for one node and some restart scenarios, but not yet a high-availability worker architecture.

**Work**

- [x] Split responsibilities into:
  - control plane
  - durable run store
  - worker executor plane
  - tool environment pools
- [x] Introduce a durable queue for scheduled runs and wake events.
- [x] Add leader election or lease-based shard ownership for workers.
- [x] Add worker heartbeats, drain mode, graceful shutdown, and stuck-worker recovery.
- [x] Add dedicated pools for browser, desktop, code, research, and generic tasks.
- [x] Preserve sandbox affinity when a run must reattach to a specific environment.
- [x] Add admission control and global backpressure across tenants and task classes.

**Tests / exit criteria**

- [x] Multi-worker failover tests.
- [x] Network partition / split-brain tests.
- [x] Rolling restart with no lost runs.
- [x] Load tests showing the queue and lease model hold under concurrency.

## Phase 7: Security, Governance, and Enterprise Controls

**Objective:** Make autonomy safe, governable, and auditable for real production use.

**Current AgenC starting point**

- The runtime already has meaningful approval and desktop hardening work.
- Full enterprise governance, tenancy, quotas, and auditability are not complete.

**Work**

- [x] Add tenant/project-level policy bundles.
- [x] Add per-run and per-tenant budgets:
  - token spend
  - tool spend
  - elapsed runtime
  - process count
  - network access
  - write scope
- [x] Add policy classes for:
  - read-only
  - reversible side effects
  - destructive side effects
  - irreversible/financial actions
  - credential/secret access
- [x] Add approval SLAs, escalation, delegation, and policy simulation mode.
- [x] Add signed audit trails and redacted retention-aware logs.
- [x] Add short-lived secret/session credential injection and revocation.
- [x] Add MCP trust tiers and per-server risk controls.
- [x] Add supply-chain protections for container images, MCP binaries, and generated tool catalogs.

**Tests / exit criteria**

- [x] Multi-tenant isolation tests.
- [x] Approval bypass red-team tests.
- [x] Secret redaction tests.
- [x] Audit-log completeness tests.
- [ ] External security review for the runtime autonomy path before broad production rollout.

## Phase 8: Observability, Replay, and Agent Evals

**Objective:** Make long-horizon runtime quality measurable, replayable, and enforceable in CI/CD.

**Current AgenC starting point**

- Strong debugging and trace work already exists.
- A complete run-level eval program is still missing.

**Work**

- [x] Define an append-only run-event model for every run transition and wake event.
- [x] Emit OTEL traces and metrics for:
  - run latency
  - time to first acknowledgement
  - time to first verified update
  - false completion rate
  - blocked-without-notice rate
  - stop latency
  - recovery success rate
  - per-domain verifier accuracy
- [x] Build a replay harness that can reconstruct a run from persisted state and events.
- [x] Create an eval suite with:
  - transcript scoring
  - tool trajectory scoring
  - end-state correctness
  - verifier correctness
  - restart/recovery correctness
  - operator UX correctness
  - cost/latency regressions
- [x] Build continuous canary runs and long-horizon soak tests.
- [x] Build chaos tests for provider stalls, daemon crashes, worker crashes, stale leases, broken webhooks, and corrupted state.

**Tests / exit criteria**

- [x] CI gates for autonomy regression benchmarks.
- [x] Replay harness used in incident runbooks.
- [x] Soak test suite for multi-hour runs.
- [x] Run-level dashboard and alerting in production.

## Phase 9: Operator and User Experience

**Objective:** Make durable runs operable by humans without breaking autonomy.

**Current AgenC starting point**

- Basic `status`, `pause`, `resume`, and `stop` flows exist for background runs.
- There is no full operator surface for enterprise operations.

**Work**

- [ ] Build a run dashboard that separates runs from chat turns.
- [ ] Show:
  - objective
  - contract
  - current phase
  - live evidence
  - pending blockers
  - approvals needed
  - artifacts
  - recent wake events
- [ ] Add operator controls for:
  - edit objective
  - amend constraints
  - raise/lower budget
  - force compact
  - reassign worker
  - retry from checkpoint
  - mark verification override with audit trail
- [ ] Add subscription/notification sinks:
  - webhooks
  - email/slack/discord/etc.
  - mobile push
- [ ] Add clear explanations for why a run is waiting, blocked, completed, or unsafe to continue.

**Tests / exit criteria**

- [ ] Browser E2E tests for all operator flows.
- [ ] UX tests proving background runs do not pollute normal foreground session context.
- [ ] Audit trail tests for operator interventions.

## Phase 10: Multi-Agent Orchestration on Top of the Durable Runtime

**Objective:** Make multi-agent coordination a typed capability of the runtime, not a prompt trick.

**Current AgenC starting point**

- There is already delegation and subagent machinery in the repo.
- The durable supervisor is still primarily a single-run/single-actor control model.

**Work**

- [ ] Define typed subrun APIs for planner, worker, critic, verifier, and aggregator roles.
- [ ] Require explicit budgets, scopes, and artifact contracts for each spawned subrun.
- [ ] Add structured join/reduce semantics for parallel work.
- [ ] Add redundancy patterns only where evals prove they help:
  - verifier
  - critic
  - majority vote
  - independent research branches
- [ ] Add subrun lineage, budget attribution, and failure attribution.
- [ ] Integrate multi-agent orchestration with the same run-event, lease, recovery, and policy systems as single-agent runs.

**Tests / exit criteria**

- [ ] Comparative evals: single-agent vs multi-agent for target workloads.
- [ ] Restart recovery tests for parent/child run trees.
- [ ] Budget enforcement tests across nested runs.
- [ ] No multi-agent rollout until single-agent runtime metrics are already healthy.

## Phase 11: Production Rollout, SLOs, and Compliance

**Objective:** Make the autonomy runtime safe to ship and operate continuously.

**Work**

- [ ] Define production SLOs for:
  - run start latency
  - update cadence
  - completion accuracy
  - recovery success
  - stop latency
  - event-loss rate
- [ ] Add feature flags and kill switches for every major autonomy subsystem.
- [ ] Add schema migration playbooks and backward-compatibility guarantees.
- [ ] Add canary rollout strategy by tenant, feature, and domain.
- [ ] Add incident runbooks for stuck runs, split-brain, bad compaction, webhook failure, and policy regressions.
- [ ] Add game days and chaos drills before broad release.
- [ ] Add external security/privacy/compliance review for the durable runtime, not just the chain protocol.

**Tests / exit criteria**

- [ ] Canary success criteria documented and automated.
- [ ] Rollback tested.
- [ ] On-call runbooks validated by drills.
- [ ] Release gates block rollout if autonomy SLOs regress.

## Immediate Next Implementation Order

If implementation starts now, the correct order is:

1. Phase 0: Architecture contract and ADR.
2. Phase 1: Durable run kernel hardening.
3. Phase 2: Event-driven wake plane.
4. Phase 3: Typed run domains and deterministic verifiers.
5. Phase 4: Context, memory, and compaction engine.

That sequence aligns with the current AgenC codebase: the supervisor/store foundation already exists, so the highest-leverage work is to harden ownership/recovery, then replace heuristic continuation with typed events and typed completion.

## Definition of "Done"

This roadmap is only complete when all of the following are true:

- A run can survive daemon restart, worker restart, and provider retry without losing ownership or duplicating irreversible actions.
- Core domains can complete, block, or request help from deterministic evidence and typed verifiers.
- Context can scale across long-horizon runs using compact carry-forward state plus provider-native compaction where available.
- Operators can observe and intervene in runs without corrupting run state or chat history.
- Policy, approvals, budgets, and audit are enforced at runtime, not prompt-only.
- Replay, evals, and chaos tests are release gates rather than optional diagnostics.
- Multi-agent execution is layered on the same durable runtime contract instead of being an exception path.

Until then, AgenC should be described as a **durable task runtime in progress**, not as a fully autonomous system.
