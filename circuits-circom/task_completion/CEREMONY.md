# Trusted Setup Ceremony

## Current Status

**Environment:** Devnet/Localnet only
**Setup Type:** Single-party (development)
**Circuit Hash:**
```
2e5ddb5e ee875d59 3d3ca255 92ecd891
2b23b7dc 477192ec a59675da 3e1a602b
47475ee7 0fe575c2 86dadcdb 28a20da4
96ec68f6 86ad72b8 ff06eb14 e85146c7
```

## Mainnet Requirements

Before deploying to mainnet, a multi-party computation (MPC) ceremony with **minimum 3 independent contributors** is required.

### Why MPC Matters

Groth16 proofs require a trusted setup where "toxic waste" (random values) must be destroyed. If any single party retains this toxic waste, they could forge proofs. With MPC:

- Each contributor adds their own randomness
- Security holds as long as **at least one** contributor destroys their toxic waste
- More contributors = higher assurance

### Running a Mainnet Ceremony

#### Prerequisites

- 3+ independent contributors on separate, secure machines
- Each contributor installs snarkjs: `npm install -g snarkjs`
- Coordinator distributes the initial zkey file

#### Phase 1: Initial Setup (Coordinator)

```bash
cd circuits-circom/task_completion
npm run compile
snarkjs groth16 setup target/circuit.r1cs pot14_final.ptau target/circuit_0000.zkey
```

#### Phase 2: Contributions (Each Contributor)

Contributor 1:
```bash
snarkjs zkey contribute circuit_0000.zkey circuit_0001.zkey \
  --name="Contributor 1 - <name/org>" -v
# Record the contribution hash, then securely delete any local state
```

Contributor 2:
```bash
snarkjs zkey contribute circuit_0001.zkey circuit_0002.zkey \
  --name="Contributor 2 - <name/org>" -v
```

Contributor 3:
```bash
snarkjs zkey contribute circuit_0002.zkey circuit_0003.zkey \
  --name="Contributor 3 - <name/org>" -v
```

#### Phase 3: Random Beacon (Coordinator)

Apply a public random beacon for additional security (e.g., from drand.love):

```bash
# Get beacon from https://drand.cloudflare.com/public/latest
snarkjs zkey beacon circuit_0003.zkey circuit_final.zkey \
  <beacon_hash> 10 --name="Final Beacon"
```

#### Phase 4: Verification and Export

```bash
# Verify the final zkey
snarkjs zkey verify target/circuit.r1cs pot14_final.ptau circuit_final.zkey

# Export verification key
snarkjs zkey export verificationkey circuit_final.zkey verification_key.json

# Generate Rust code for on-chain verifier
node scripts/parse_vk_to_rust.js verification_key.json > verifying_key.rs

# Copy to Solana program
cp verifying_key.rs ../../programs/agenc-coordination/src/verifying_key.rs
```

### Contribution Transcript

Document each contribution with:

| Order | Contributor | Date | Contribution Hash |
|-------|-------------|------|-------------------|
| 0 | Initial setup | - | (from circuit hash) |
| 1 | Name/Org | YYYY-MM-DD | `<hash>` |
| 2 | Name/Org | YYYY-MM-DD | `<hash>` |
| 3 | Name/Org | YYYY-MM-DD | `<hash>` |
| Final | Random beacon | YYYY-MM-DD | `<beacon_hash>` |

### Security Checklist

- [ ] Minimum 3 independent contributors
- [ ] Contributors on separate, isolated machines
- [ ] Each contributor confirms toxic waste destruction
- [ ] Contribution hashes published and verified
- [ ] Random beacon applied from public source
- [ ] Final zkey verified against r1cs and ptau
- [ ] Transcript published for public audit

## Files

| File | Purpose | Sensitivity |
|------|---------|-------------|
| `pot14_final.ptau` | Powers of Tau (public) | Public |
| `circuit.zkey` | Proving key | Public (after ceremony) |
| `verification_key.json` | Verification key | Public |
| `verifying_key.rs` | On-chain verifier | Public |

## References

- [snarkjs documentation](https://github.com/iden3/snarkjs)
- [Hermez ceremony](https://blog.hermez.io/hermez-cryptographic-setup/)
- [Zcash Powers of Tau](https://zfnd.org/conclusion-of-the-powers-of-tau-ceremony/)
