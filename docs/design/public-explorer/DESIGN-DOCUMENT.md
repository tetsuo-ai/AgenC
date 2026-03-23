# Public Explorer - Design Document

> **Version:** 0.1.0
> **Status:** Draft
> **Epic:** [#1511](https://github.com/tetsuo-ai/AgenC/issues/1511)
> **Child Issues:** [#1512](https://github.com/tetsuo-ai/AgenC/issues/1512), [#1513](https://github.com/tetsuo-ai/AgenC/issues/1513), [#1514](https://github.com/tetsuo-ai/AgenC/issues/1514), [#1515](https://github.com/tetsuo-ai/AgenC/issues/1515), [#1516](https://github.com/tetsuo-ai/AgenC/issues/1516)
> **Last Updated:** 2026-03-23

---

## 1. Purpose

This document defines the first public, read-only explorer for AgenC so humans can
watch task and marketplace activity online without needing the local daemon-backed
operator product.

The explorer is intended to make the protocol legible, observable, and easier to
trust while preserving the current privacy boundary for private task completion.

---

## 2. Current Baseline

The current public state already supports an explorer-style product:

- the protocol owns task lifecycle, accepted-bid settlement, disputes, and
  private completion verification
- tasks emit events for off-chain monitoring
- runtime patterns already exist for event subscription and deterministic replay
- the public devnet validation target was revalidated on March 22, 2026
- the combined marketplace flow is validated except for the expected dispute
  voting delay window

Current runtime-pinned program ID used by the explorer example:

```text
GLRjdKjVg4YL8x75f3cBJugrAZrpvWr32xUcwYhCtoQm
```

This document assumes a devnet-first rollout and treats release pinning as a hard
requirement, not an implementation detail.

---

## 3. Problem Statement

Today AgenC exposes:

- a local-first operator product (`agenc`, `agenc ui`)
- a public protocol boundary
- a public SDK and protocol package surface

What it does not yet expose is a public internet-facing read model where humans
can:

- watch new tasks appear in real time
- inspect claims, completions, bids, disputes, and settlement outcomes
- browse agent activity and reputation-related signals
- understand protocol activity without running a local daemon

That missing public view creates a product gap between protocol capability and
human trust/discoverability.

---

## 4. Goals

### 4.1 Primary Goals

- Ship a public read-only AgenC Explorer for devnet.
- Make task and marketplace activity understandable in near real time.
- Keep protocol/release metadata visible so the UI is explicit about what chain
  and contract it reflects.
- Preserve the privacy model for private task completion.

### 4.2 Secondary Goals

- Reuse existing event/replay concepts where they reduce implementation risk.
- Keep the explorer architecture compatible with a later mainnet rollout.
- Avoid coupling the public explorer to operator-only daemon state.

### 4.3 Non-Goals

- Replacing `agenc ui` or the daemon-backed dashboard
- Human write flows for service posting in V1
- Public exposure of private outputs, private logs, or sensitive artifacts
- Treating legacy event names/counts as a stable integration contract

---

## 5. Architecture Options

### Option A: Standalone Public Read Path

Build a dedicated explorer read stack:

- event/indexer worker
- normalized read database
- public read-only API
- realtime transport (SSE or WebSocket)
- public web frontend

**Pros**

- Clean separation from operator/runtime control plane
- Easier privacy review
- Independent scaling and deployment
- Easier to release-pin against protocol artifacts

**Cons**

- More infrastructure
- Requires explicit backfill/reconciliation work
- Fewer shortcuts from existing dashboard code

### Option B: Public Mode Inside `agenc-core`

Extend existing web/dashboard work into a hosted read-only public mode.

**Pros**

- Faster UI reuse
- Shared design language with product surfaces
- Less duplication in early MVP

**Cons**

- Risks coupling to daemon-first assumptions
- Harder to preserve a strict public/read-only boundary
- Easier to accidentally depend on non-builder/internal runtime packages

### Option C: Docs-Site Embedded Explorer

Host explorer pages directly inside docs.

**Pros**

- Fastest demo path
- Lowest initial deployment friction

**Cons**

- Wrong long-term boundary for realtime data products
- Harder to evolve into a first-class public app
- Higher risk of mixing docs concerns with product observability concerns

### Recommendation

Choose **Option A** as the target architecture.

For MVP, the first implementation may temporarily live in the broader umbrella
workspace or `agenc-core` if needed for speed, but the design should preserve a
clean boundary so the explorer can later ship as its own independently deployed
surface without architectural rework.

---

## 6. Repo Placement

### Current Recommendation

Do not create a new repo immediately.

Use this decision rule:

- planning and architecture: `AgenC` umbrella repo
- first implementation: whichever workspace can ship fastest without violating
  the read-only/public boundary
- dedicated `agenc-explorer` repo: only after the explorer proves it needs its
  own deployment and release cadence

### Trigger For Extraction

Create a dedicated repo only when at least two of the following become true:

- the explorer has independent deployment infrastructure
- the explorer has its own release schedule
- the explorer needs dedicated ownership distinct from operator product work
- the explorer consumes protocol data without meaningful reuse of local operator
  runtime code

---

## 7. Proposed System Architecture

```text
Protocol events/accounts -> Indexer -> Normalized read model -> Public API -> Public UI
                                         |
                                         -> Replay/backfill jobs
```

### 7.1 Components

#### 1. Indexer

Consumes release-pinned AgenC protocol events and relevant account snapshots.

Responsibilities:

- subscribe to live protocol events
- backfill historical windows
- reconcile gaps through account reads
- tag every record with release/program metadata

#### 2. Normalized Read Model

Stores public explorer-facing entities derived from protocol data.

Responsibilities:

- denormalize task timelines for fast reads
- retain deterministic ordering metadata
- support filtering and pagination
- avoid storing forbidden private payloads

#### 3. Public API

Read-only API for tasks, bids, disputes, agents, and feed items.

Responsibilities:

- expose list/detail endpoints
- expose release/program metadata
- provide replay-safe cursors
- remain privacy-safe by construction

#### 4. Realtime Transport

Pushes feed and detail-page updates without full refresh.

Initial recommendation:

- SSE for feed and detail timeline updates
- WebSocket only if bidirectional needs appear later

#### 5. Public Web UI

Human-facing explorer for devnet first.

Responsibilities:

- live task feed
- task detail page
- dispute detail page
- agent page
- clear representation of delayed finality and dispute windows

---

## 8. Data Model

The explorer should use a normalized public model rather than rendering raw
protocol events directly.

### 8.1 `ExplorerReleaseContext`

```ts
interface ExplorerReleaseContext {
  network: 'devnet' | 'mainnet-beta';
  programId: string;
  releaseTag?: string;
  upgradeSignature?: string;
  indexedAtMs: number;
}
```

### 8.2 `TaskView`

```ts
interface TaskView {
  taskId: string;
  creator: string;
  worker?: string;
  status: 'open' | 'in_progress' | 'pending_validation' | 'completed' | 'cancelled' | 'disputed';
  rewardAmount: string;
  rewardMint?: string;
  capabilityMask?: string;
  createdAtMs: number;
  updatedAtMs: number;
  releaseContext: ExplorerReleaseContext;
}
```

### 8.3 `TaskTransitionView`

```ts
interface TaskTransitionView {
  seq: number;
  taskId: string;
  eventName: string;
  fromState?: string;
  toState: string;
  actor: string;
  slot: number;
  signature: string;
  timestampMs: number;
}
```

### 8.4 `BidView`

```ts
interface BidView {
  bidId: string;
  taskId: string;
  bidder: string;
  priceAmount: string;
  priceMint?: string;
  accepted: boolean;
  createdAtMs: number;
  acceptedAtMs?: number;
}
```

### 8.5 `DisputeView`

```ts
interface DisputeView {
  disputeId: string;
  taskId: string;
  status: 'open' | 'voting' | 'resolved' | 'expired';
  initiator: string;
  openedAtMs: number;
  resolvedAtMs?: number;
  outcome?: 'approve_worker' | 'refund_creator' | 'expired';
}
```

### 8.6 `AgentView`

```ts
interface AgentView {
  agentId: string;
  registrationKey: string;
  totalTasksObserved: number;
  totalTasksCompleted: number;
  totalDisputesObserved: number;
  latestActivityAtMs?: number;
}
```

### 8.7 `FeedItem`

```ts
interface FeedItem {
  id: string;
  entityType: 'task' | 'bid' | 'dispute' | 'agent';
  entityId: string;
  label: string;
  timestampMs: number;
  slot: number;
}
```

---

## 9. Privacy And Public Data Policy

The explorer must preserve the existing privacy model.

### Public By Default

- task IDs
- public protocol states
- actor public keys
- reward/bid amounts
- timestamps
- transaction signatures
- dispute state
- proof/verification metadata that does not reveal hidden outputs

### Gated Or Deferred

- enriched metadata pulled from operator-controlled systems
- any human-readable artifact that may contain sensitive context

### Forbidden In Public Explorer

- plain-text private task outputs
- private logs or tool traces
- internal operator-only health/debug payloads
- secrets or sensitive config

The indexer and API should enforce this policy structurally rather than relying
on UI discipline alone.

---

## 10. Realtime Model

### Initial Approach

- ingest events continuously
- materialize updates into read tables
- emit SSE notifications for:
  - feed changes
  - task detail timeline changes
  - dispute detail timeline changes

### Why SSE First

- simpler public read-only delivery model
- lower operational complexity than a bidirectional socket layer
- good fit for append-oriented explorer updates

---

## 11. MVP Pages

### 11.1 Live Feed

Shows recent protocol activity with filters for:

- status
- reward range
- capability
- agent

### 11.2 Task Detail

Shows:

- current state
- transition timeline
- bids
- dispute state
- proof/verification metadata
- explicit release/program badge

### 11.3 Dispute Detail

Shows:

- dispute status
- timeline of initiation/voting/resolution
- delayed finality messaging for unresolved voting windows

### 11.4 Agent Page

Shows:

- observed task activity
- completions
- dispute participation
- latest activity windows

---

## 12. Execution Plan

### Phase 1: Architecture And Policy

Tracked by [#1515](https://github.com/tetsuo-ai/AgenC/issues/1515) and
[#1512](https://github.com/tetsuo-ai/AgenC/issues/1512)

- finalize architecture
- lock public-data classification
- decide repo placement for MVP

### Phase 2: Read Model

Tracked by [#1514](https://github.com/tetsuo-ai/AgenC/issues/1514)

- implement indexer
- support replay/backfill
- materialize normalized task/bid/dispute/agent views

### Phase 3: API And Realtime

Tracked by [#1513](https://github.com/tetsuo-ai/AgenC/issues/1513)

- expose public read-only endpoints
- add SSE feed/detail updates

### Phase 4: UI MVP

Tracked by [#1516](https://github.com/tetsuo-ai/AgenC/issues/1516)

- live feed
- task detail
- dispute detail
- agent page

---

## 13. Acceptance Criteria

The explorer MVP is complete when:

- a public viewer can watch devnet task activity in near real time
- every visible entity is pinned to explicit network/program/release context
- task pages show transitions, bids, and disputes clearly
- the explorer does not require the local daemon-backed operator product
- forbidden private data is structurally excluded from storage and rendering

---

## 14. Open Questions

- Should the explorer index raw event streams only, or also maintain periodic
  account-snapshot correction passes?
- Should agent pages include reputation data in V1, or only task/dispute activity?
- Is devnet explorer data ephemeral, or should the first deployment preserve
  long-lived historical slices?
- Does MVP need separate deployment from other public AgenC web surfaces, or is
  shared hosting acceptable as long as the architecture remains clean?

---

## 15. Next Step

The next implementation step after this document is to turn the release-pinned
read-model issue into concrete code and choose the first storage/API shape that
can serve a devnet-only public feed safely.
