\# Deployment Plan



\## Program ID

5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7

text## Upgrade Authority Strategy



| Option | Description                              | Recommendation                          |

|--------|------------------------------------------|-----------------------------------------|

| A      | Single keypair authority                 | Simple but centralized risk             |

| B      | Multisig (e.g., Squads or custom)        | \*\*Better for prod imo\*\*          |

| C      | Revoke authority (immutable program)     | Maximum security if no upgrades planned |



\*\*What I suggest\*\*: Option B (multisig) for production. Use a 3-of-5 or higher threshold multisig with team members.



\## Deployment Steps



\### Devnet

1\. `anchor build`

2\. `anchor deploy --provider.cluster devnet --program-id 5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7`

3\. Set upgrade authority if needed: `solana program set-upgrade-authority ...`



\### Mainnet-Beta

1\. Verify program with `anchor idl write-buffer` and `anchor deploy` dry-run

2\. `anchor build --verifiable` (optional for reproducibility)

3\. Deploy buffer: `solana program deploy --buffer <buffer-key> target/deploy/agenc\_coordination.so`

4\. Write buffer to program with upgrade authority

5\. Or use `anchor deploy --provider.cluster mainnet ...`

6\. Set multisig upgrade authority:

solana program set-upgrade-authority 5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7 --new-upgrade-authority <multisig-pubkey>

text7. (Optional) Revoke authority for immutability:

solana program set-upgrade-authority 5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7 --final



\## Verification Steps

1\. `solana program show 5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7` → confirm owner and upgrade authority

2\. Run integration tests on cluster: `anchor test --skip-local-validator`

3\. Query protocol account to confirm initialization

4\. Verify on-chain IDL matches local



\## Rollback Procedure

\- If upgrade authority is retained (single or multisig), deploy a previous verified buffer/version.

\- If immutable, rollback requires a new program ID and migration plan (not recommended for prod).

