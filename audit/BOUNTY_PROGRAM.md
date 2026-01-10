# AgenC Coordination Protocol Bug Bounty Program

## 1. Program Overview

The AgenC Coordination Protocol is a decentralized multi-agent coordination layer built on Solana. It enables trustless task distribution, state synchronization, and resource allocation across edge computing agents.

**Key Features:**
- Agent registration with capability-based matching
- Task creation with SOL escrow for rewards
- Multi-worker collaborative task execution
- Dispute resolution via arbiter voting
- Multisig-gated protocol governance

**Program ID:** `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ`

**Source Repository:** [Insert repository URL]

**Documentation:**
- Technical specification: `docs/`
- Threat model: `docs/audit/THREAT_MODEL.md`
- Security audit report: `docs/SECURITY_AUDIT_MAINNET.md`

---

## 2. Scope

### 2.1 In Scope

| Component | Description | Priority |
|-----------|-------------|:--------:|
| Anchor Program | `programs/agenc-coordination/` | High |
| Instructions | All 13 instruction handlers in `src/instructions/` | High |
| State Accounts | All account structs in `src/state.rs` | High |
| PDA Derivations | All seed patterns and bump validation | High |
| CPI Calls | Token transfers, system program interactions | High |
| Access Control | Signer verification, authority checks | High |
| Arithmetic | Fee calculations, reward distribution | High |
| Protocol Invariants | 27 invariants defined in THREAT_MODEL.md | High |

### 2.2 Out of Scope (Initial Phase)

| Component | Reason |
|-----------|--------|
| Frontend/UI | Not part of on-chain security |
| Off-chain services | Indexers, APIs, monitoring |
| C Library (`src/communication/`) | Phase 2 of bounty program |
| Test files | Not deployed code |
| Documentation | Non-executable |
| Third-party dependencies | Report upstream |
| Deployment infrastructure | Separate security domain |

### 2.3 Phase 2 Scope (Future)

The C library at `src/communication/solana/` will be added to scope after the initial program stabilizes:
- `solana_comm.c` - Communication strategy
- `agenc_solana.c` - Agent integration
- `solana_rpc.c` - RPC client
- `solana_utils.c` - Utility functions

---

## 3. Severity Levels

### Critical

**Definition:** Direct loss of user funds, unauthorized withdrawal from escrow, complete protocol takeover, or permanent denial of service.

**Examples:**
- Drain escrow accounts without completing tasks
- Bypass multisig requirements for protocol changes
- Manipulate reward distribution to steal funds
- Infinite mint or creation of value
- Unauthorized authority transfer

**Reward Range:** $5,000 - $15,000

### High

**Definition:** Significant fund risk, stuck/locked funds, major protocol disruption, or bypass of critical security controls.

**Examples:**
- Lock funds permanently in escrow
- Bypass arbiter stake requirements
- Manipulate dispute voting outcomes
- Prevent task completion/cancellation
- Reputation manipulation enabling fraud

**Reward Range:** $2,000 - $5,000

### Medium

**Definition:** Limited value loss, griefing attacks, spam that degrades service, or edge case exploitation.

**Examples:**
- Minor fee calculation errors (< 1%)
- Spam task creation exhausting storage
- Grief attacks that waste gas but no fund loss
- State desynchronization without fund impact
- Deadline manipulation (limited impact)

**Reward Range:** $500 - $2,000

### Low

**Definition:** Best practice violations, gas optimization, code quality issues, or theoretical vulnerabilities with impractical exploitation.

**Examples:**
- Suboptimal account space allocation
- Missing event emissions
- Redundant checks
- Documentation inconsistencies
- Edge cases with no practical impact

**Reward Range:** $100 - $500

---

## 4. Rewards

| Severity | Minimum | Maximum | Typical |
|----------|---------|---------|---------|
| Critical | $5,000 | $15,000 | $10,000 |
| High | $2,000 | $5,000 | $3,000 |
| Medium | $500 | $2,000 | $1,000 |
| Low | $100 | $500 | $250 |

**Bonus Multipliers:**
- First critical bug found: 1.5x
- High-quality PoC with fix recommendation: 1.25x
- Discovery of novel attack vector: 1.25x

**Payment:**
- Paid in USDC on Solana within 14 days of fix verification
- Alternative: SOL at market rate if preferred

**Note:** Rewards are at the sole discretion of the AgenC team based on impact, quality of report, and exploitability.

---

## 5. Submission Process

### 5.1 Submission Platform

**Primary:** Immunefi (preferred)
- URL: [Insert Immunefi program URL]

**Alternative:** Direct email
- Email: security@[domain].com
- PGP Key: [Insert public key fingerprint]

### 5.2 Required Information

Every submission must include:

1. **Title:** Clear, descriptive summary of the vulnerability

2. **Severity Assessment:** Your assessment with justification

3. **Affected Component:**
   - File path and line numbers
   - Instruction name(s)
   - Account type(s)

4. **Description:**
   - Detailed explanation of the vulnerability
   - Root cause analysis
   - Attack prerequisites

