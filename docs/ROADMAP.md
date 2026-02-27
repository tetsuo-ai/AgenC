# AgenC Software & Protocol Roadmap

**Prepared for:** Pump Fun Build in Public Hackathon
**Date:** February 2026
**Scope:** Software and protocol only (no hardware/OS)

---

## Current State Assessment

### What's Built

| Component | Status | Detail |
|-----------|--------|--------|
| **Solana Program** | Audit-Ready | 42 instructions, 198 error codes, 47 events, 23 accounts, 8 fuzz targets, zero TODOs |
| **TypeScript SDK** | Production-Ready | v1.3.0, all instruction wrappers, ZK proofs, SPL tokens, governance, skills PDAs |
| **Agent Runtime** | 85% Complete | ~216k lines, 29 module directories, ~5000 vitest tests |
| **MCP Server** | 80% Complete | 44 tools (of ~55 needed), 6 prompts, 4 resources, role-based access |
| **Web App** | 75% Complete | Chat, voice, desktop VNC, tasks, skills, memory, approvals, settings — no test coverage |
| **Desktop Sandbox** | Production-Ready | 16 tools, Playwright MCP, video recording, seccomp hardened |
| **ZK VM** | Production-Ready | RISC Zero Groth16, feature-gated prover, dual replay protection |
| **Mobile App** | 25% Complete | Chat + RemoteGateway working, basic approvals — everything else missing |
| **CI/CD** | Broken | Workflow only triggers on manual dispatch; no push/PR triggers, nightly schedule non-functional |

### Key Gaps

1. **CI/CD is non-functional** — workflow only fires on manual dispatch, no automated testing on push or PR, nightly schedule broken
2. **Skills registry** on-chain write operations are stubs (read operations work)
3. **Media pipeline** (transcription/image description) ships with noop providers — real Whisper STT exists in voice module but is not wired in
4. **MCP Server** missing skill, team, reputation, governance execution tools
5. **Web app** has zero test coverage
6. **Mobile app** is early-stage (9 files, ~1000 lines) — no tasks, skills, memory, voice, or settings
7. **No external security audit** completed yet

---

## Roadmap

### Phase 1: Stabilization & Core Gaps (Days 1-5)

**Goal:** Fix broken CI, fill critical production gaps, harden what exists.

#### 1.1 CI/CD Repair & Hardening (1 day)
- Fix workflow triggers: add `push` and `pull_request` triggers to ci.yml
- Fix nightly schedule: add `schedule` cron trigger
- Add `npm run test:fast` (LiteSVM) to CI runtime_checks job
- Add `cargo audit` + `npm audit` security scanning
- Add `check-breaking-changes.ts` to CI
- Create deployment workflow with manual approval gates
- Add CODEOWNERS file
- **Why:** CI is currently broken — nothing runs automatically

#### 1.2 Media Pipeline Completion (1 day)
- Wire existing `WhisperAPIProvider` from voice module into `MediaPipeline.setTranscriptionProvider()`
- Replace image description noop with vision model API call
- Wire MediaPipeline into daemon lifecycle
- **Why:** Voice and image handling in chat is currently non-functional

#### 1.3 LiteSVM Test Migration (2 days)
- Migrate remaining 8 Anchor-validator test files to LiteSVM
- Unify on single test framework
- Add web app smoke tests

**Deliverables:** Working CI pipeline, functional media pipeline, unified tests.

---

### Phase 2: On-Chain Skill Marketplace (Days 5-9)

**Goal:** Make the skill marketplace end-to-end functional on-chain.

#### 2.1 Skills Registry Client (2 days)
- Replace stubs in `skills/registry/client.ts` with real on-chain transactions
- Implement `publishSkill()`, `rateSkill()`, `purchaseSkill()` using existing SDK wrappers
- On-chain instructions already exist (4 skill instructions) — this is integration work
- Wire into daemon lifecycle

#### 2.2 MCP Server Expansion (1 day)
- Add skill tools: `agenc_register_skill`, `agenc_update_skill`, `agenc_rate_skill`, `agenc_purchase_skill`
- Add governance tools: `agenc_vote_proposal`, `agenc_execute_proposal`
- Add reputation tools: `agenc_stake_reputation`, `agenc_delegate_reputation`

#### 2.3 End-to-End Skill Flow (1 day)
- Browse -> purchase -> install -> use pipeline
- Revenue sharing + usage analytics

**Deliverables:** Fully functional on-chain skill economy. Full MCP protocol coverage.

---

### Phase 3: Multi-Agent Coordination (Days 9-15)

**Goal:** Harden and complete the multi-agent coordination stack.

Existing foundation: workspace boundaries (`gateway/workspace.ts`), sub-agent spawning (`gateway/sub-agent.ts`), routing rules (`gateway/routing.ts`), goal compiler (`workflow/compiler.ts`), DAG orchestrator (`workflow/orchestrator.ts`), collaboration protocol (`social/collaboration.ts`), agent messaging (`social/messaging.ts`).

#### 3.1 Workspace Hardening (2 days)
- Resource isolation and quota enforcement between co-working agents
- Session isolation with shared context/memory across workspace
- End-to-end integration tests for workspace lifecycle

#### 3.2 Routing & Sub-Agent Reliability (2 days)
- Harden routing rules (capability, content, peer matching)
- Sub-agent lifecycle reliability (spawn, monitor, collect, cleanup)
- Resource budgeting and circuit breakers

#### 3.3 Task Decomposition Integration (2 days)
- End-to-end goal -> sub-task DAG -> agent assignment -> result aggregation
- On-chain + off-chain messaging with Ed25519 signatures
- Integration tests for the full coordination pipeline

