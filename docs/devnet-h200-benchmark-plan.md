# Devnet + H200 Benchmark Execution Plan

Last updated: 2026-03-15
Owner: Codex + user
Status: AgenC + protocol state deployed on devnet; replacement verifier stack deployed, wired, and trusted by the live devnet AgenC program
Primary goal: Run a real private-task end-to-end benchmark against Solana devnet using the remote `agenc-prover` service on a RunPod H200 host.

## Why this file exists

This is the working source of truth for the devnet + H200 benchmark effort.

It is meant to survive context compression. After each compression or session resume, use this file to answer:

- Where we are
- What has already been done
- What is blocked
- What still needs to be done next

## Current summary

The target architecture is still correct:

- Solana state and verification happen on devnet
- Proof generation happens remotely on the H200 prover host
- A benchmark runner coordinates both sides

The benchmark code path still supports this model:

- it creates and claims a private task on-chain
- it calls a remote prover endpoint
- it submits `completeTaskPrivate` back to chain
- it emits `latest.json` and `latest.md`

The previous verifier stack failure has been replaced on live devnet:

- a fresh trusted router program is deployed and finalized
- the fresh Groth16 verifier is deployed upgradeable with its `ProgramData` authority pinned to the router PDA
- the router PDA and trusted verifier entry PDA are now initialized on devnet
- `protocol_config` and `zk_config` remain valid under the same AgenC program ID

The remaining work is a fresh smoke E2E and benchmark pass against the new trusted stack plus final confirmation that the H200 prover build emits the expected trusted image ID.

## Latest validation snapshot

Validated directly against Solana devnet on 2026-03-15.

- Solana CLI present: `3.0.13`
- Anchor CLI present: `0.32.1`
- CLI wallet present: `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
- CLI wallet balance after AgenC upgrade: `12.279065071 SOL`
- Active AgenC program ID in repo config/runtime: `6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab`
- AgenC deploy signature: `2xXHZt7DQDEV6H5SkfJiAVdQewkA4g972XuUkGEG4n8BrN2c17Q1FtBZigBZqKF1LdX2xEixiF9FoZdyWGrDCYwN`
- AgenC upgrade signature after trusted verifier patch: `2GH3GLRAPuBmZw7t1R4vHrYm5JgybRxXnVbQHUf3si7yDaG6JtqM8RJgmbjoWzNaN5dgbeJCrGHZpUzGj7kJP4D4`
- AgenC `ProgramData` address: `AU5bNLVM8eJAaDNkbMa4yKmD7UVpy98V5ktFXP19p4e4`
- AgenC upgrade authority after deploy: `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
- AgenC last deployed slot after upgrade: `448688161`
- The deployable keypair in `target/deploy/agenc_coordination-keypair.json` resolves to `6Uc...`
- A second generated keypair at `programs/agenc-coordination/target/deploy/agenc_coordination-keypair.json` resolves to `9x1E...` and should not be used for future devnet deploys
- Router deploy signature: `4VkKLkzcsufc4QBbYtQenxd7DbsCCGwT11ESkGZzwBu1fPfC2KQ6CvKyvCkyKJ9Vu9UqdHZZX3xthw4SusHWjqBd`
- Router initialize signature: `2YYxsTPvGNqVysDRfXJREZWRah5ghcE13LZ874PYP5s4uJnYWY5B7sjrDaVSp7Cbh3HYx4gAq2kRJmdFM5xwR1ek`
- Router program ID exists on devnet: `E9ZiqfCdr6gGeB2UhBbkWnFP9vGnRYQwqnDsS1LM3NJZ`
- Verifier deploy signature: `3sX3aR3nb5s7PawriVJdv5tqxm8oiQBm1KX2UrT9fmN2gj2fP7LWs1CLSqu9QaD1FHsmFYfRLdyk5E5BVU7WJp7S`
- Verifier add signature: `KYkB96eSQr9UJ4gsCnkdCKKHUeRDyQrRgyGdcRx9xHa7xWqKCWJy7GcGZnMZh4i1MM5sfoSFLYGA9PW9KPYZF4y`
- Verifier program ID exists on devnet: `3ZrAHZKjk24AKgXFekpYeG7v3Rz7NucLXTB3zxGGTjsc`
- Derived router PDA: `78KWT482JZuETiufP7YHcPwhAwmVpi8q3W2ydRKuAR5m`
- Derived verifier entry PDA: `4VCaUJ8Lg9EXjxxB23NawfRgQ4oDhb1vMuwffvJvXCBM`
- Actual devnet result for both PDAs: `Exists and decodes correctly`
- Verifier `ProgramData` address exists: `JBdy2iomXXMnnfGsywqpLC937t6j2thGUsAScK6d37oB`
- Verifier `ProgramData` upgrade authority at validation time: `78KWT482JZuETiufP7YHcPwhAwmVpi8q3W2ydRKuAR5m`
- `protocol_config` PDA exists: `5AhrM23Cto9r4obGVxo8BkYERZWaQ867Kw8Czw2y9GQK`
- `protocol_config` bootstrap signature: `Jvsp5GSMC3uiBT4RnsGpWExh46UUggxoDcCh8N9FYD6Ez29JWFwFsEtpY9iZFL6iUQCjVeS3EYza7qZrU33sQwg`
- `protocol_config.authority`: `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
- `protocol_config.treasury`: `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
- `protocol_config.multisigThreshold`: `2`
- `protocol_config.multisigOwners`: `E9ws...`, `Dri1...`, `5aaM...`
- `zk_config` PDA exists: `iGP89zNzFpLYAyu12FR4nFj71PfRejVZ8k9NrVKqcvy`
- `zk_config` bootstrap signature: `55D5y89RbUFXGzAw1r4RjbZSyi5E5Ft41gxL73vsBypwy2fEqHru8z3opwaGMch2XQ6LAPpSRZUedyu3seMJANNM`
- `zk_config.activeImageIdHex`: do not assume a pinned value here; query live state before benchmarking
- Local TypeScript admin scripts now run from this checkout, but state-changing flows need an explicit remote devnet `wsEndpoint` when using the local HTTP proxy

