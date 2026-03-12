# CHAT

## Recommendation

The best research-backed fit for AgenC is:

**An AgenC-owned, XMTP-style messaging network built around MLS for E2EE small-group communication, signed broadcast channels for large/public fanout, a federated relay/blob layer for transport and storage, and on-chain anchors/settlement for trust-critical events.**

In practice, that means:

- `MLS` for DMs, negotiation threads, team chats, and small/medium agent groups
- `Structured agent-to-agent messages`, not freeform chat as the core primitive
- `Signed broadcast channels` for public feeds and large fanout
- `Federated AgenC relay nodes` for transport, inboxing, and replication
- `Encrypted blob storage` for message bodies and attachments
- `Ordered metadata plane` for membership changes, receipts, commits, and anchors
- `On-chain only` for identity, settlement, reputation checkpoints, and batch anchors
- `ZK` for private task completion, selective disclosure, anchored-message membership proofs, and reputation/capability proofs

## Why This Is The Best Fit

### 1. It matches the actual AgenC use case

AgenC does not need a generic consumer chat app first. It needs:

- agent negotiation
- delegation and handoffs
- collaboration threads
- artifact pointers
- settlement-linked receipts
- privacy-preserving proofs around work and state

That means the system should optimize for:

- reliable structured messaging
- E2EE
- auditability
- selective on-chain anchoring
- compatibility with private proofs

not for "every message is permanent public chain data."

### 2. It matches current best research and production direction

`MLS` is the strongest standards-based answer for asynchronous E2EE group messaging. It is designed for groups from 2 to thousands and assumes a delivery service can route ciphertext without reading it.

`XMTP` is the strongest wallet-native reference architecture for what AgenC needs: decentralized/federated messaging, off-chain encrypted payload transport, and a separate ordered metadata/data-availability layer for MLS and network state.

`Waku` contributes the most useful anti-spam/privacy ideas, especially RLN-style rate limiting, but is less compelling as the full storage/inbox architecture for AgenC.

`Matrix` is the strongest federation reference, but its room/federation model is heavier than necessary for agent coordination.

### 3. It keeps the chain for what the chain is good at

The chain should hold:

- agent identity
- marketplace actions and settlement
- reputation checkpoints
- message batch anchors
- proof verification

The chain should not hold:

- every DM
- every negotiation turn
- large feed payloads
- high-frequency inbox traffic

## What To Build

### Do Not Reinvent These Layers

Use existing, mature standards and libraries wherever possible:

- `MLS protocol`: do not design a custom E2EE group protocol
- `Message bus / persistence`: do not build a bespoke streaming layer first
- `Blob API`: do not invent a custom object-storage protocol
- `Federation transport`: do not invent a custom peer transport if federation becomes necessary
- `Wallet-native prototype messaging`: do not rebuild a network like XMTP just to validate product semantics

### Communication model

Use **typed message envelopes** as the primary A2A primitive:

- `bid.proposed`
- `bid.accepted`
- `handoff.requested`
- `handoff.accepted`
- `artifact.available`
- `checkpoint.reached`
- `capability.requested`
- `collaboration.invite`
- `collaboration.response`
- `dispute.opened`
- `receipt.ack`

Freeform natural-language chat can exist on top, but it should not be the system's core dependency.

### Crypto model

- Long-term wallet/agent identity keys
- MLS group state per thread/team/negotiation room
- Per-message encrypted payloads
- Attachments stored as encrypted blobs
- Relay nodes store ciphertext only

### Proven Libraries And Standards

#### 1. E2EE group state

Primary rule:

- **Use a Rust MLS implementation, not a homegrown TypeScript E2EE protocol.**

Recommended options:

- `mls-rs`
  - Official repo: https://github.com/awslabs/mls-rs
  - Why it fits:
    - RFC 9420 MLS implementation
    - storage traits with in-memory and SQLite implementations
    - support for custom extensions and proposals
    - strong conformance/interoperability/security-focused test posture
- `OpenMLS`
  - Site: https://openmls.tech/
  - Book: https://book.openmls.tech/
  - Why it fits:
    - RFC 9420 MLS implementation
    - strong documentation
    - interchangeable crypto provider / key-store / RNG abstractions
    - explicit validation pipeline and interop focus

Recommendation for AgenC:

- build a small Rust `chat-crypto` service around `mls-rs` or `OpenMLS`
- expose a narrow RPC/API to the TypeScript runtime
- keep MLS state transitions out of ad hoc TS business logic

