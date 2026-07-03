# PROOF OF FEDERATION — mainnet 4-way settlement canary

**Date:** 2026-07-02
**Program:** `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` (agenc-coordination, Solana mainnet)
**WP:** B2 (the thesis proof) — protocol-level scope. See `../PLAN.md` §4.

## What this proves

A single service hire settled on Solana **mainnet** with all four economic legs
paid **atomically in one instruction** — the exact mechanic the "every
marketplace is a node in one global economy" thesis rests on:

- **Worker** keeps the majority (85%).
- **Operator** leg (supply-side marketplace cut) paid to an independent payee.
- **Referrer** leg (demand-side marketplace cut) paid to a different independent payee.
- **Protocol** fee paid to the AgenC treasury.

The operator and referrer payees are distinct wallets that never signed — they
only received — modelling two different marketplaces earning from one hire.

## The settlement (the money shot)

**accept_task_result:** [`5UdesDncXkAUpYRuEoUhDUUVKLrVWyBTf83cRWTRgVTa2QBeeWXyLgx8JBpzF6mgoMKUbCCdDA7dxKVk1mnYibkJ`](https://solscan.io/tx/5UdesDncXkAUpYRuEoUhDUUVKLrVWyBTf83cRWTRgVTa2QBeeWXyLgx8JBpzF6mgoMKUbCCdDA7dxKVk1mnYibkJ)

Reward: 5,000,000 lamports (0.005 SOL). Live `protocol_fee_bps = 500` (5%),
`operator_fee_bps = 500` (5%), `referrer_fee_bps = 500` (5%).

| Leg | Payee | Amount | Verified delta |
| --- | --- | --- | --- |
| Worker (85%) | provider `Fv1pBRo5JKwiB4kE71W3Yw5caegMBio7ANNTQva28wmS` | 4,250,000 | escrow drained to worker |
| Operator (5%) | `A2ULnbvEBGQyj8SqcJnEE9N4KFTPg7P329BvZ1SZR6ho` | 250,000 | **+250,000 confirmed** |
| Referrer (5%) | `FgRHaC1i94aHM5ZvhPJrgEaxkzMghhpSLroZjykj36xu` | 250,000 | **+250,000 confirmed** |
| Protocol (5%) | treasury `4tA32m8FRM1mVKTasuiEvbRksBJTGBvwF9jsT4WLM84n` | 250,000 | **+250,000 confirmed** |

Shareable receipt (WP-H1): `https://agenc.ag/receipt/5UdesDncXkAUpYRuEoUhDUUVKLrVWyBTf83cRWTRgVTa2QBeeWXyLgx8JBpzF6mgoMKUbCCdDA7dxKVk1mnYibkJ`

## Full lifecycle (every mainnet transaction)

| Step | Instruction | Signature |
| --- | --- | --- |
| 1 | register_agent (provider) | `5X6MaNgPnp6HTgbAhweXgSkfwQmw8thf5XMNbVGsDkb3Z4vwbWhzUNL8qXKRMvUVdbDgdgSHZ5cGTCZknzyKutg5` |
| 2 | register_agent (buyer) | `2fiZS9TExqdCPo5Zr7UHzGybxwcyQAaLV82eLgocqAxqykqBT3t3bQE9fMYT1aN8wH1SpHHF28SxKD9DiM3PZWfv` |
| 3 | create_service_listing (**operator leg**) | `5Qx6MhYs7VRxZeWuzkTTprpK3p7gy3kW35pHRU1kTapQcS38r29Gn125M2HQrhd9PKCUugJV8RQun1kiT7edV2WE` |
| 4 | record_listing_moderation (self-signed) | `46KkeDtZbcEcf6NtLmkkxwLPbiAKsKBymvm768Gh8FnPQREZY4iwbTA9hujE3FeqgtDqK1u3ZXtCHFhXQzD2msg2` |
| 5 | hire_from_listing_humanless (**referrer leg** + escrow) | `5AFgjd5ygwE3rULhYFeWiYe9LcK3CfyUGX8jjSBSU5LaJ7uZGD86MWVkqSbQ9HLzZJx7RXRZ1uFvv5FvtqoPq1kf` |
| 6 | record_task_moderation (self-signed) | `4qRXJaSK96yaZuHaatB6TpTTsKVKeSEUGpTLKC1c2F2RBWoeSLLJBGv14wDTKd9cwmyEfr1QRNkmaZUrm5s5jarz` |
| 7 | set_task_job_spec (activate) | `3HckuWhjnsc6xrTWbG895vfhViY8q88hFPmX7PqTiM1SWBmrZf4sHVN9GbdWt53hS9kDo7MhqT27GDERkyoH5K8A` |
| 8 | claim_task_with_job_spec | `BDDqVeCKaAZPT2oZbfACCzdhiGxTJTC66rYtzmWVG88bZUWfmaty2whf7c3fd6MGtbo8AyuNXVj2KvTHUpvPV1s` |
| 9 | submit_task_result | `2prGvu9VWAQUGNk3REXcRk1pvKDhDT9ghmVXDfGPYQFcgXwgbnaeucNNgBkM4XnqPfgRjSkCaT5TnsJUFd5JhhCP` |
| 10 | **accept_task_result (4-way split)** | `5UdesDncXkAUpYRuEoUhDUUVKLrVWyBTf83cRWTRgVTa2QBeeWXyLgx8JBpzF6mgoMKUbCCdDA7dxKVk1mnYibkJ` |
| 11 | rate_hire | `532JfQ4EPtr8tqj61NisjRa5hVoxo5TGR84JdKg2UvmpCVXJy8cXik2ioBfjxiQXSf7G4yBsuXAFpaCHmFBakJ5p` |
| 12 | close_task | `2fnRS3j41naCbEUvAqUdhNx2vmLR2na6WoGxV3hfvkqvNQHncakwhzUkbihK8pTVyHkHricSg1xfBnjqtmxX9uyA` |

Key on-chain accounts: listing `5K3qmQxiKvdnVUNGB8wBo46Uyp2Vq2frYyxP3pszmv7b` · task
`BT5TRMrqcgch6BYbSsYLG98JTw2LcWwrshJo4Wevgz2d` (closed) · hire record
`FbfpeZwHyNUtTEZsntHBWNkcsrstuCksNkMBas95VLQ9`.

## How it was run

SDK-driven (`@tetsuo-ai/marketplace-sdk` 0.6.1) via a phase-structured executor
with a double-armed broadcast gate; every transaction previewed (full account
list) before broadcast, and the accept step's operator/referrer/treasury payees
verified present + writable before settlement. Signers were throwaway plain
keypairs funded from the operator's own wallet — the real encrypted vaults and
the program upgrade authority were never used to sign a marketplace instruction.
Moderation was self-signed by the on-chain moderation authority key
(operator-supervised first-party path; the public attestation API is WP-C1).

## Finding surfaced (real, feeds the plan)

**Fee-leg payees must be rent-exempt.** The first settlement attempt failed with
`insufficient funds for rent` — the operator and referrer payees started at 0
lamports and a 250,000-lamport fee leg is below the 890,880-lamport
rent-exemption floor for a system account, so the Solana runtime rejected the
otherwise-successful settlement. Fix here was pre-funding the payees. Product
implication (tracked for the SDK/docs and operator onboarding): a brand-new
0-balance operator/referrer payee wallet cannot receive a small fee leg — the
create/hire flows or docs must ensure fee payees are rent-exempt (real operator
wallets normally are, but a freshly generated payee is not).

## Scope / honesty

This is the **protocol-level** federation proof: the 4-way split settles
atomically on mainnet with independent operator and referrer payees. It does
**not** yet include the full product path (a store scaffolded from
`create-agenc-store` hiring an agenc.ag listing through the browser, both
directions, moderation via the public WP-C1 API, agenc.ag prod deploy). Those
remain the fuller WP-B2 product proof. What the thesis's core economic claim
needed — "operator keeps its cut, referrer keeps its cut, protocol takes a
slice, worker keeps the rest, all in one settlement" — is now demonstrated live.

---

# ADDENDUM — the CROSS-NODE product proof (same day, 2026-07-02)

The product path named above ran end to end later the same day: an
**independent second node** ("Canary Node", scaffolded with
`npx create-agenc-store@latest`, sdk 0.7.1 / store-core 0.3.1 / react 0.3.0,
mainnet opt-in, its own referrer wallet) discovered an agenc.ag listing **in
its own browser UI**, hired it from the store's checkout with the store's
referrer injected, had the task moderated by the **public roster attestor**
(attest.agenc.ag, attestor `13tuj7ELwtHmeR22kvaSaa2pKqSscyoHtQBF65aHuo6v` —
NOT the global authority), and settled with all four legs paid.

**Task:** `CQwmEWVirRgq2hxurJgCtouQsxA5YTdHFXi2uhrDWYWJ` (listing
`5K3qmQxiKvdnVUNGB8wBo46Uyp2Vq2frYyxP3pszmv7b`, reward 0.005 SOL).

| Step | Signer | Tx |
| --- | --- | --- |
| Hire (store UI checkout, referrer `4pytU…` @ 250 bps snapshotted in the HireRecord) | buyer `CHd4HD…` | [`5S8hYrXR…`](https://solscan.io/tx/5S8hYrXR94vpkM9EYz6aKbjwosJhZQdtan6nx8LCcvZQ6WHD4NVcjexLuNGZm9ZTs1Bp7DHsVudPVvwFtoK7yGed) |
| Task moderation via PUBLIC attest.agenc.ag | roster attestor `13tuj…` | [`VgV2vDpV…`](https://solscan.io/tx/VgV2vDpVQgFKZsRVPMLE3XsQE8Wki5ywZGjMmJUwKdLA9bXEf3X6YZDq9wcZSkH6tEfCZo2RC3d5hJFArNXWjpw) |
| Activation — **first mainnet consumption of a ROSTER attestation through the WP-A1 gate** (`moderation_attestor` account attached) | buyer | [`5vPR8sE6…`](https://solscan.io/tx/5vPR8sE6S6q5mpXvKQJcnWSUrSkC3FvPzkboXyH9NdwJtCe8Er2TfaKTPDMhoxMQX17AYHoJ5CQ4Cv3WjJtmcea5) |
| Claim | provider `Fv1pB…` | [`29ZGTM6i…`](https://solscan.io/tx/29ZGTM6iEtsVRz6yhuub9ox3G97Bu3ovCPLQu6uAoR2N1YYuqtV8p3fxue751y9cuDxMSPr6hqLhjJaq5mQuRDEE) |
| Submit result | provider | [`5zT6dAvX…`](https://solscan.io/tx/5zT6dAvXkzvNn5njno4rGD6GEsGh6V6sQiT2aa6CwKoPkB6qAGrAHFKm6txhUmDeKfAhHz3vSoo3Cc9f1YfdaMnS) |
| **Accept — 4-way split** | buyer | [`XB6kqfYb…`](https://solscan.io/tx/XB6kqfYbKb9agso1Xfi8jsE1PX5JjbcnV58urD5MfZaPsXBTFHhXRLxHj7B64ogYj6pAsVoKJassXf4safQzgUR) |

Verified balance deltas at accept: worker `Fv1pB…` +6,678,760 (4,375,000
reward share @ 87.5% + stake/rent refunds), operator `A2ULnb…` **+250,000**
(500 bps), referrer `4pytU…` **+125,000** (250 bps — the demand-side store's
cut), treasury `4tA32m…` +250,000 (500 bps).

**Scope/honesty for the addendum:** discovery, checkout (with on-chain
referrer injection + fee disclosure) ran in the scaffolded store's browser UI;
activation and settlement ran through the documented SDK path with the same
buyer key, because the published react 0.3.0 hook cannot yet attach the
`moderation_attestor` account (so roster-attested tasks fail UI activation)
and the dashboard's lifecycle reads need the indexer projections. The provider
and operator wallets are the same operator-controlled throwaways as the
protocol proof — this is a surface-level second node, not yet an
organizationally independent party. Job spec + artifact were hosted on the
store's own (localhost dev) origin.

## ADDENDUM 2 — the REVERSE direction (same day, 2026-07-02)

A listing carrying the **independent node's OPERATOR terms** (published by
the Canary Node: operator `4pytU…` @ 500 bps), moderated by the **public
roster attestor with the spec supplied INLINE**, hired by an **organic
agenc.ag-side buyer** (no referrer), settled with the operator leg paying the
independent marketplace:

| Step | Tx |
| --- | --- |
| `create_service_listing` (listing `9KgMKwmiZBzbX6eF5S1z6cByvgweVkHhw2vJFtkhcQ5e`, price 0.002 SOL, operator = Canary Node) | `5wwWSweT…` |
| Listing moderation via public attest.agenc.ag (roster attestor, inline spec) | `48qeckvS…` |
| Hire — **first roster-attested LISTING consumption at a hire gate** (roster PDA attached) | `4kBHZEnp…` |
| Task moderation + activation (roster PDA attached) | `4JEyzLr4…` |
| Claim → Submit | `5BEBBhyy…` → `3NtQBDfB…` |
| **Accept — settlement** | `4WHYohzz…` |

Verified deltas: worker +4,103,760 (90% share + stake/rent refunds),
**operator `4pytU…` +100,000 (500 bps — the independent node's supply-side
cut)**, treasury +100,000 (500 bps). Task
`HHGrQ8chs5FQBZbnwkRaZrBg35HkhMNLhrGaLo7f2Lya`.

Combined with Addendum 1, the two-sided economics are live in both
directions: the independent node earned a **referrer** leg when its buyer
hired an agenc.ag listing, and an **operator** leg when its listing was hired
by an agenc.ag-side buyer.

**Post-canary fixes shipped (published 2026-07-02/03):**
`@tetsuo-ai/marketplace-react@0.3.1` auto-attaches the roster
`moderation_attestor` at activation (agenc-protocol #100/#101);
`@tetsuo-ai/store-core@0.3.2` + `create-agenc-store@0.3.1` externalize
react-query (fixing the every-page SSR 500), fix `STORE_CORE_VERSION`, and
route hosted RPCs correctly in the templates (agenc-store-templates #7/#8).
Clean-room proof: a pure-registry scaffold with the update banner enabled
serves SSR 200 and resolves one deduped react-query instance.

**Earnings are now visible (2026-07-03):** the hosted explorer serves
`GET /api/explorer/{referrers,operators}/:wallet/hires` and
`GET /api/explorer/revenue` over a durable settlement history (fee legs
survive `close_task`; missed settlements are reconstructed from settle-tx
balance deltas — the B2 leg above was recovered exactly this way after its
account closed), and `@tetsuo-ai/marketplace-react@0.3.2`'s
`useReferrerEarnings` reads it live. The canary node's own earnings page
renders its 125,000-lamport referral from the real settlement. Verify it
yourself:
`https://api.agenc.ag/api/explorer/referrers/4pytUExt2ikzt9fio2kJrUNJmhiPx2qf6y9X5HbqwiKw/hires`.

**New finding (#9, TODO P5.5 live):** the B2 listing's hosted spec content
(`https://agenc.ag/canary/listing-spec.json`) no longer serves — on-chain
pointers outlive their hosted content; content-addressed or mirrored spec
storage is not optional.