## What is already done

- GitHub Pages benchmark site is enabled and working
- The live site is serving static benchmark artifacts
- The current live `latest.json` still shows `not-run`
- The benchmark flow has been analyzed end-to-end
- The remote prover integration path has been analyzed
- The verifier stack invariants required by the benchmark have been identified
- The key operational risks have been identified
- Local Solana and Anchor tooling have been verified
- The active Solana CLI wallet and devnet RPC have been verified
- Live devnet account inspection has been performed for AgenC, router, verifier, verifier PDAs, and verifier `ProgramData`

## Key decisions already made

- Do not use local validator for the public benchmark
- Use devnet for the real on-chain path
- Use the RunPod H200 host for real proof generation
- Treat deploy/bootstrap/setup as preconditions, not benchmark time
- Run a smoke E2E test first, then a benchmark run
- Track `proofGeneration`, `submitCompletion`, and `total` separately

## Architecture

### Devnet side

These components must be correct on devnet:

- AgenC coordination program
- Protocol state (`protocol_config`)
- ZK config (`zk_config`)
- Verifier router program
- Groth16 verifier program
- Router PDA
- Verifier entry PDA

### H200 side

These components must be correct on the RunPod H200 host:

- Linux `x86_64` host
- CUDA-capable environment suitable for the prover build
- `agenc-prover` service
- Auth configuration
- Timeouts, rate limits, and concurrency limits
- Stable endpoint reachable by the benchmark runner

### Runner side

The runner is responsible for:

- connecting to devnet RPC
- connecting to the remote prover endpoint
- creating and claiming private tasks
- requesting proofs from the H200 prover
- submitting `completeTaskPrivate`
- writing benchmark artifacts

## Hard blockers

Do not start the canonical benchmark if any of these are unresolved.

- Router PDA is missing
- Verifier entry PDA is missing
- Verifier `ProgramData` authority is not pinned to the router PDA
- Devnet `zk_config.activeImageId` does not match the image produced by the H200 prover build
- AgenC sends the wrong auth header for the prover service
- The H200 prover is not healthy or not stable enough for repeated rounds

