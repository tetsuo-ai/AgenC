# Devnet Program Data

Last updated: 2026-03-15
Branch target: `devnet-data-program`

This file is the compact source of truth for the current AgenC devnet deployment
and the replacement verifier stack.

It contains only public on-chain metadata plus local keypair file locations.
Secret key material stays outside the repo.

## Local keypair locations

These files exist only on the local machine and are not meant to be committed.

- CLI wallet: `/Users/pchmirenko/.config/solana/id.json`
- Router program keypair: `/Users/pchmirenko/.config/solana/agenc-devnet-router-v2.json`
- Verifier program keypair: `/Users/pchmirenko/.config/solana/agenc-devnet-groth16-verifier-v2.json`
- Devnet multisig signer 2: `/Users/pchmirenko/.config/solana/agenc-devnet-second-signer.json`
- Devnet multisig signer 3: `/Users/pchmirenko/.config/solana/agenc-devnet-third-signer.json`

## Wallets and operators

- Primary deploy / upgrade authority wallet: `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
- Multisig signer 2: `Dri1MQhxzgRyHeY3LoDkRsdeWeLJMWBPvdbLJBrEbRua`
- Multisig signer 3: `5aaMQzfT6bzrPmPW67oqQmmcpj6bKLJaGFPkh9jzaNVg`

## AgenC program

- Program ID: `6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab`
- ProgramData: `AU5bNLVM8eJAaDNkbMa4yKmD7UVpy98V5ktFXP19p4e4`
- Upgrade authority: `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
- Original deploy signature in this devnet cycle: `2xXHZt7DQDEV6H5SkfJiAVdQewkA4g972XuUkGEG4n8BrN2c17Q1FtBZigBZqKF1LdX2xEixiF9FoZdyWGrDCYwN`
- Latest upgrade signature after trusted verifier patch: `2GH3GLRAPuBmZw7t1R4vHrYm5JgybRxXnVbQHUf3si7yDaG6JtqM8RJgmbjoWzNaN5dgbeJCrGHZpUzGj7kJP4D4`
- Latest deployed slot after upgrade: `448688161`

## Replacement verifier stack

### Router

- Program ID: `E9ZiqfCdr6gGeB2UhBbkWnFP9vGnRYQwqnDsS1LM3NJZ`
- ProgramData: `8WbUQjJoCJnoGfXRUNMp65WVLwpeaB6HAHTWmT9kUij9`
- Authority: `none`
- Deploy signature: `4VkKLkzcsufc4QBbYtQenxd7DbsCCGwT11ESkGZzwBu1fPfC2KQ6CvKyvCkyKJ9Vu9UqdHZZX3xthw4SusHWjqBd`
- Initialize signature: `2YYxsTPvGNqVysDRfXJREZWRah5ghcE13LZ874PYP5s4uJnYWY5B7sjrDaVSp7Cbh3HYx4gAq2kRJmdFM5xwR1ek`
- Router PDA: `78KWT482JZuETiufP7YHcPwhAwmVpi8q3W2ydRKuAR5m`
- Router owner field after decode: `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`

### Groth16 verifier

- Program ID: `3ZrAHZKjk24AKgXFekpYeG7v3Rz7NucLXTB3zxGGTjsc`
- ProgramData: `JBdy2iomXXMnnfGsywqpLC937t6j2thGUsAScK6d37oB`
- Upgrade authority: `78KWT482JZuETiufP7YHcPwhAwmVpi8q3W2ydRKuAR5m`
- Deploy signature: `3sX3aR3nb5s7PawriVJdv5tqxm8oiQBm1KX2UrT9fmN2gj2fP7LWs1CLSqu9QaD1FHsmFYfRLdyk5E5BVU7WJp7S`
- Add verifier signature: `KYkB96eSQr9UJ4gsCnkdCKKHUeRDyQrRgyGdcRx9xHa7xWqKCWJy7GcGZnMZh4i1MM5sfoSFLYGA9PW9KPYZF4y`
- Verifier entry PDA: `4VCaUJ8Lg9EXjxxB23NawfRgQ4oDhb1vMuwffvJvXCBM`
- Selector bytes: `RZVM`
- Selector hex: `525a564d`
- `estopped`: `false`

## Protocol state

- `protocol_config` PDA: `5AhrM23Cto9r4obGVxo8BkYERZWaQ867Kw8Czw2y9GQK`
- `protocol_config` bootstrap signature: `Jvsp5GSMC3uiBT4RnsGpWExh46UUggxoDcCh8N9FYD6Ez29JWFwFsEtpY9iZFL6iUQCjVeS3EYza7qZrU33sQwg`
- `protocol_config.authority`: `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
- `protocol_config.treasury`: `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
- Multisig threshold: `2`
- Multisig owners:
  - `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
  - `Dri1MQhxzgRyHeY3LoDkRsdeWeLJMWBPvdbLJBrEbRua`
  - `5aaMQzfT6bzrPmPW67oqQmmcpj6bKLJaGFPkh9jzaNVg`

## ZK config

- `zk_config` PDA: `iGP89zNzFpLYAyu12FR4nFj71PfRejVZ8k9NrVKqcvy`
- `zk_config` bootstrap signature: `55D5y89RbUFXGzAw1r4RjbZSyi5E5Ft41gxL73vsBypwy2fEqHru8z3opwaGMch2XQ6LAPpSRZUedyu3seMJANNM`
- Active image ID hex: query live state before use with `npm run zk:config --workspace=@tetsuo-ai/zk-admin-tools -- show --rpc-url <devnet-url>`

## Runtime-trusted IDs now wired in repo

- Trusted AgenC program ID: `6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab`
- Trusted verifier router ID: `E9ZiqfCdr6gGeB2UhBbkWnFP9vGnRYQwqnDsS1LM3NJZ`
- Trusted RISC0 verifier ID: `3ZrAHZKjk24AKgXFekpYeG7v3Rz7NucLXTB3zxGGTjsc`

## Notes

- The old broken verifier stack is no longer trusted anywhere in the repo.
- `protocol_config` and `zk_config` were preserved because the AgenC program ID
  did not change.
- If this branch is used for a final PR, keep this file as the operator-facing
  deployment snapshot and keep keypairs out of git.