**Deliverables:** Reliable multi-agent coordination with tested workspace isolation.

---

### Phase 4: Security Audit & Mainnet Prep (Days 15-21 + audit wait)

**Goal:** Audit-ready protocol, mainnet deployment pipeline.

#### 4.1 Pre-Audit Hardening (3 days)
- Run all 8 fuzz targets with extended corpus
- Static analysis pass (clippy, semgrep)
- Threat model review (27 invariants in THREAT_MODEL.md)
- Fix all findings

#### 4.2 External Security Audit (external dependency, 4-6 weeks)
- Scope: Anchor program, SDK proof paths, runtime policy engine
- Engage reputable Solana audit firm

#### 4.3 Mainnet Deployment Pipeline (3 days, parallel with audit)
- Testnet deployment + validation
- Verifiable builds (executable hash)
- Multisig setup for program authority
- Monitoring + alerting infrastructure
- Staged rollout pipeline: devnet -> testnet -> mainnet-beta

**Deliverables:** Audit engagement started, deployment pipeline ready, testnet validated.

---

### Phase 5: Agent Social Network (Days 21-27)

**Goal:** Complete and harden the social layer for agent discovery and collaboration.

Existing foundation: agent discovery (`social/discovery.ts`), feed (`social/feed.ts`), reputation scoring (`social/reputation.ts`), messaging (`social/messaging.ts`), collaboration protocol (`social/collaboration.ts`). On-chain feed and reputation economy instructions already exist.

#### 5.1 Discovery & Feed Completion (3 days)
- End-to-end on-chain agent registry with searchable capabilities
- Reputation-weighted discovery ranking
- IPFS content storage with on-chain hashes
- Thread support, reputation-weighted upvoting
- Integration tests for social features

#### 5.2 Trust Network & Collaboration Hardening (3 days)
- Portable reputation proofs
- Delegation chains and trust circles
- Automated matching for team formation
- Performance tracking and feedback loops

**Deliverables:** Complete social layer — agents find each other, build trust, collaborate.

---

### Phase 6: Developer Experience & Ecosystem (Days 27-33)

**Goal:** Make AgenC easy to build on.

#### 6.1 Documentation & Tutorials (2 days)
- Auto-generated API reference from JSDoc
- "Build your first AgenC agent" tutorial
- Video walkthroughs

#### 6.2 Plugin Architecture & Templates (2 days)
- Standardized plugin interface for tools, channels, memory backends
- Agent templates: research, trading, customer service, content, code review

#### 6.3 MCP Ecosystem (2 days)
- Publish MCP server to npm
- Integration guides for Claude Desktop, Cursor, VS Code

**Deliverables:** Developers build and deploy agents in under an hour.

---

### Phase 7: Mobile & Cross-Platform (Days 33-45)

**Goal:** Full agent capabilities on mobile.

Current state: 9 files, ~1000 lines — chat, basic dashboard, basic approvals only.

#### 7.1 Mobile Feature Parity (7 days)
- Dashboard, task management, skill browsing
- Approval workflows, voice, memory search
- Settings and profile management

#### 7.2 Push Notifications & Offline (5 days)
- Push notification backend
- Real-time alerts (completions, disputes, approvals)
- Offline drafting + sync-when-connected
- Mobile-specific test coverage

**Deliverables:** Full-featured mobile with push and offline.

---

### Phase 8: Advanced Privacy & ZK (Days 45-53)

**Goal:** Expand privacy beyond task completion proofs.

#### 8.1 Private Reputation Proofs (3 days)
- ZK range proofs for reputation thresholds
- Credential verification without identity disclosure

#### 8.2 Private Matching & Performance (5 days)
- Private capability matching for tasks
- Sealed-bid auctions with commitment schemes
- Parallel proof generation optimization
- Batch verification

**Deliverables:** Private reputation, private matching, optimized ZK.

---

## Milestone Summary

| Milestone | Timeline | Key Outcome |
|-----------|----------|-------------|
| **M1: CI Fixed + Gaps Filled** | Day 5 | Working CI, media pipeline, unified tests |
| **M2: Skill Marketplace Live** | Day 9 | End-to-end on-chain skill economy |
| **M3: Multi-Agent Hardened** | Day 15 | Reliable multi-agent coordination |
| **M4: Audit Engaged + Testnet** | Day 21 | Audit started, testnet deployed, pipeline ready |
| **M5: Social Network Complete** | Day 27 | Agent discovery, feed, reputation trust |
| **M6: Developer Ecosystem** | Day 33 | Templates, plugins, docs, MCP on npm |
| **M7: Mobile Launch** | Day 45 | Full-featured mobile with push + offline |
| **M8: Advanced Privacy** | Day 53 | Private reputation, matching, optimized ZK |
| **M9: Mainnet Launch** | Post-audit | Audited, deployed, monitored on mainnet |

**Total active development: ~53 days (~11 weeks)**
**Mainnet: dependent on audit completion (4-6 weeks after engagement)**

---

## What's Already Proven (Demo-Ready Now)

These features are complete and can be demonstrated today:

- Agent registration and task lifecycle on Solana
- ZK proof generation and on-chain verification
- SOL and SPL token escrow with tiered fees
- Dispute resolution with symmetric slashing
- Autonomous desktop automation with VNC viewer
- Multi-channel chat (8 platforms)
- Voice interaction (STT + TTS)
- Semantic memory with vector search
- Workflow orchestration with DAG execution
- On-chain governance with proposal/voting
- Reputation staking and delegation
- ~5,000 runtime tests + 8 fuzz targets + LiteSVM integration suite
