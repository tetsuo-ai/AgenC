## Tech Debt Report - 2026-03-10

### Critical (Fix Now)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| None found in the remote-only prover cutover. | — | — | Keep the current repo state fail-closed. |

### High (Fix This Sprint)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| `bincode 1.3.3` is still reported as unmaintained by `cargo audit` through the current Anchor/Solana stack. | `programs/agenc-coordination/Cargo.lock` | `cargo audit` stays warning-yellow even though there are no RustSec vulnerabilities left. | Revisit when Anchor/Solana move off `bincode 1.x`, or explicitly track this upstream exception in security docs. |
| Runtime package install still reports npm ecosystem vulnerabilities during `npm install` / `sync:sdk`. | `runtime/package.json` transitive tree | JS supply-chain review is still incomplete even though Rust lockfiles are clean. | Run a focused `npm audit` remediation pass and upgrade/replace the affected runtime transitive packages. |

### Medium (Backlog)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Private-proof helper scripts now require external endpoint configuration but only support a single unauthenticated endpoint string. | `scripts/agenc-devnet-soak.mjs`, `scripts/agenc-localnet-soak-launch.sh`, `scripts/generate-real-proof.ts` | Operational ergonomics are rough and endpoint auth/header injection is not standardized. | Add a shared remote prover config loader with header/token support. |
| Empty directories and ignored build output may still exist locally after tracked prover files were removed. | `zkvm/host`, `zkvm/methods`, local `target/` trees | Can confuse future forensic reviews even though they are not tracked. | Remove leftover ignored directories in a local cleanup pass. |

### Duplications Found
| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| Remote prover endpoint wiring is repeated across helper scripts. | `scripts/agenc-devnet-soak.mjs`, `scripts/agenc-localnet-soak-launch.sh`, `scripts/generate-real-proof.ts` | Small repeated config blocks | Shared `loadRemoteProverConfig()` helper. |

### Summary
- Total issues: 4
- Estimated cleanup: 5 files
- Recommended priority: investigate the remaining runtime `npm audit` findings, because Rust lockfile vulnerabilities are now at zero.