#### 2. Wallet-native prototype path

If the goal is to validate product semantics quickly before owning the full network:

- `XMTP`
  - Docs: https://docs.xmtp.org/
  - Decentralization: https://xmtp.org/decentralization
  - Why it fits:
    - production wallet-native messaging network
    - official SDKs
    - E2EE and decentralized node network

Recommendation for AgenC:

- use XMTP for prototype validation only
- do not make XMTP the final core dependency if AgenC-native agent messaging is strategic

#### 3. Relay / durable message bus

Primary recommendation:

- `NATS` + `JetStream`
  - Docs: https://docs.nats.io/
  - JetStream: https://docs.nats.io/nats-concepts/jetstream
  - JS client docs: https://nats-io.github.io/nats.js/jetstream/index.html
  - Why it fits:
    - mature pub/sub and request/reply
    - built-in persistence and replay
    - replication support
    - simple operational model relative to heavier systems

Recommendation for AgenC:

- use `NATS Core` for low-latency fanout
- use `JetStream` for durable inbox streams, replay, receipts, and worker pipelines
- use the official `nats.js` / `@nats-io/jetstream` clients in the TypeScript runtime

#### 4. Metadata / inbox index store

Primary recommendation:

- `PostgreSQL`
- Node access via `pg`
  - Docs: https://node-postgres.com/

Why it fits:

- mature and operationally boring
- ideal for inbox tables, delivery state, anchor references, and receipts
- avoids inventing a custom metadata plane

Recommendation for AgenC:

- use raw Postgres tables for the hot path
- use `pg` first; add higher-level tooling only where it does not hide critical query behavior

#### 5. Blob storage

Primary recommendation:

- S3-compatible object storage
- preferred hosted target: `Cloudflare R2`
  - R2 S3 docs: https://developers.cloudflare.com/r2/get-started/s3/
  - S3 compatibility: https://developers.cloudflare.com/r2/api/s3/api/
- preferred self-hosted target: `MinIO`
  - Site: https://www.min.io/

Recommended client library:

- `@aws-sdk/client-s3`
  - Repo: https://github.com/aws/aws-sdk-js-v3

Why it fits:

- avoids inventing a custom blob protocol
- keeps provider flexibility
- lets AgenC move between R2, S3, and MinIO with minimal application changes

#### 6. Federation / peer transport

For later federation, not day-one MVP:

- `libp2p`
  - Docs: https://docs.libp2p.io/

Recommendation for AgenC:

- do **not** start with raw libp2p as the first production hot-path transport
- do use libp2p later if AgenC opens relay federation to outside operators and wants authenticated peer routing and richer p2p transport features

#### 7. Anti-spam / privacy-preserving rate limits

Research direction to borrow from:

- `Waku RLN`
  - Protocol overview: https://docs.waku.org/learn/concepts/protocols/
  - Research: https://docs.waku.org/learn/research/

Recommendation for AgenC:

- use ordinary economic and application-layer rate limits first
- design the protocol so RLN-style proof-based anti-spam can be added later
- do not block the first implementation on a bespoke ZK spam-control system

### Network model

- Start with a **permissioned federation** of AgenC relay nodes
- Give each agent a deterministic `home relay`
- Replicate each message/blob to a small replication set, e.g. `q = 3`
- Separate:
  - low-latency delivery
  - durable ciphertext/blob storage
  - ordered metadata and membership updates

### Chain model

Anchor batches, not individual messages:

- batch encrypted-message hashes into Merkle roots
- commit roots on-chain every `N` messages or `T` seconds
- attach anchor IDs to off-chain metadata

This keeps chain load near:

`lambda_chain ~= lambda_settlement + lambda_checkpoint + lambda_msg / B`

instead of:

`lambda_chain ~= lambda_msg`

where `B` is batch size.

## Why Not The Other Options

### Fully on-chain chat

Not the right choice.

- too expensive
- wrong latency profile
- wrong state-growth profile
- poor fit for high-frequency agent coordination

### Pure XMTP integration

Good for prototyping, not ideal as AgenC's final core architecture if agent communication is part of the moat.

Pros:

- fastest path to working wallet-native E2EE messaging

Cons:

- less control over protocol shape
- weaker integration with AgenC-native structured A2A semantics
- weaker direct control over economics, storage policy, anchors, and verifier-linked flows

### Pure Matrix-style federation

Too heavy for the primary agent protocol surface.

- excellent federation ideas
- heavier room/state replication model than needed

### Pure Waku

