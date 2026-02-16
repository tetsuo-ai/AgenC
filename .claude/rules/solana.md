# Solana Documentation for AgenC

Curated Solana references for this Anchor-based program with TypeScript SDK.

## Core Concepts

- [Core Concepts](https://solana.com/docs/en/core/): Accounts, transactions, programs, PDAs, CPIs, and tokens
- [Accounts](https://solana.com/docs/en/core/accounts): Account model, data storage, rent, ownership
- [Transactions](https://solana.com/docs/en/core/transactions): Transaction structure and instruction composition
- [Instructions](https://solana.com/docs/en/core/instructions): Instruction building blocks
- [Programs](https://solana.com/docs/en/core/programs): Program development with Rust/Anchor
- [Program-Derived Address](https://solana.com/docs/en/core/pda): PDA derivation, canonical bumps, creating PDA accounts
- [Cross Program Invocation](https://solana.com/docs/en/core/cpi): CPI, PDA signers, program composition
- [Transaction Fees](https://solana.com/docs/en/core/fees): Base fees, priority fees, compute units
- [Terminology](https://solana.com/docs/en/references/terminology): Essential Solana terminology

## Program Development

- [Rust Programs](https://solana.com/docs/en/programs/rust/): Developing Solana programs in Rust
- [Program Structure](https://solana.com/docs/en/programs/rust/program-structure): Entrypoints, state, instruction handling
- [Deploying Programs](https://solana.com/docs/en/programs/deploying): Building, deploying, managing programs
- [Program Limitations](https://solana.com/docs/en/programs/limitations): Runtime constraints
- [Program Examples](https://solana.com/docs/en/programs/examples): Reference implementations
- [Verifying Programs](https://solana.com/docs/en/programs/verified-builds): Verified builds for production

## Anchor Framework

- [Anchor CLI Basics](https://solana.com/docs/en/intro/installation/anchor-cli-basics): Common Anchor CLI commands
- [Deploy a Program](https://solana.com/docs/en/intro/quick-start/deploying-programs): Build, deploy, test with Anchor
- [Creating Deterministic Accounts](https://solana.com/docs/en/intro/quick-start/program-derived-address): CRUD with PDAs in Anchor
- [Composing Multiple Programs](https://solana.com/docs/en/intro/quick-start/cross-program-invocation): CPIs with Anchor
- [IDL Guide](https://solana.com/developers/guides/advanced/idls): IDLs as program interfaces

## Client SDKs

- [TypeScript SDK](https://solana.com/docs/en/clients/official/javascript): JavaScript/TypeScript client libraries
- [Rust SDK](https://solana.com/docs/en/clients/official/rust): Official Rust crates

## Development Setup

- [Quick Installation](https://solana.com/docs/en/intro/installation/): Rust, Solana CLI, Anchor setup
- [Install Dependencies](https://solana.com/docs/en/intro/installation/dependencies): Full dependency guide
- [Solana CLI Basics](https://solana.com/docs/en/intro/installation/solana-cli-basics): Common CLI commands
- [RPC Endpoints](https://solana.com/docs/en/references/clusters): Devnet, Testnet, Mainnet clusters

## Cookbook - Accounts

- [Calculate Account Creation Cost](https://solana.com/cookbook/accounts/calculate-rent): Rent calculation
- [Create an Account](https://solana.com/cookbook/accounts/create-account): Account creation
- [Get Account Balance](https://solana.com/cookbook/accounts/get-account-balance): Balance retrieval

## Cookbook - Development

- [Connecting to a Solana Environment](https://solana.com/cookbook/development/connect-environment): RPC connection
- [Getting Test SOL](https://solana.com/cookbook/development/test-sol): Devnet airdrops
- [Load a Keypair from File](https://solana.com/cookbook/development/load-keypair-from-file): Keypair loading

## Cookbook - Transactions

- [How to Send SOL](https://solana.com/cookbook/transactions/send-sol): SOL transfers
- [Add Priority Fees](https://solana.com/cookbook/transactions/add-priority-fees): Transaction prioritization
- [Calculate Transaction Cost](https://solana.com/cookbook/transactions/calculate-cost): Cost estimation
- [Optimize Compute](https://solana.com/cookbook/transactions/optimize-compute): Compute optimization

## Cookbook - Wallets

- [Create a Keypair](https://solana.com/cookbook/wallets/create-keypair): Keypair generation
- [Validate a Public Key](https://solana.com/cookbook/wallets/check-publickey): Public key validation

## Essential RPC Methods

### HTTP

- [getAccountInfo](https://solana.com/docs/en/rpc/http/getaccountinfo): Fetch account data
- [getBalance](https://solana.com/docs/en/rpc/http/getbalance): Get SOL balance
- [getProgramAccounts](https://solana.com/docs/en/rpc/http/getprogramaccounts): Query program accounts
- [getLatestBlockhash](https://solana.com/docs/en/rpc/http/getlatestblockhash): Get recent blockhash
- [getMinimumBalanceForRentExemption](https://solana.com/docs/en/rpc/http/getminimumbalanceforrentexemption): Rent calculation
- [sendTransaction](https://solana.com/docs/en/rpc/http/sendtransaction): Submit transaction
- [simulateTransaction](https://solana.com/docs/en/rpc/http/simulatetransaction): Test transaction
- [getSignatureStatuses](https://solana.com/docs/en/rpc/http/getsignaturestatuses): Confirmation status
- [requestAirdrop](https://solana.com/docs/en/rpc/http/requestairdrop): Devnet airdrop

### WebSocket

- [accountSubscribe](https://solana.com/docs/en/rpc/websocket/accountsubscribe): Account change subscription
- [programSubscribe](https://solana.com/docs/en/rpc/websocket/programsubscribe): Program account subscription
- [logsSubscribe](https://solana.com/docs/en/rpc/websocket/logssubscribe): Transaction log subscription

## Advanced Guides

- [How to Optimize Compute Usage](https://solana.com/developers/guides/advanced/how-to-optimize-compute): Program compute optimization
- [Confirmation & Expiration](https://solana.com/developers/guides/advanced/confirmation): Transaction confirmation
- [Retrying Transactions](https://solana.com/developers/guides/advanced/retry): Retry logic
- [Versioned Transactions](https://solana.com/developers/guides/advanced/versions): V0 transactions, lookup tables
- [Address Lookup Tables](https://solana.com/developers/guides/advanced/lookup-tables): Efficient address handling
- [Storing SOL in a PDA](https://solana.com/developers/guides/games/store-sol-in-pda): PDA escrow pattern

## Support

- [StackExchange](https://solana.stackexchange.com): Community support