## Known risks

- Auth mismatch:
  - AgenC benchmark can auto-add `x-api-key`
  - `agenc-prover` documents `Authorization: Bearer <token>` by default
  - We must standardize one working auth path before testing

- Trusted IDs are effectively fixed in runtime today:
  - router program ID
  - verifier program ID
  - if devnet uses different IDs, the private completion path will fail unless runtime is changed

- `total` time includes more than proving:
  - account funding
  - agent registration
  - task creation
  - claim
  - proving
  - private completion submit
  - use this for E2E visibility, but not as the only benchmark number

## Workstream 1: Devnet preparation

Status: Ready on devnet; only H200 image verification and the final private-task smoke run remain

### 1.1 AgenC deployment

- [x] Confirm the AgenC program deployment target configured in-repo for devnet
- [x] Confirm the program ID used by the runner matches the deployed program
- [x] Confirm the deploy wallet is known and available

Current state:

- Repo/runtime were rotated to `6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab`
- `6Uc...` is now deployed on devnet and owned by `BPFLoaderUpgradeab1e11111111111111111111111`
- Devnet `ProgramData` address is `AU5bNLVM8eJAaDNkbMa4yKmD7UVpy98V5ktFXP19p4e4`
- Upgrade authority is the active CLI wallet `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
- Latest successful AgenC upgrade signature is `2GH3GLRAPuBmZw7t1R4vHrYm5JgybRxXnVbQHUf3si7yDaG6JtqM8RJgmbjoWzNaN5dgbeJCrGHZpUzGj7kJP4D4`
- Latest successful AgenC upgrade slot is `448688161`
- Future deploys must use `target/deploy/agenc_coordination-keypair.json`
- Do not use `programs/agenc-coordination/target/deploy/agenc_coordination-keypair.json` for devnet deploys; it resolves to `9x1E...`

### 1.2 Verifier stack deployment

- [x] Confirm router program is deployed on devnet
- [x] Confirm Groth16 verifier program is deployed on devnet
- [x] Confirm router program ID matches the trusted runtime expectation
- [x] Confirm verifier program ID matches the trusted runtime expectation
- [x] Confirm router PDA exists
- [x] Confirm verifier entry PDA exists
- [x] Confirm verifier `ProgramData` authority is pinned to the router PDA
- [x] Confirm verifier entry layout matches the expected Groth16 entry

Current state:

- Router program exists and is executable
- Verifier program exists and is executable
- Derived router PDA `78KWT482JZuETiufP7YHcPwhAwmVpi8q3W2ydRKuAR5m` exists
- Derived verifier entry PDA `4VCaUJ8Lg9EXjxxB23NawfRgQ4oDhb1vMuwffvJvXCBM` exists
- Verifier `ProgramData` address `JBdy2iomXXMnnfGsywqpLC937t6j2thGUsAScK6d37oB` reports upgrade authority `78KWT482JZuETiufP7YHcPwhAwmVpi8q3W2ydRKuAR5m`

### 1.3 Protocol state

- [x] Confirm `protocol_config` exists
- [x] Confirm the signer used for admin actions matches `protocol_config.authority`
- [x] Confirm treasury state is valid
- [x] Prefund required admin and payer accounts

### 1.4 ZK configuration

- [x] Inspect current `zk_config`
- [x] Confirm `zk_config.activeImageId` exists and is 32 bytes
- [x] Confirm the current active image is the intended prover image
- [ ] Rotate `zk_config.activeImageId` if the H200 build uses a different image

Current state:

- `protocol_config` exists at `5AhrM23Cto9r4obGVxo8BkYERZWaQ867Kw8Czw2y9GQK`
- `protocol_config.authority` matches the active CLI wallet `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
- `protocol_config.treasury` is the same wallet and is system-owned
- Multisig is configured as `2-of-3`
- Multisig owners are `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`, `Dri1MQhxzgRyHeY3LoDkRsdeWeLJMWBPvdbLJBrEbRua`, and `5aaMQzfT6bzrPmPW67oqQmmcpj6bKLJaGFPkh9jzaNVg`
- Two local devnet signer keypairs were created and prefunded for multisig/admin use
- `zk_config` exists at `iGP89zNzFpLYAyu12FR4nFj71PfRejVZ8k9NrVKqcvy`
- `zk_config.activeImageId` is present and 32 bytes long
- Current `zk_config.activeImageIdHex` must be read from live state before comparing it to a prover build
- This matches the current in-repo reference image ID for the prover
- We still need to compare it against the actual H200 prover build output before the benchmark

