# AgenC Mainnet Deployment Checklist

## Critical: ZK Trusted Setup (Issue #334)

Before mainnet deployment, a proper MPC trusted setup ceremony is REQUIRED.

### Current State
- verifying_key.rs contains DEVELOPMENT keys only
- VK_GAMMA_G2 and VK_DELTA_G2 are identical (invalid for production)

### Required Actions
1. Conduct MPC ceremony with minimum 3 independent contributors
2. Apply random beacon from public source (e.g., drand)
3. Publish contribution transcript for audit
4. Regenerate verifying_key.rs from ceremony output
5. Verify gamma_g2 != delta_g2 in new key

### Verification
Run: `cargo test --package agenc-coordination verify_key_validity`
(Add this test to verify gamma != delta)

### References
- circuits-circom/task_completion/CEREMONY.md
- https://docs.circom.io/getting-started/proving-circuits/

---

## Pre-Deploy Gates (mandatory)

### Readiness check

**Prerequisites**
- [ ] `./scripts/check-deployment-readiness.sh` exists and is executable

**Steps**
1. Run:
   ```bash
   ./scripts/check-deployment-readiness.sh --network mainnet
   ```

**Expected Output**
```
All checks PASS
```

**Troubleshooting**
| Symptom | Cause | Fix |
|---------|-------|-----|
| script exits non-zero | missing env/toolchain/config | follow the script output and rerun |

### Test + mutation gates

**Prerequisites**
- [ ] Node toolchain installed
- [ ] Dependencies installed

**Steps**
1. LiteSVM fast integration suite:
   ```bash
   npm run test:fast
   ```
2. Runtime unit tests:
   ```bash
   cd runtime && npm run test
   ```
3. Runtime mutation gates:
   ```bash
   cd runtime && npm run mutation:ci && npm run mutation:gates
   ```

**Expected Output**
```
# all commands exit 0
```

**Troubleshooting**
| Symptom | Cause | Fix |
|---------|-------|-----|
| `npm run test:fast` fails | protocol regression | fix before deploy |
| mutation gate fails | behavior drift or insufficient coverage | inspect mutation artifact and remediate |

---

## Verifying key validation (mandatory)

**Prerequisites**
- [ ] `./scripts/validate-verifying-key.sh` exists and is executable

**Steps**
1. Run:
   ```bash
   ./scripts/validate-verifying-key.sh
   ```

**Expected Output**
```
# script exits 0 and prints PASS for production-safety checks
```

**Troubleshooting**
| Symptom | Cause | Fix |
|---------|-------|-----|
| gamma/delta equality check fails | dev VK in repo | complete MPC ceremony and regenerate verifying_key.rs |

---

## Build artifact verification (verifiable build)

**Prerequisites**
- [ ] Anchor toolchain installed (Anchor 0.32.1, Solana 3.0.13)
- [ ] solana-verify installed

**Steps**
1. Build verifiable program:
   ```bash
   anchor build --verifiable
   ```
2. Record executable hash:
   ```bash
   solana-verify get-executable-hash target/deploy/agenc_coordination.so
   ```

**Expected Output**
```
# solana-verify prints a hash (record it in the deployment log)
```

**Troubleshooting**
| Symptom | Cause | Fix |
|---------|-------|-----|
| build differs across machines | toolchain mismatch | align Anchor/Solana versions and rebuild |
