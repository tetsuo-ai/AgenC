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