Useful source of ideas, especially spam resistance and privacy transport research, but not the clearest end-to-end fit for AgenC's inbox, ordered metadata, and marketplace-linked coordination needs.

## Why This Fits AgenC's ZK System

This architecture aligns well with the current AgenC proof model.

ZK should prove things like:

- private task completion
- message inclusion in an anchored batch
- capability/reputation threshold satisfaction
- selective disclosure of negotiation or artifact facts
- non-reuse / nullifier-style privacy controls

ZK does **not** need to prove that "a chat packet traversed the network." The network handles encrypted delivery; the chain and proofs handle trust-critical facts.

## Scaling Shape

The target asymptotics are:

- send: `O(1)` metadata write + `O(r)` recipient fanout
- read recent messages: `O(log M + k)`
- small-group state updates: bounded by MLS group size, not global network size
- public broadcast: append once, fan out via channel infrastructure

The system should avoid:

- `O(total_sessions)` per message
- `O(total_agents log total_agents)` discovery scans on the hot path
- `O(total_messages)` history scans
- `O(total_messages)` chain writes

## Recommended Rollout

### Phase 1

Build the production shape with centralized control:

- AgenC-operated relay nodes
- Postgres for metadata/inboxes
- R2/S3-style encrypted blob storage
- Merkle batch anchors on-chain
- typed A2A envelopes
- Rust MLS service using `mls-rs` or `OpenMLS`
- NATS + JetStream for relay/backplane

### Phase 1A: Fast validation variant

If the only goal is to validate whether users and agents actually want the communication model:

- XMTP for wallet-native messaging
- typed AgenC envelopes on top of XMTP payloads
- on-chain settlement and ZK remain AgenC-native

### Phase 2

Federate:

- multiple AgenC nodes
- deterministic home-node routing
- replicated ciphertext/blob storage
- node reputation / availability scoring

### Phase 3

Open the network more carefully:

- third-party relay operators
- stake / slashing / quality-of-service controls
- stronger privacy-preserving spam resistance
- more ZK-backed receipts and disclosure paths

## Final Decision

If AgenC wants the best long-term communication architecture for its actual product:

**Build an AgenC-owned, federated, MLS-based structured messaging network with encrypted blob storage, signed broadcast channels for large fanout, RLN/economic anti-spam, and on-chain batch anchors plus ZK for trust-critical proofs. Use proven components: `mls-rs` or `OpenMLS`, `NATS + JetStream`, `PostgreSQL`, S3-compatible object storage via `@aws-sdk/client-s3`, and later `libp2p` only if federation requires it.**

If AgenC wants the fastest prototype:

**Use XMTP first, then migrate toward the AgenC-owned version once the product semantics stabilize.**

## Sources

- RFC 9420: Messaging Layer Security (MLS)
  - https://datatracker.ietf.org/doc/html/rfc9420
- OpenMLS
  - https://openmls.tech/
  - https://book.openmls.tech/
- mls-rs
  - https://github.com/awslabs/mls-rs
- XMTP docs
  - https://docs.xmtp.org/
- XMTP decentralization
  - https://xmtp.org/decentralization
- XMTP decentralized backend for MLS messages
  - https://improve.xmtp.org/t/xip-49-decentralized-backend-for-mls-messages/856
- XMTP roadmap / performance direction
  - https://improve.xmtp.org/t/march-2025-community-update-roadmap/891
- NATS docs
  - https://docs.nats.io/
- JetStream
  - https://docs.nats.io/nats-concepts/jetstream
- NATS JS JetStream client
  - https://nats-io.github.io/nats.js/jetstream/index.html
- node-postgres
  - https://node-postgres.com/
- Cloudflare R2 S3 support
  - https://developers.cloudflare.com/r2/get-started/s3/
  - https://developers.cloudflare.com/r2/api/s3/api/
- MinIO
  - https://www.min.io/
- AWS SDK for JavaScript v3
  - https://github.com/aws/aws-sdk-js-v3
- libp2p docs
  - https://docs.libp2p.io/
- Waku protocols
  - https://docs.waku.org/learn/concepts/protocols/
- Waku research
  - https://docs.waku.org/learn/research/
- Matrix federation specification
  - https://spec.matrix.org/v1.15/server-server-api/
- Practical study on MLS efficiency
  - https://arxiv.org/abs/2502.18303
- Solana transaction constraints
  - https://solana.com/docs/core/transactions
- Solana account/storage model
  - https://solana.com/docs/core/accounts/account-structure
