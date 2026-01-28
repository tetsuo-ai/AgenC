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