### Evidence to save for Workstream 1

- [x] AgenC program ID
- [x] AgenC deploy signature
- [x] AgenC `ProgramData` address
- [x] Router program ID
- [x] Verifier program ID
- [x] Router PDA
- [x] Verifier entry PDA
- [x] `protocol_config` authority
- [x] `zk_config.activeImageIdHex`

## Workstream 2: H200 prover preparation

Status: Pending

### 2.1 Host readiness

- [ ] Confirm the RunPod machine is Linux `x86_64`
- [ ] Confirm H200 visibility from the OS
- [ ] Confirm CUDA driver and toolkit health
- [ ] Confirm the host is suitable for real proving

### 2.2 Prover build and runtime

- [ ] Build the intended `agenc-prover` variant for the H200 host
- [ ] Record the prover build version / commit
- [ ] Record the prover image ID returned by the running build
- [ ] Start the prover service with explicit auth
- [ ] Set request timeout
- [ ] Set in-flight concurrency cap
- [ ] Set rate limits
- [ ] Confirm `/healthz` and `/readyz` are green

### 2.3 Endpoint and auth

- [ ] Decide the canonical endpoint URL used by AgenC
- [ ] Decide the canonical auth scheme
- [ ] Confirm the benchmark runner can authenticate successfully
- [ ] Confirm the auth header strategy is documented

### 2.4 Isolated prover validation

- [ ] Run isolated `/prove` validation against the H200 host
- [ ] Run at least one single proof request successfully
- [ ] Run 3-trial isolated prover benchmark
- [ ] Record best, median, and worst proof latency

### Evidence to save for Workstream 2

- [ ] Host type
- [ ] GPU model
- [ ] CUDA health result
- [ ] Prover endpoint
- [ ] Auth scheme used
- [ ] Prover image ID
- [ ] Isolated prover timing summary

## Workstream 3: Runner configuration

Status: Pending

- [ ] Set devnet RPC URL
- [ ] Set wallet path for the benchmark runner
- [ ] Set prover endpoint
- [ ] Set prover timeout
- [ ] Set prover headers
- [ ] Confirm the runner is using the expected wallet and RPC
- [ ] Confirm the runner records only header names, not secret values, in the artifact

### Runner env contract

Expected runner inputs:

- `ANCHOR_PROVIDER_URL`
- `ANCHOR_WALLET`
- `AGENC_PROVER_ENDPOINT`
- `AGENC_PROVER_HEADERS_JSON` or equivalent working auth header config
- optional benchmark tuning values for rounds, reward, funding, and timeout

## Workstream 4: Full E2E smoke test

Status: Pending

Run one round only.

The smoke test succeeds only if the full chain completes:

- [ ] creator funding works
- [ ] worker funding works
- [ ] creator agent registration works
- [ ] worker agent registration works
- [ ] private task creation works
- [ ] private task claim works
- [ ] remote proof generation succeeds on the H200 endpoint
- [ ] `completeTaskPrivate` succeeds on devnet
- [ ] final task state is completed

### Evidence to save for Workstream 4

- [ ] `taskPda`
- [ ] `claimPda`
- [ ] creator and worker public keys
- [ ] tx signature for `completeTaskPrivate`
- [ ] proof `imageIdHex`
- [ ] smoke test timings

## Workstream 5: Canonical benchmark run

Status: Pending

Only start this after Workstream 4 passes.