5. **Impact:**
   - What can an attacker achieve?
   - Estimated maximum loss
   - Who is affected (users, protocol, specific roles)?

6. **Proof of Concept:**
   - Step-by-step reproduction
   - Test code (preferred: Anchor test in TypeScript)
   - Transaction simulation or devnet demonstration

7. **Recommended Fix:** (optional but valued)
   - Suggested code changes
   - Alternative mitigations

### 5.3 Response SLA

| Stage | Target Time |
|-------|-------------|
| Acknowledgment | 24 hours |
| Initial Assessment | 72 hours |
| Severity Confirmation | 7 days |
| Fix Development | 14 days (Critical), 30 days (High/Medium) |
| Reward Payment | 14 days after fix verification |

---

## 6. Rules

### 6.1 Eligibility

- Must be the first reporter of the vulnerability
- Must not be a current or former team member (within 6 months)
- Must not have received non-public information about the vulnerability
- Must comply with all program rules

### 6.2 Responsible Disclosure

- **No public disclosure** until fix is deployed and verified
- Minimum 90 days embargo or until fix is live (whichever is shorter)
- Coordinated disclosure available after fix
- Credit given in security advisory (optional, by request)

### 6.3 Testing Guidelines

**Allowed:**
- Local validator testing
- Devnet testing on your own accounts
- Static code analysis
- Formal verification

**Not Allowed:**
- Mainnet exploitation
- Testing on accounts you do not own
- Social engineering of team members
- Physical attacks
- Denial of service attacks

### 6.4 Validity Requirements

To be considered valid, a vulnerability must:
- Be reproducible
- Be exploitable (not just theoretical)
- Affect in-scope components
- Not require social engineering
- Not require physical access
- Not be a known issue (check KNOWN_ISSUES.md)

### 6.5 Exclusions

The following are NOT eligible for rewards:
- Issues already reported by another researcher
- Issues in out-of-scope components
- Best practices without security impact
- Issues requiring compromised private keys
- Issues in dependencies (report upstream)
- Compiler/runtime bugs (report to Solana)
- Gas optimization without security impact

### 6.6 Disputes

If you disagree with severity assessment or reward:
1. Reply to the assessment within 7 days
2. Provide additional evidence or clarification
3. Final decision rests with AgenC security team

---

## 7. Launch Timeline

### Pre-Launch Checklist

- [ ] External security audit complete
- [ ] All Critical findings from audit fixed
- [ ] All High findings from audit fixed or mitigated
- [ ] Internal review complete (see INTERNAL_REVIEW.md)
- [ ] Fuzz testing complete (issue #39)
- [ ] Program deployed to mainnet
- [ ] Immunefi program page created
- [ ] Security contact email configured
- [ ] Response team assigned

### Launch Phases

| Phase | Scope | Reward Pool | Duration |
|-------|-------|-------------|----------|
| Private | Invited researchers only | $25,000 | 2 weeks |
| Limited | Application required | $50,000 | 4 weeks |
| Public | Open to all | Ongoing | Indefinite |

### Target Dates

| Milestone | Target Date |
|-----------|-------------|
| External audit complete | [TBD] |
| Critical/High fixes deployed | [TBD] |
| Private bounty launch | [TBD] |
| Public bounty launch | [TBD] |

---

## 8. Safe Harbor

AgenC commits to:
- Not pursue legal action against researchers acting in good faith
- Work with researchers to understand and resolve issues
- Provide fair compensation for valid findings
- Credit researchers (if desired) in security advisories

Researchers must:
- Act in good faith
- Avoid privacy violations
- Not access data beyond what is necessary
- Not disrupt services
- Follow responsible disclosure

---

## 9. Contact

**Security Team:** security@[domain].com

**PGP Key:**
```
[Insert PGP public key]
```

**Immunefi:** [Insert program URL]

**Response Hours:** Monday-Friday, 9am-6pm UTC

**Emergency (Critical only):** [Insert emergency contact method]

---

## 10. Resources

### Documentation
- Threat Model: `docs/audit/THREAT_MODEL.md`
- Internal Review Checklist: `audit/INTERNAL_REVIEW.md`
- Mainnet Deployment: `docs/MAINNET_DEPLOYMENT.md`
- Security Audit RFP: `docs/SECURITY_AUDIT_MAINNET.md`

### Code References
- Program entry: `programs/agenc-coordination/src/lib.rs`
- State definitions: `programs/agenc-coordination/src/state.rs`
- Instructions: `programs/agenc-coordination/src/instructions/`
- Error codes: `programs/agenc-coordination/src/errors.rs`

### Testing
- Unit tests: `tests/test_1.ts`
- Security tests: `tests/coordination-security.ts`
- Smoke tests: `tests/smoke.ts`

### External
- Anchor Framework: https://www.anchor-lang.com/
- Solana Security Best Practices: https://docs.solana.com/developing/programming-model/security
- Common Solana Vulnerabilities: https://github.com/coral-xyz/sealevel-attacks

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | [DATE] | Initial release |

---

*This bug bounty program is subject to change. Researchers will be notified of material changes via the submission platform.*