- [ ] Decide number of rounds for the canonical run
- [ ] Exclude deploy/bootstrap/setup from benchmark timing interpretation
- [ ] Run 3 to 5 rounds minimum
- [ ] Consider discarding the first run if prover warm-up clearly skews latency
- [ ] Review `proofGeneration`
- [ ] Review `submitCompletion`
- [ ] Review `total`
- [ ] Record mean, median, min, and max

### Canonical benchmark acceptance criteria

- [ ] No bootstrap/setup was required during the benchmark run
- [ ] All rounds completed successfully
- [ ] No auth workaround changed mid-run
- [ ] `imageIdHex` matches the intended active image
- [ ] Artifact generation succeeded

## Workstream 6: Publish benchmark artifact

Status: Pending

- [ ] Verify the generated `latest.json`
- [ ] Verify the generated `latest.md`
- [ ] Confirm the artifact came from devnet + H200, not local or mock flow
- [ ] Publish the artifact to the benchmark page path
- [ ] Confirm the GitHub Pages site renders the new result

### Evidence to save for Workstream 6

- [ ] published `latest.json`
- [ ] published `latest.md`
- [ ] Git commit used for publication
- [ ] final public Pages URL

## Execution order

Use this exact order unless a blocker forces a reset.

1. Validate devnet deployment and state
2. Validate H200 prover host and service
3. Align `zk_config.activeImageId` with the H200 prover build
4. Configure the runner
5. Run one smoke E2E round
6. Fix blockers found by the smoke round
7. Run the canonical benchmark
8. Publish the artifact

## Progress log

### 2026-03-15

Completed:

- analyzed the current benchmark architecture
- confirmed the benchmark page is static and artifact-driven
- confirmed the benchmark flow already supports remote proving
- identified the verifier stack invariants required by the benchmark
- identified that devnet + H200 is the correct target architecture
- identified the auth mismatch risk between AgenC benchmark defaults and `agenc-prover`
- created this persistent execution plan
- verified local Solana CLI, Anchor CLI, wallet, RPC, and wallet balance
- verified that router and verifier trusted program IDs exist on devnet
- verified that the expected AgenC devnet program ID does not exist on the current devnet RPC
- verified that the current workspace does not have the private key needed to deploy to the expected AgenC program ID
- verified that the currently available local program keypair resolves to `6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab`
- derived the expected router PDA and verifier entry PDA and verified both are missing on devnet
- verified that the verifier `ProgramData` upgrade authority is `none`, not the router PDA expected by the benchmark
- installed the local TypeScript dependencies required for admin scripts
- prefunded two local devnet signer accounts for protocol administration
- verified that `protocol_config` exists and is controlled by `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
- recorded `protocol_config` bootstrap signature `Jvsp5GSMC3uiBT4RnsGpWExh46UUggxoDcCh8N9FYD6Ez29JWFwFsEtpY9iZFL6iUQCjVeS3EYza7qZrU33sQwg`
- verified that `protocol_config.treasury` is the same active CLI wallet
- verified that `protocol_config` multisig is `2-of-3`
- verified that `zk_config` exists and that its active image ID is present on-chain; re-read the exact value before running the benchmark
- recorded `zk_config` bootstrap signature `55D5y89RbUFXGzAw1r4RjbZSyi5E5Ft41gxL73vsBypwy2fEqHru8z3opwaGMch2XQ6LAPpSRZUedyu3seMJANNM`
- verified that admin state-changing calls need an explicit remote devnet websocket endpoint when using the local HTTP RPC proxy

Not done yet:

- fix the verifier stack state on devnet
- initialize the router PDA
- initialize the verifier entry PDA
- restore verifier `ProgramData` authority to the router PDA or redeploy that stack correctly
- H200 prover validation
- auth alignment
- smoke E2E test
- canonical benchmark run
- artifact publication

## Update rules

Whenever work progresses, update these sections in this order:

1. `Last updated`
2. `Current summary`
3. The relevant workstream status
4. Checkbox items completed in that workstream
5. `Hard blockers` if any new blocker appears
6. `Progress log`

Do not remove old blockers or old progress entries without replacing them with a clear resolution note.

If context gets compressed, resume from:

- `Current summary`
- `Hard blockers`
- the first incomplete workstream in `Execution order`
